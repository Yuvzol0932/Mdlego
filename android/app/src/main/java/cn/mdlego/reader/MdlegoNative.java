package cn.mdlego.reader;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.activity.result.ActivityResult;
import androidx.core.graphics.Insets;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 墨读原生桥。
 *
 * 只做四件事，刻意保持很小：
 *   1. 读取系统「打开 / 分享」投递进来的 content:// 文件
 *   2. 调起系统文件选择器（App 内主动导入的兜底路径）
 *   3. 报告原文件是否被外部改动（M6 回写前要用）
 *   4. 回写原文件（M6 用；此处先把能力备好）
 *
 * 不申请任何存储权限，全部走 SAF / ContentResolver。
 * 不申请 INTERNET 权限 —— 见 AndroidManifest.xml 的说明。
 */
@CapacitorPlugin(name = "MdlegoNative")
public class MdlegoNative extends Plugin {

    /** 单文件上限，与 Web 层 MAX_FILE_BYTES 保持一致。 */
    private static final int MAX_BYTES = 10 * 1024 * 1024;

    /** 启动 Intent 里待处理的 URI；JS 侧 ready 后主动来取。 */
    private final List<String> pendingUris = new ArrayList<>();

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
            float density = v.getResources().getDisplayMetrics().density;
            int topDp = Math.round(bars.top / density);
            int bottomDp = Math.round(bars.bottom / density);
            // 固定字符串，只拼入数值，不执行任何外部输入
            String js = "document.documentElement.style.setProperty('--android-safe-top','"
                    + topDp + "px');"
                    + "document.documentElement.style.setProperty('--android-safe-bottom','"
                    + bottomDp + "px');";
            getBridge().eval(js, null);
            return insets;
        });
        decor.requestApplyInsets();
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
     * JS 侧调用：查看待处理 URI，但不清空。
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

}
