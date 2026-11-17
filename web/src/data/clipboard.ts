/**
 * 剪贴板（阶段 E2 起统一走这里）。
 *
 * 为什么放 data 层：navigator.clipboard 是平台 IO；views 不直接碰平台 API。
 * Android WebView 在非安全上下文或旧版本里可能没有 Clipboard API，
 * 因此保留 textarea + execCommand 的降级路径；两者都失败返回 false，由调用方提示。
 */

/** 复制文本；成功返回 true，失败返回 false（不抛错）。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 走降级 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
