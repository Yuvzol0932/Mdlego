/**
 * 封面与装帧版式（阶段 C2 + 高辨识度装帧封面升级）。
 *
 * 自动封面不再只是「单调渐变 + 一个大字」，而是按文档标题/标签派生出
 * 「12 套书封色板 × 6 种图书装帧版式 + 精简书名 + 副标角标 + 首字徽标」；
 * 同时支持单篇文档手动覆盖色板、版式、徽标文字、副标题或本地图片。
 *
 * 色值一律来自 tokens.css 的 --cover-1..12（组件按 data-cover 选择），
 * 绝不在 JS 里出现硬编码颜色。
 */

import type { CoverPattern, Doc, DocCover } from '../core/types';

/** 可用封面色板数量，与 tokens.css 的 --cover-1..12 一一对应。 */
export const COVER_COUNT = 12;

/** 六种书封装帧版式及其中文名称。 */
export const COVER_PATTERNS: ReadonlyArray<{ readonly id: CoverPattern; readonly label: string }> = [
  { id: 'frame', label: '典雅框线' },
  { id: 'band', label: '杂志腰封' },
  { id: 'orb', label: '几何日轮' },
  { id: 'slash', label: '斜切色块' },
  { id: 'minimal', label: '极简排印' },
  { id: 'folio', label: '古籍题签' },
];

function hashTitle(title: string, seed = 0): number {
  let hash = seed >>> 0;
  for (const ch of title) {
    const code = ch.codePointAt(0) ?? 0;
    hash = (Math.imul(hash, 31) + code) >>> 0;
  }
  return hash >>> 0;
}

/** 标题 → 封面色板序号（1..12）。哈希保证同一标题恒定同色。 */
export function coverIndex(title: string): number {
  return (hashTitle(title, 0) % COVER_COUNT) + 1;
}

/** 标题 → 装帧版式（使用独立种子，让同色或同前缀的文档也能拉开版式辨识度）。 */
export function coverPattern(title: string): CoverPattern {
  const idx = hashTitle(title, 0x9e3779b9) % COVER_PATTERNS.length;
  return COVER_PATTERNS[idx]?.id ?? 'frame';
}

/** 封面上的装饰首字：中文取首字，拉丁字母转大写，空标题回落「墨」。 */
export function coverInitial(title: string): string {
  const trimmed = title.trim();
  const first = trimmed.length > 0 ? ([...trimmed][0] ?? '墨') : '墨';
  return /^[a-z]$/.test(first) ? first.toUpperCase() : first;
}

/** 估读时长：中文阅读约 500 字/分钟（与旧书架卡片的估算保持一致）。 */
export function estimatedMinutes(text: string): number {
  return Math.max(1, Math.round(text.length / 500));
}

/** 相对时间：今天 / 昨天 / N 天前 / 具体日期。 */
export function relativeTime(ms: number | null): string {
  if (ms === null) return '未读';
  const diff = Date.now() - ms;
  const day = 86_400_000;
  if (diff < 0) return '刚刚';
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < day * 2) return '昨天';
  if (diff < day * 7) return `${Math.floor(diff / day)} 天前`;
  const d = new Date(ms);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

/** 封面副标角标：优先用户自定义，其次文件夹/首标签，最后估读时长。 */
export function coverSubtitle(doc: Doc): string {
  const custom = doc.cover?.subtitle?.trim();
  if (custom !== undefined && custom.length > 0) return custom;
  const folder = doc.folder?.trim();
  if (folder !== undefined && folder.length > 0) return folder;
  const firstTag = doc.tags?.[0]?.trim();
  if (firstTag !== undefined && firstTag.length > 0) return `#${firstTag}`;
  return `约 ${estimatedMinutes(doc.text)} 分钟`;
}

export interface ResolvedCover {
  readonly palette: number;
  readonly pattern: CoverPattern;
  readonly monogram: string;
  readonly subtitle: string;
  readonly image: string | null;
}

/** 把 Doc 的自定义 cover 与自动派生结果合并成完整渲染参数。 */
export function resolveDocCover(doc: Doc, override?: DocCover | null): ResolvedCover {
  const c = override === undefined ? doc.cover : override;
  const rawPalette = c?.palette;
  const palette =
    typeof rawPalette === 'number' && Number.isInteger(rawPalette) && rawPalette >= 1 && rawPalette <= COVER_COUNT
      ? rawPalette
      : coverIndex(doc.title);
  const pattern =
    c?.pattern !== undefined && COVER_PATTERNS.some((p) => p.id === c.pattern)
      ? c.pattern
      : coverPattern(doc.title);
  const rawMono = c?.monogram?.trim();
  const monogram = rawMono !== undefined && rawMono.length > 0 ? [...rawMono].slice(0, 4).join('') : coverInitial(doc.title);
  const rawSub = c?.subtitle?.trim();
  const subtitle = rawSub !== undefined && rawSub.length > 0 ? rawSub : coverSubtitle({ ...doc, cover: null });
  const image = typeof c?.image === 'string' && c.image.length > 0 ? c.image : null;
  return { palette, pattern, monogram, subtitle, image };
}

/** 构造带装帧纹理、书脊折痕与信息层级的封面 DOM（网格/列表/继续阅读/预览共用）。 */
export function buildCoverElement(
  doc: Doc,
  className: string,
  options: { readonly compact?: boolean; readonly override?: DocCover | null } = {},
): HTMLElement {
  const resolved = resolveDocCover(doc, options.override);
  const compact = options.compact === true;
  const el = document.createElement('span');
  el.className = `cover ${className}`;
  el.setAttribute('data-cover', String(resolved.palette));
  el.setAttribute('data-cover-pattern', resolved.pattern);
  el.setAttribute('data-cover-doc', doc.id);
  el.setAttribute('aria-hidden', 'true');

  if (resolved.image !== null) {
    el.setAttribute('data-cover-photo', '1');
    el.style.backgroundImage = `var(--cover-photo-scrim), url("${resolved.image}")`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
  }

  const spine = document.createElement('span');
  spine.className = 'cover__spine';
  const motif = document.createElement('span');
  motif.className = 'cover__motif';
  el.append(spine, motif);

  if (!compact) {
    const head = document.createElement('span');
    head.className = 'cover__head';
    const sub = document.createElement('span');
    sub.className = 'cover__sub';
    sub.textContent = resolved.subtitle;
    head.append(sub);
    el.append(head);

    const folio = document.createElement('span');
    folio.className = 'cover__folio';
    folio.textContent = 'MD';
    el.append(folio);
  }

  const initial = document.createElement('span');
  const charLen = [...resolved.monogram].length;
  initial.className = charLen > 1 ? 'cover__initial cover__initial--multi' : 'cover__initial';
  initial.textContent = resolved.monogram;
  el.append(initial);

  return el;
}
