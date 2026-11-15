package cn.mdlego.reader;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

/**
 * 应用主 Activity。
 *
 * 只做两件与「系统分享」有关的事：
 *  1. onCreate 时注册自定义插件
 *  2. 复用进程（launchMode=singleTask）时把新 Intent 转给插件
 *
 * 不做 WebView 缓存清理 —— 上一代项目在这里踩过坑：
 * 它靠清 Service Worker 缓存解决「覆盖安装看不到变化」，反而制造了两次事故。
 * 本项目用内容哈希文件名 + 版本号单一来源从结构上解决，不需要清缓存。
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MdlegoNative.class);
        super.onCreate(savedInstanceState);
    }

    /**
     * singleTask 模式下，应用已在后台时新的 VIEW/SEND Intent 会走这里，
     * 而不是 onCreate。不转发就等于「分享过来但 App 没反应」。
     *
     * 同时用 Bridge.eval 通知 Web 层重新拉取待处理 URI。
     * eval 里是固定字符串，不执行任何外部输入。
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);

        if (getBridge() != null) {
            PluginHandle handle = getBridge().getPlugin("MdlegoNative");
            if (handle != null && handle.getInstance() instanceof MdlegoNative) {
                ((MdlegoNative) handle.getInstance()).onNewIntent(intent);
            }
            getBridge().eval("window.dispatchEvent(new Event('mdlego:files'))", null);
        }
    }
}
