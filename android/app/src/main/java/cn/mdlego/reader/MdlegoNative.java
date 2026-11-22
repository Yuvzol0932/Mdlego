package cn.mdlego.reader;

import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.View;
import android.view.Window;

import androidx.activity.result.ActivityResult;
import androidx.annotation.RequiresApi;
import androidx.core.graphics.Insets;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 墨读原生桥。
 *
 * 只做五件事，刻意保持很小：
 *   1. 读取系统「打开 / 分享」投递进来的 content:// 文件
 *   2. 调起系统文件选择器（App 内主动导入的兜底路径）
 *   3. 报告原文件是否被外部改动（M6 回写前要用）
 *   4. 回写原文件（M6 用；此处先把能力备好）
 *   5. 受限的更新清单检查与外部浏览器跳转（仅允许 HTTPS 与白名单更新域名）
 *
 * 不申请任何存储或安装权限：文件全部走 SAF / ContentResolver，升级包跳转系统浏览器下载。
 */
@CapacitorPlugin(name = "MdlegoNative")
public class MdlegoNative extends Plugin {

    /** 单文件上限，与 Web 层 MAX_FILE_BYTES 保持一致。 */
    private static final int MAX_BYTES = 10 * 1024 * 1024;
    /** 检查更新请求的超时与响应上限（仅拉取小体积 JSON 清单）。 */
    private static final int UPDATE_TIMEOUT_MS = 5000;
    private static final int UPDATE_MAX_BYTES = 64 * 1024;
    private static final Set<String> ALLOWED_UPDATE_HOSTS = new HashSet<>(Arrays.asList(
            "gh-proxy.com",
            "fastly.jsdelivr.net",
            "cdn.jsdelivr.net",
            "gcore.jsdelivr.net",
            "ghfast.top",
            "api.github.com",
            "raw.githubusercontent.com"
    ));

    /**
     * 与 android.window.BackEvent.EDGE_* 同值（LEFT=0 / RIGHT=1 / NONE=2），
     * 但不引用 API 34 的类 —— 这些常量在 API 24 的类加载阶段就是安全的。
     * 只声明用得到的 NONE：SDK 33 降级路径没有坐标，边缘固定为「无」。
     */
    private static final int BACK_EDGE_NONE = 2;

    /** 启动 Intent 里待处理的 URI；JS 侧 ready 后主动来取。 */
    private final List<String> pendingUris = new ArrayList<>();

    /**
     * 已注册的预测式返回回调（Android 13+）。
     *
     * 存成 Object 而不是 OnBackInvokedCallback：字段类型在类加载时就要解析，
     * 而 OnBackInvokedCallback 是 API 33 才有的类，直接声明成该类型会让
     * API 24~32 的设备在加载本类时就风险性失败。存 Object，只在
     * @RequiresApi(33) 的方法里强转，低版本永远不会碰到它。
     */
    private Object backCallback;

    /** 上一次手势的坐标 / 边缘，commit 与 cancel 时复用（onBackInvoked 不再带坐标）。 */
    private volatile float backX;
    private volatile float backY;
    private volatile int backEdge = BACK_EDGE_NONE;
    /** 上一次派发的进度，用于去掉重复帧（手势停住时系统仍会持续回调）。 */
    private float lastDispatchedProgress = -1f;

    /**
     * 状态栏 / 导航栏的真实高度（dp）。
     *
     * Android 16 强制 edge-to-edge，而 CSS 的 env(safe-area-inset-top) 是 iOS
     * 特性，在 Android WebView 里恒为 0。必须由原生层把真实 inset 交给 Web 层。
     * load() 里取一次即可（横竖屏切换时高度不变）。
     */
    @Override
    public void load() {
        harvestIntent(getActivity().getIntent(), false);
        applySystemInsets();
    }

    /**
     * 读取 WindowInsets 并把安全区写进 WebView 的 CSS 变量。
     *
     * 只读不写：不改变 DecorView 的 fits 行为，避免牵动 WebView 自身布局。
     * Android 原生已经是 edge-to-edge，内容本就画到了状态栏后面，
     * 所以 Web 层自己按这个数值留白即可。
     */
    private void applySystemInsets() {
        if (getActivity() == null || getBridge() == null) return;

        android.view.View decor = getActivity().getWindow().getDecorView();
        decor.setOnApplyWindowInsetsListener((v, insets) -> {
            WindowInsetsCompat compat = WindowInsetsCompat.toWindowInsetsCompat(insets, v);
            Insets bars = compat.getInsets(WindowInsetsCompat.Type.systemBars());
            Insets safeHorizontal = compat.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            float density = v.getResources().getDisplayMetrics().density;
            int topDp = Math.round(bars.top / density);
            int bottomDp = Math.round(bars.bottom / density);
            int leftDp = Math.round(safeHorizontal.left / density);
            int rightDp = Math.round(safeHorizontal.right / density);
            // 固定字符串，只拼入数值，不执行任何外部输入
            String js = "document.documentElement.style.setProperty('--android-safe-top','"
                    + topDp + "px');"
                    + "document.documentElement.style.setProperty('--android-safe-bottom','"
                    + bottomDp + "px');"
                    + "document.documentElement.style.setProperty('--android-safe-left','"
                    + leftDp + "px');"
                    + "document.documentElement.style.setProperty('--android-safe-right','"
                    + rightDp + "px');";
            getBridge().eval(js, null);
            return insets;
        });
        decor.requestApplyInsets();
    }

    /**
     * Activity 销毁时注销预测式返回回调。
     *
     * 严禁在 onCreate / load 里永久注册：本回调只在 Web 层明确调用
     * setBackIntercept(true) 后才存在，这里负责在退出时清干净，
     * 否则回调对象连同 Activity 一起泄漏。
     */
    @Override
    protected void handleOnDestroy() {
        if (Build.VERSION.SDK_INT >= 33) {
            try {
                unregisterBackCallback();
            } catch (Throwable ignored) {
                // 已随窗口一起销毁，无需再处理
            }
        }
        super.handleOnDestroy();
    }

    /**
     * 从 Intent 里收集所有 content:// URI。
     *
     * 覆盖三种来源：
     *   ACTION_VIEW            文件管理器「用…打开」
     *   ACTION_SEND            分享单份
     *   ACTION_SEND_MULTIPLE   分享多份
     *
     * 同时尝试获取持久读权限，否则 Activity 重启后就读不到这个文件了。
     */
    private void harvestIntent(Intent intent, boolean replacing) {
        if (intent == null) return;
        if (replacing) pendingUris.clear();

        String action = intent.getAction();
        if (action == null) return;

        List<Uri> uris = new ArrayList<>();

        if (Intent.ACTION_VIEW.equals(action)) {
            Uri data = intent.getData();
            if (data != null) uris.add(data);
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri extra = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (extra != null) uris.add(extra);
            // 有些应用直接把文本塞在 EXTRA_TEXT 里，也一并记下来（用特殊前缀区分）
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (text != null && extra == null) {
                pendingUris.add("text:" + text);
            }
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }

        for (Uri uri : uris) {
            if (uri == null) continue;
            try {
                getContext().getContentResolver().takePersistableUriPermission(
                        uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                );
            } catch (Exception ignored) {
                // 部分 provider 不授予可持久化权限，仍可本次读取，不视为失败
            }
            String key = uri.toString();
            if (!pendingUris.contains(key)) pendingUris.add(key);
        }
    }

    /** 构造待处理 URI 数组（不清空）。 */
    private JSArray pendingUriArray() {
        JSArray arr = new JSArray();
        for (String s : pendingUris) arr.put(s);
        return arr;
    }

    /**
     * JS 侧调用：把状态栏 / 导航栏图标明暗跟着当前主题走（lookup #5）。
     *
     * 为什么由 Web 层决定而不是原生自己判：主题的唯一事实源在 Web（settings +
     * tokens.css），原生不知道用户选了「夜间」还是跟随系统。Web 侧在主题变化时
     * 传一个布尔值上来，原生只负责把系统栏图标刷成对应的明暗。
     *
     * 只改图标明暗（LIGHT_STATUS_BAR / LIGHT_NAVIGATION_BAR），不碰背景色 ——
     * 状态栏背景已经由 edge-to-edge 让 Web 内容画到屏幕顶部（见 applySystemInsets
     * 的说明），这里再画一层背景色反而会盖出第二条色带。
     */
    @PluginMethod
    public void setSystemBarsDark(PluginCall call) {
        Boolean dark = call.getBoolean("dark");
        if (getActivity() == null) {
            call.resolve(new JSObject());
            return;
        }
        final boolean useDarkIcons = dark != null && dark;
        getActivity().runOnUiThread(() -> {
            try {
                androidx.core.view.WindowCompat.getInsetsController(
                        getActivity().getWindow(),
                        getActivity().getWindow().getDecorView())
                    .setAppearanceLightStatusBars(useDarkIcons);
            } catch (Throwable error) {
                // 首次启动时窗口可能还没挂上；下一次主题变化会再调一次
            }
        });
        call.resolve(new JSObject());
    }

    /** JS 侧调用：查看待处理 URI，但不清空。
     *
     * 读取 content:// 可能因权限或 provider 时序失败。若「取出即清空」，
     * 一旦失败 URI 就永久丢失，用户再点「打开」也不会有任何反应。
     * 因此由 JS 侧在导入成功后显式调用 clearPendingUris 才清空。
     */
    @PluginMethod
    public void peekPendingUris(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("uris", pendingUriArray());
        call.resolve(ret);
    }

    /** JS 侧调用：导入成功后清空待处理 URI。 */
    @PluginMethod
    public void clearPendingUris(PluginCall call) {
        pendingUris.clear();
        call.resolve(new JSObject());
    }

    /** 兼容旧调用：取出并清空（M2 早期行为，保留以防回滚）。 */
    @PluginMethod
    public void takePendingUris(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("uris", pendingUriArray());
        pendingUris.clear();
        call.resolve(ret);
    }

    /** Activity 收到新的 Intent（singleTask 复用时由 MainActivity 调用）。 */
    public void onNewIntent(Intent intent) {
        harvestIntent(intent, false);
        notifyListeners("filesReceived", new JSObject());
    }

    /**
     * JS 侧调用：读取一个或多个 content:// URI，返回 base64 字节与元信息。
     * 参数：{ "uris": ["content://...", ...] }
     */
    @PluginMethod
    public void readDocuments(PluginCall call) {
        JSArray uriArray = call.getArray("uris");
        if (uriArray == null) {
            call.reject("缺少 uris 参数");
            return;
        }

        try {
            JSArray results = new JSArray();
            for (int i = 0; i < uriArray.length(); i++) {
                String raw = uriArray.getString(i);
                if (raw == null) continue;

                // EXTRA_TEXT 直接投递的纯文本，包装成虚拟文件
                if (raw.startsWith("text:")) {
                    JSObject o = new JSObject();
                    o.put("name", "分享内容.md");
                    o.put("uri", "");
                    o.put("size", raw.substring(5).getBytes("UTF-8").length);
                    o.put("mtimeMs", System.currentTimeMillis());
                    o.put("base64", Base64.encodeToString(
                            raw.substring(5).getBytes("UTF-8"), Base64.NO_WRAP));
                    o.put("textOnly", true);
                    results.put(o);
                    continue;
                }

                results.put(readOne(Uri.parse(raw)));
            }
            JSObject ret = new JSObject();
            ret.put("files", results);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("读取文件失败：" + e.getMessage(), e);
        }
    }

    /** 读取单个 URI。 */
    private JSObject readOne(Uri uri) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();

        String name = queryName(resolver, uri);
        long size = -1;
        long mtime = -1;

        try (Cursor c = resolver.query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int sizeIdx = c.getColumnIndex(OpenableColumns.SIZE);
                if (sizeIdx >= 0 && !c.isNull(sizeIdx)) size = c.getLong(sizeIdx);
            }
        } catch (Exception ignored) {
            // 某些 provider 不支持 SIZE 列
        }

        byte[] bytes;
        try (InputStream in = resolver.openInputStream(uri)) {
            if (in == null) throw new Exception("无法打开 content:// 流");
            bytes = readAllLimited(in);
        }

        if (size < 0) size = bytes.length;

        JSObject o = new JSObject();
        o.put("name", name);
        o.put("uri", uri.toString());
        o.put("size", size);
        o.put("mtimeMs", mtime);
        o.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
        o.put("textOnly", false);
        return o;
    }

    /** 带上限的读取，避免超大文件把内存打爆。 */
    private byte[] readAllLimited(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16 * 1024];
        int total = 0;
        int n;
        while ((n = in.read(buf)) != -1) {
            total += n;
            if (total > MAX_BYTES) throw new Exception("文件超过 10 MB 上限");
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    /** 从 provider 查询显示名。 */
    private String queryName(ContentResolver resolver, Uri uri) {
        try (Cursor c = resolver.query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0 && !c.isNull(idx)) return c.getString(idx);
            }
        } catch (Exception ignored) {
            // 落到默认名
        }
        String last = uri.getLastPathSegment();
        return last != null ? last : "导入文档.md";
    }

    /**
     * JS 侧调用：调起系统文件选择器（多选）。
     *
     * 用 Capacitor 的现代 ActivityCallback，而不是旧的 requestCode 方式：
     * 旧方式要求 @CapacitorPlugin(requestCodes = {...}) 声明过 code，
     * 否则 Bridge.getPluginWithRequestCode() 找不到插件，回调永不执行，
     * JS 的 Promise 就永远 pending —— 表现正是「选完文件卡死、毫无反应」。
     */
    @PluginMethod
    public void pickFiles(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                "text/markdown", "text/plain", "text/x-markdown",
                "application/octet-stream", "*/*"
        });
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);

        call.setKeepAlive(true);
        startActivityForResult(call, intent, "pickFilesResult");
    }

    /** 文件选择器结果回调（ActivityCallback 名称与上面一致）。 */
    @ActivityCallback
    private void pickFilesResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != android.app.Activity.RESULT_OK || data == null) {
            JSObject ret = new JSObject();
            ret.put("uris", new JSArray());
            ret.put("cancelled", true);
            call.resolve(ret);
            return;
        }

        List<String> uris = new ArrayList<>();
        Uri single = data.getData();
        if (single != null) {
            uris.add(single.toString());
        } else if (data.getClipData() != null) {
            android.content.ClipData clip = data.getClipData();
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null) uris.add(u.toString());
            }
        }

        for (String s : uris) {
            try {
                getContext().getContentResolver().takePersistableUriPermission(
                        Uri.parse(s),
                        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                );
            } catch (Exception ignored) {
                // 同 harvestIntent：不授予也能本次读取
            }
        }

        JSArray arr = new JSArray();
        for (String s : uris) arr.put(s);
        JSObject ret = new JSObject();
        ret.put("uris", arr);
        ret.put("cancelled", false);
        call.resolve(ret);
    }

    /**
     * JS 侧调用：检查原文件是否被外部改动。
     * M6 回写前用，避免覆盖掉用户在别处做的修改。
     */
    @PluginMethod
    public void statDocument(PluginCall call) {
        String raw = call.getString("uri");
        if (raw == null) {
            call.reject("缺少 uri");
            return;
        }
        try {
            Uri uri = Uri.parse(raw);
            ContentResolver resolver = getContext().getContentResolver();
            long size = -1;
            try (Cursor c = resolver.query(uri, null, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    int idx = c.getColumnIndex(OpenableColumns.SIZE);
                    if (idx >= 0 && !c.isNull(idx)) size = c.getLong(idx);
                }
            } catch (Exception ignored) {
                // provider 不支持
            }

            JSObject ret = new JSObject();
            ret.put("exists", true);
            ret.put("size", size);
            ret.put("readable", resolver.openInputStream(uri) != null);
            call.resolve(ret);
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("exists", false);
            ret.put("readable", false);
            call.resolve(ret);
        }
    }

    /**
     * JS 侧调用：把编辑后的文本写回原文件。
     * M6 使用；此处先把能力备好，但 Web 层 M2 不会调用。
     */
    @PluginMethod
    public void writeDocument(PluginCall call) {
        String raw = call.getString("uri");
        String b64 = call.getString("base64");
        if (raw == null || b64 == null) {
            call.reject("缺少 uri 或 base64");
            return;
        }
        try {
            byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
            Uri uri = Uri.parse(raw);
            try (java.io.OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                if (out == null) throw new Exception("provider 不允许写入");
                out.write(bytes);
            }
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("写入失败：" + e.getMessage(), e);
        }
    }

    // ------------------------------------------------------------------
    // 预测式返回（predictive back）
    // ------------------------------------------------------------------

    /**
     * JS 侧调用：开启 / 关闭预测式返回拦截。
     *
     * 参数：{ "enabled": true | false }
     *
     * 三条分叉，全部按运行期 SDK 判定（编译期 compileSdk 是 36，
     * 这些类都存在，但低版本运行时引用它们会 NoClassDefFoundError，
     * 所以真正触碰 API 33/34 类的那几行必须待在 @RequiresApi 方法里）：
     *
     *   SDK >= 34  OnBackAnimationCallback —— 能拿到逐帧进度，做跟手动画
     *   SDK == 33  普通 OnBackInvokedCallback —— 只有「已触发」这一个时机
     *   SDK < 33   什么都不注册，返回交给 Capacitor 的 backButton 监听（现状）
     *
     * 幂等：重复 enable 不会叠挂回调，重复 disable 不会抛异常。
     */
    @PluginMethod
    public void setBackIntercept(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");

        if (getActivity() == null) {
            call.resolve(new JSObject());
            return;
        }

        final boolean intercept = enabled != null && enabled;
        getActivity().runOnUiThread(() -> {
            try {
                if (intercept) {
                    if (Build.VERSION.SDK_INT >= 34) {
                        registerBackAnimationCallback();
                    } else if (Build.VERSION.SDK_INT >= 33) {
                        registerBackInvokedCallback33();
                    }
                    // SDK < 33：这里必须是空分支，不能有任何 API 33 类的引用
                } else {
                    if (Build.VERSION.SDK_INT >= 33) {
                        unregisterBackCallback();
                    }
                }
            } catch (Throwable error) {
                // 注册失败不应让 JS 侧 Promise 悬着；Web 层会退回自己的手势实现
            } finally {
                // 在 UI 线程上、注册真正完成之后再 resolve：JS 侧 await 返回时
                // 拦截已经生效，不会出现「已开启但前几帧收不到」的竞态。
                call.resolve(new JSObject());
            }
        });
    }

    /**
     * 注册 Android 14+ 的跟手动画回调。
     *
     * OnBackAnimationCallback 是 OnBackInvokedCallback 的子接口，
     * onBackInvoked 仍是唯一的抽象方法，其余三个是 default。
     */
    @RequiresApi(34)
    private void registerBackAnimationCallback() {
        if (backCallback != null) return; // 幂等
        if (getActivity() == null) return;

        android.window.OnBackAnimationCallback callback =
                new android.window.OnBackAnimationCallback() {
                    @Override
                    public void onBackStarted(android.window.BackEvent event) {
                        if (event == null) return;
                        // 上一次手势可能没有收到结束事件（系统在极端时序下会漏发，
                        // 或被来电/分屏等打断）：先补一个 cancel，保证 Web 侧
                        // 不会在「跟手中」状态下再叠一层（1.2.1 #A）。
                        if (lastDispatchedProgress >= 0f) {
                            dispatchBackGesture(
                                    "cancel",
                                    lastDispatchedProgress,
                                    backX, backY, backEdge);
                        }
                        backX = event.getTouchX();
                        backY = event.getTouchY();
                        backEdge = event.getSwipeEdge();
                        lastDispatchedProgress = -1f;
                        dispatchBackGesture("start", event.getProgress(), backX, backY, backEdge);
                    }

                    @Override
                    public void onBackProgressed(android.window.BackEvent event) {
                        if (event == null) return;
                        backX = event.getTouchX();
                        backY = event.getTouchY();
                        backEdge = event.getSwipeEdge();
                        float progress = event.getProgress();
                        // 手势停住时系统仍按帧回调，进度几乎不动；去掉这种重复帧，
                        // 避免每一帧都往 WebView 塞一次 eval。
                        if (lastDispatchedProgress >= 0f
                                && Math.abs(progress - lastDispatchedProgress) < 0.002f) {
                            return;
                        }
                        lastDispatchedProgress = progress;
                        dispatchBackGesture("move", progress, backX, backY, backEdge);
                    }

                    @Override
                    public void onBackCancelled() {
                        dispatchBackGesture(
                                "cancel",
                                lastDispatchedProgress < 0f ? 0f : lastDispatchedProgress,
                                backX, backY, backEdge);
                        lastDispatchedProgress = -1f;
                    }

                    @Override
                    public void onBackInvoked() {
                        // 手势已提交：进度视为 1。坐标沿用最后一帧（本回调不带 event）。
                        dispatchBackGesture("commit", 1f, backX, backY, backEdge);
                        lastDispatchedProgress = -1f;
                    }
                };

        getActivity().getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback);
        backCallback = callback;
    }

    /**
     * Android 13 降级路径：只有「已触发」一个时机，没有预览进度。
     * 提交时补一帧 commit(progress=1)，与 SDK 34 的行为对齐。
     */
    @RequiresApi(33)
    private void registerBackInvokedCallback33() {
        if (backCallback != null) return; // 幂等
        if (getActivity() == null) return;

        android.window.OnBackInvokedCallback callback = () ->
                dispatchBackGesture("commit", 1f, 0f, 0f, BACK_EDGE_NONE);

        getActivity().getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback);
        backCallback = callback;
    }

    /** 注销已注册的回调，把返回权交还系统（或交回 Capacitor 的 backButton 监听）。 */
    @RequiresApi(33)
    private void unregisterBackCallback() {
        Object pending = backCallback;
        if (pending == null) return;
        backCallback = null;
        lastDispatchedProgress = -1f;
        if (getActivity() == null) return;

        try {
            getActivity().getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(
                    (android.window.OnBackInvokedCallback) pending);
        } catch (Throwable ignored) {
            // 窗口已 detach 或回调本就不在分发器里：都算「已经注销」
        }
    }

    /**
     * 把一次手势转发给 Web 层：window.__mdlegoBackGesture(kind, progress, x, y, edge)。
     *
     * 三条硬约束：
     *   1. eval 内容是「固定模板 + 纯数值」，kind 由内部常量按 switch 选定，
     *      永远不接受来自 JS / Intent 的字符串，杜绝注入。
     *   2. 目标函数可能还不存在（Web 侧并行开发中），所以先判类型再调用，
     *      不存在就静默返回 —— 绝不能因为少一个函数就抛错。
     *   3. 走 bridge.eval 而不是 Capacitor notifyListeners：后者每帧都要
     *      序列化 JSObject 走一遍桥，滚动时每帧一次 GC 会掉帧。
     */
    private void dispatchBackGesture(String kind, float progress, float x, float y, int edge) {
        Bridge bridge = getBridge();
        if (bridge == null) return;

        // kind -> 固定字面量。switch 确保拼进 JS 的永远是下面四个常量之一。
        final String kindLiteral;
        switch (kind) {
            case "start":
                kindLiteral = "start";
                break;
            case "move":
                kindLiteral = "move";
                break;
            case "commit":
                kindLiteral = "commit";
                break;
            default:
                kindLiteral = "cancel";
                break;
        }

        String js = "(function(){var f=window.__mdlegoBackGesture;if(typeof f!=='function')return;"
                + "f('" + kindLiteral + "',"
                + number(progress) + ","
                + number(x) + ","
                + number(y) + ","
                + edge + ");})();";
        bridge.eval(js, null);
    }

    /**
     * 把 float 格式化成 JS 字面量。
     *
     * 固定 Locale.US，避免在逗号小数点地区（如 de-DE）拼出
     * `f('move',0,42,...)` 这种语法错误的 JS。NaN / Infinity 归零，
     * 否则会拼出 JS 里同样非法的 `NaN` / `Infinity` 之外的脏值。
     */
    private static String number(float value) {
        if (Float.isNaN(value) || Float.isInfinite(value)) return "0";
        // 限制在小数点后 4 位：进度和像素到这个精度已远超屏幕分辨率
        return String.format(Locale.US, "%.4f", value);
    }

    // ------------------------------------------------------------------
    // 应用内检查更新与外部浏览器下载（方案 A1）
    // ------------------------------------------------------------------

    /**
     * JS 侧调用：从白名单更新源抓取 JSON 清单（GET，仅 HTTPS，不走 WebView CORS）。
     */
    @PluginMethod
    public void fetchUpdateJson(PluginCall call) {
        String rawUrl = call.getString("url");
        if (rawUrl == null || !rawUrl.startsWith("https://")) {
            call.reject("更新源必须使用 HTTPS");
            return;
        }
        Uri parsed = Uri.parse(rawUrl);
        String host = parsed.getHost();
        if (host == null || !ALLOWED_UPDATE_HOSTS.contains(host.toLowerCase(Locale.US))) {
            call.reject("未授权的更新源域名");
            return;
        }

        new Thread(() -> {
            String currentUrl = rawUrl;
            try {
                for (int hop = 0; hop <= 3; hop++) {
                    HttpURLConnection conn = null;
                    try {
                        URL url = new URL(currentUrl);
                        if (!"https".equalsIgnoreCase(url.getProtocol())) {
                            JSObject err = new JSObject();
                            err.put("status", 0);
                            err.put("body", "");
                            err.put("error", "non-https-redirect");
                            call.resolve(err);
                            return;
                        }
                        conn = (HttpURLConnection) url.openConnection();
                        conn.setInstanceFollowRedirects(false);
                        conn.setConnectTimeout(UPDATE_TIMEOUT_MS);
                        conn.setReadTimeout(UPDATE_TIMEOUT_MS);
                        conn.setRequestMethod("GET");
                        conn.setRequestProperty("Accept", "application/json");
                        conn.setRequestProperty("User-Agent", "Mdlego-Android");
                        conn.setRequestProperty("Cache-Control", "no-cache");

                        int status = conn.getResponseCode();
                        if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                            String location = conn.getHeaderField("Location");
                            if (location == null || location.isEmpty()) {
                                JSObject err = new JSObject();
                                err.put("status", status);
                                err.put("body", "");
                                err.put("error", "empty-redirect");
                                call.resolve(err);
                                return;
                            }
                            URL nextUrl = new URL(url, location);
                            if (!"https".equalsIgnoreCase(nextUrl.getProtocol())) {
                                JSObject err = new JSObject();
                                err.put("status", 0);
                                err.put("body", "");
                                err.put("error", "insecure-redirect");
                                call.resolve(err);
                                return;
                            }
                            currentUrl = nextUrl.toString();
                            continue;
                        }

                        String body = "";
                        if (status >= 200 && status < 300) {
                            try (InputStream in = conn.getInputStream()) {
                                body = readUtf8Limited(in, UPDATE_MAX_BYTES);
                            }
                        }
                        JSObject ret = new JSObject();
                        ret.put("status", status);
                        ret.put("body", body);
                        call.resolve(ret);
                        return;
                    } finally {
                        if (conn != null) conn.disconnect();
                    }
                }
                JSObject err = new JSObject();
                err.put("status", 0);
                err.put("body", "");
                err.put("error", "too-many-redirects");
                call.resolve(err);
            } catch (Exception e) {
                JSObject err = new JSObject();
                err.put("status", 0);
                err.put("body", "");
                err.put("error", e.getMessage() != null ? e.getMessage() : "network-error");
                call.resolve(err);
            }
        }, "mdlego-update-check").start();
    }

    private static String readUtf8Limited(InputStream in, int maxBytes) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int total = 0;
        int n;
        while ((n = in.read(buf)) != -1) {
            total += n;
            if (total > maxBytes) throw new Exception("更新清单超过 64 KB 上限");
            out.write(buf, 0, n);
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    /**
     * JS 侧调用：用系统浏览器打开外部 HTTPS 下载或发布链接。
     */
    @PluginMethod
    public void openExternalUrl(PluginCall call) {
        String rawUrl = call.getString("url");
        if (rawUrl == null || !rawUrl.startsWith("https://") || getActivity() == null) {
            JSObject ret = new JSObject();
            ret.put("ok", false);
            call.resolve(ret);
            return;
        }
        Uri uri = Uri.parse(rawUrl);
        if (uri == null || uri.getScheme() == null || !"https".equalsIgnoreCase(uri.getScheme())) {
            JSObject ret = new JSObject();
            ret.put("ok", false);
            call.resolve(ret);
            return;
        }
        getActivity().runOnUiThread(() -> {
            JSObject ret = new JSObject();
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW, uri);
                intent.addCategory(Intent.CATEGORY_BROWSABLE);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().startActivity(intent);
                ret.put("ok", true);
            } catch (Throwable error) {
                ret.put("ok", false);
            }
            call.resolve(ret);
        });
    }

    /**
     * JS 侧调用：切换屏幕方向（表格全屏查看时自动横屏并隐藏系统栏，退出后恢复）。
     */
    @PluginMethod
    public void setScreenOrientation(PluginCall call) {
        String mode = call.getString("mode");
        if (getActivity() == null) {
            call.resolve(new JSObject());
            return;
        }
        final boolean landscape = "landscape".equals(mode);
        final int orientation = landscape
                ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
        getActivity().runOnUiThread(() -> {
            try {
                Window window = getActivity().getWindow();
                if (window != null) {
                    View decor = window.getDecorView();
                    WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, decor);
                    if (controller != null) {
                        if (landscape) {
                            controller.setSystemBarsBehavior(
                                    WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                            controller.hide(WindowInsetsCompat.Type.systemBars());
                        } else {
                            controller.show(WindowInsetsCompat.Type.systemBars());
                        }
                    }
                    decor.requestApplyInsets();
                }
                getActivity().setRequestedOrientation(orientation);
            } catch (Throwable ignored) {
                // 个别系统多窗口/分屏模式禁止锁定方向时静默忽略，不阻塞查看
            }
            call.resolve(new JSObject());
        });
    }

}
