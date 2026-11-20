/**
 * 横幅背景图的选择与压缩（阶段 C2）。
 *
 * 设置存 localStorage，配额约 5MB，所以这里在写入前先缩图：
 * 长边最多 1440px、JPEG 质量 0.82，通常 100~250KB。超过上限就不存（返回 null），
 * 让界面回落到主题渐变 —— 不因为用户选了一张 20MB 的原图把设置写坏。
 *
 * 这是 data 层：唯一允许碰文件选择与 canvas 编码的地方（视图只拿 data URL）。
 */

interface ImagePickSpec {
  readonly maxEdge: number;
  readonly quality: number;
  readonly maxChars: number;
}

const BANNER_SPEC: ImagePickSpec = { maxEdge: 1440, quality: 0.82, maxChars: 900_000 };
const COVER_SPEC: ImagePickSpec = { maxEdge: 720, quality: 0.8, maxChars: 260_000 };

/** 选择一张横幅图并压缩成 data URL。用户取消返回 null。 */
export function pickBannerImage(): Promise<string | null> {
  return pickCompressedImage(BANNER_SPEC);
}

/** 选择一张书籍封面图并压缩成轻量 data URL（存入 IndexedDB）。用户取消返回 null。 */
export function pickCoverImage(): Promise<string | null> {
  return pickCompressedImage(COVER_SPEC);
}

function pickCompressedImage(spec: ImagePickSpec): Promise<string | null> {
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
      void downscaleImage(file, spec).then(finish).catch(() => finish(null));
    });
    // 用户点「取消」时浏览器不派发 change；把 input 留在 DOM 里等下一次点击会累积节点，
    // 所以用 window 的 focus 回来做兜底回收（不改变用户已选结果）。
    input.addEventListener('cancel', () => finish(null));

    document.body.append(input);
    input.click();
  });
}

/** 把图片文件缩到长边 ≤ spec.maxEdge 并编码成 JPEG data URL。 */
async function downscaleImage(file: File, spec: ImagePickSpec): Promise<string | null> {
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
    return downscaleViaImageElement(file, spec);
  }

  const scale = Math.min(1, spec.maxEdge / Math.max(sourceWidth, sourceHeight));
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

  const dataUrl = canvas.toDataURL('image/jpeg', spec.quality);
  return dataUrl.length <= spec.maxChars ? dataUrl : null;
}

/** 不支持 createImageBitmap 的环境：用 <img> 解码后再走同一套 canvas 压缩。 */
function downscaleViaImageElement(file: File, spec: ImagePickSpec): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, spec.maxEdge / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
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
      const dataUrl = canvas.toDataURL('image/jpeg', spec.quality);
      resolve(dataUrl.length <= spec.maxChars ? dataUrl : null);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}
