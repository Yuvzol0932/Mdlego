/**
 * 横幅背景图的选择与压缩（阶段 C2）。
 *
 * 设置存 localStorage，配额约 5MB，所以这里在写入前先缩图：
 * 长边最多 1440px、JPEG 质量 0.82，通常 100~250KB。超过上限就不存（返回 null），
 * 让界面回落到主题渐变 —— 不因为用户选了一张 20MB 的原图把设置写坏。
 *
 * 这是 data 层：唯一允许碰文件选择与 canvas 编码的地方（视图只拿 data URL）。
 */

const MAX_EDGE = 1440;
const JPEG_QUALITY = 0.82;
/** 压缩后仍超过这个字符数就放弃（localStorage 总配额 5MB 的余量）。 */
const MAX_DATA_URL_CHARS = 900_000;

/** 选择一张图片并压缩成 data URL。用户取消返回 null。 */
export function pickBannerImage(): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.position = 'fixed';
    input.style.left = '-9999px';

    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file === undefined) {
        finish(null);
        return;
      }
      void downscaleImage(file).then(finish).catch(() => finish(null));
    });
    // 用户点「取消」时浏览器不派发 change；把 input 留在 DOM 里等下一次点击会累积节点，
    // 所以用 window 的 focus 回来做兜底回收（不改变用户已选结果）。
    input.addEventListener('cancel', () => finish(null));

    document.body.append(input);
    input.click();
  });
}

/** 把图片文件缩到长边 ≤ MAX_EDGE 并编码成 JPEG data URL。 */
async function downscaleImage(file: File): Promise<string | null> {
  if (!file.type.startsWith('image/')) return null;

  // createImageBitmap 在 Android WebView 上可用；失败再回落到 <img> + object URL
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    bitmap = null;
  }

  const sourceWidth = bitmap?.width ?? 0;
  const sourceHeight = bitmap?.height ?? 0;

  if (bitmap === null || sourceWidth === 0 || sourceHeight === 0) {
    return downscaleViaImageElement(file);
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) {
    bitmap.close();
    return null;
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  return dataUrl.length <= MAX_DATA_URL_CHARS ? dataUrl : null;
}

/** 不支持 createImageBitmap 的环境：用 <img> 解码后再走同一套 canvas 压缩。 */
function downscaleViaImageElement(file: File): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
      const height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx === null) {
        URL.revokeObjectURL(url);
        resolve(null);
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      resolve(dataUrl.length <= MAX_DATA_URL_CHARS ? dataUrl : null);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}
