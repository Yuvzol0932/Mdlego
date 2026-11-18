/**
 * 原生能力封装 —— Web 层唯一的原生调用出口。
 *
 * 规则（docs/ARCHITECTURE.md §8）：
 *   - 全部带浏览器降级，浏览器里能跑完整流程（用 <input type=file>）
 *   - 视图层不直接 import Capacitor，只依赖本模块导出的接口
 *   - 任何原生调用失败都返回明确的降级结果，不抛到渲染路径上
 */

import { Capacitor, registerPlugin } from '@capacitor/core';

/** 原生插件返回的单个文件描述。 */
export interface NativeFile {
  readonly name: string;
  readonly uri: string;
  readonly size: number;
  readonly mtimeMs: number | null;
  readonly base64: string;
  readonly textOnly: boolean;
}

/** 插件接口。 */
interface MdlegoNativePlugin {
  /** 查看待处理 URI，不清空（导入成功后才由 clearPendingUris 清）。 */
  peekPendingUris(): Promise<{ uris: string[] }>;
  /** 导入成功后清空待处理 URI。 */
  clearPendingUris(): Promise<void>;
  readDocuments(options: { uris: string[] }): Promise<{ files: NativeFile[] }>;
  pickFiles(): Promise<{ uris: string[]; cancelled: boolean }>;
  statDocument(options: { uri: string }): Promise<{ exists: boolean; size: number; readable: boolean }>;
  writeDocument(options: { uri: string; base64: string }): Promise<{ ok: boolean }>;
  /**
   * 让状态栏/导航栏图标明暗跟随主题（lookup #5）。
   *
   * `dark: true` = 浅色主题 → 图标用深色；`dark: false` = 深色主题 → 图标用浅色。
   * 只改图标明暗，不改背景色：背景由 edge-to-edge 让 Web 内容自己画到顶部，
   * 原生再涂一层会多出一条色带。
   */
  setSystemBarsDark(options: { dark: boolean }): Promise<void>;
  addListener(eventName: 'filesReceived', cb: () => void): Promise<{ remove: () => Promise<void> }>;
}

const Native = registerPlugin<MdlegoNativePlugin>('MdlegoNative');

/** 是否运行在真正的 Android 原生环境。 */
export function isNative(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

/** base64 → Uint8Array。 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Uint8Array → base64。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 查看启动 Intent 里待处理的 URI，不清空。
 *
 * 关键：不能「取出即清空」。读取 content:// 可能因权限或 provider 时序失败，
 * 一旦清空就永久丢失、用户再点「打开」也不会有反应。只有导入成功后
 * 才由 clearPendingUris() 清空。浏览器里永远返回空数组。
 */
export async function peekPendingUris(): Promise<string[]> {
  if (!isNative()) return [];
  try {
    const result = await Native.peekPendingUris();
    return result.uris ?? [];
  } catch {
    return [];
  }
}

/** 导入成功后清空待处理 URI；失败时保留，允许下次重试。 */
export async function clearPendingUris(): Promise<void> {
  if (!isNative()) return;
  try {
    await Native.clearPendingUris();
  } catch {
    /* 清空失败不影响已导入结果，最坏是下次重复导入（会被去重挡住） */
  }
}

/**
 * 读取若干 content:// URI，返回原始文件描述。
 *
 * 不再吞异常：读取失败必须让上层知道，变成可见反馈而不是「点了没反应」。
 * 上层用 try/catch 把它转成 failures 与 toast。
 */
export async function readNativeFiles(uris: readonly string[]): Promise<NativeFile[]> {
  if (!isNative() || uris.length === 0) return [];
  const result = await Native.readDocuments({ uris: [...uris] });
  return result.files ?? [];
}

/**
 * 调起系统文件选择器，返回选中的 URI。
 *
 * 加超时兜底：某些 ROM 的 SAF 回调可能丢失，若原生 Promise 永远不 settle，
 * 用户会停在「点了导入没反应」。宁可 90 秒后按取消处理并给提示，也不卡死。
 * 正常选择通常在几秒内返回，不受影响。
 */
export async function pickNativeFiles(): Promise<{ uris: string[]; cancelled: boolean }> {
  if (!isNative()) return { uris: [], cancelled: true };

  const cancelled = { uris: [], cancelled: true };
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      Native.pickFiles(),
      new Promise<{ uris: string[]; cancelled: boolean }>((resolve) => {
        timer = setTimeout(() => resolve(cancelled), 90_000);
      }),
    ]);
  } catch {
    return cancelled;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * 浏览器降级：用 <input type=file> 多选。
 * 返回与原生层同构的 NativeFile[]，上层无需分支。
 *
 * 不做「用户取消」的探测：input.change 不触发就是取消，
 * 上层拿到空数组后什么都不做即可。曾经用过 focus 回来兜底，
 * 反而会在正常选择后误判为空，已移除。
 */
export function pickBrowserFiles(): Promise<NativeFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.md,.markdown,.txt,text/markdown,text/plain';

    // 挂到 DOM 上：一是让 CDP/自动化能给这个 input 设文件，
    // 二是某些浏览器对「游离的 input」不派发 change 事件。
    input.style.display = 'none';
    document.body.append(input);

    const cleanup = (): void => { input.remove(); };
    input.addEventListener('change', async () => {
      const files = Array.from(input.files ?? []);
      const out: NativeFile[] = [];
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        out.push({
          name: file.name,
          uri: '',
          size: file.size,
          mtimeMs: file.lastModified,
          base64: bytesToBase64(bytes),
          textOnly: false,
        });
      }
      cleanup();
      resolve(out);
    }, { once: true });

    input.click();
  });
}

/** 统一的「选择文件」入口：原生走 SAF，浏览器走 input。 */
export async function pickFiles(): Promise<NativeFile[]> {
  if (isNative()) {
    const picked = await pickNativeFiles();
    if (picked.cancelled || picked.uris.length === 0) return [];
    return readNativeFiles(picked.uris);
  }
  return pickBrowserFiles();
}

/** 检查原文件是否被外部改动（M6 用）。 */
export async function statDocument(
  uri: string,
): Promise<{ exists: boolean; size: number; readable: boolean }> {
  if (!isNative() || uri.length === 0) return { exists: false, size: -1, readable: false };
  try {
    return await Native.statDocument({ uri });
  } catch {
    return { exists: false, size: -1, readable: false };
  }
}

/** 把编辑后的文本写回原文件（M6 用）。 */
export async function writeDocument(uri: string, bytes: Uint8Array): Promise<boolean> {
  if (!isNative() || uri.length === 0) return false;
  try {
    const result = await Native.writeDocument({ uri, base64: bytesToBase64(bytes) });
    return result.ok === true;
  } catch {
    return false;
  }
}

/** 订阅「系统分享又来了」事件。 */
export async function onFilesReceived(callback: () => void): Promise<() => void> {
  if (!isNative()) {
    window.addEventListener('mdlego:files', callback);
    return () => window.removeEventListener('mdlego:files', callback);
  }
  try {
    const handle = await Native.addListener('filesReceived', callback);
    return () => { void handle.remove(); };
  } catch {
    return () => { /* 不支持时静默 */ };
  }
}

// ─────────────────────────────────────────────
// 屏幕常亮（阶段 C5）
// ─────────────────────────────────────────────

/**
 * Screen Wake Lock 持有句柄。
 * 不支持该 API 的环境（旧 WebView / 桌面浏览器）静默降级：
 * 设置照常保存，阅读不受影响，只是屏幕不会强制常亮。
 */
let wakeSentinel: WakeLockSentinel | null = null;

/** 请求屏幕常亮；已持有或环境不支持时是空操作。 */
export async function requestScreenWakeLock(): Promise<void> {
  if (wakeSentinel !== null) return;
  if (typeof navigator === 'undefined' || navigator.wakeLock === undefined) return;
  try {
    const sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      // 系统在切后台/低电量时会自己释放；标记空，回到前台后再申请
      if (wakeSentinel === sentinel) wakeSentinel = null;
    });
    wakeSentinel = sentinel;
  } catch {
    wakeSentinel = null;
  }
}

/** 释放屏幕常亮。 */
export function releaseScreenWakeLock(): void {
  const sentinel = wakeSentinel;
  wakeSentinel = null;
  if (sentinel === null) return;
  void sentinel.release().catch(() => {
    /* 已释放/不可用都无所谓 */
  });
}

/**
 * 同步状态栏/导航栏图标的明暗（lookup #5）。
 *
 * 只影响系统栏图标的颜色，不画背景：状态栏背景由 edge-to-edge 让 Web 内容
 * 自己画上去（顶栏的 --safe-top 内边距就是给它的），原生再涂一层背景色
 * 会多出一条与主题不一致的色带。
 *
 * 所有失败都吞掉：浏览器里没有这个能力，旧版 APK 上这个 plugin 方法也不存在，
 * 两种情况都只影响图标明暗，绝不能因此打断主题切换。
 */
export function syncSystemBars(dark: boolean): void {
  if (!isNative()) return;
  void Native.setSystemBarsDark({ dark }).catch(() => {
    /* 旧 APK 没有这个方法，忽略 */
  });
}
