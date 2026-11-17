/**
 * 书架视图数据（阶段 E1）—— 标签 / 文件夹 / 筛选的纯函数。
 *
 * 为什么放在 core：标签归一化、筛选与三态计算是「数据形状」问题，
 * 放进视图会让同样的规则在书架、搜索、标签面板里各写一遍。
 * 这里全部纯函数，不做 IO、不碰 DOM；data 层负责套用归一化，main 负责持久化。
 */

import type { Doc } from './types';

/** 每篇文档的标签上限（超过的忽略，避免一个文档挂几十个标签把界面撑爆）。 */
export const TAG_MAX_COUNT = 12;
/** 单个标签的最大长度（字符）。 */
export const TAG_MAX_LEN = 24;
/** 文件夹名最大长度（字符）。 */
export const FOLDER_MAX_LEN = 40;

/** 书架筛选条件。 */
export type ShelfFilter =
  | { readonly kind: 'all' }
  | { readonly kind: 'favorites' }
  | { readonly kind: 'tag'; readonly tag: string }
  | { readonly kind: 'folder'; readonly folder: string };

/** 文档上的标签（旧数据没有该字段 → 空数组）。 */
export function tagsOf(doc: Pick<Doc, 'tags'>): readonly string[] {
  return doc.tags ?? [];
}

/** 文档所属文件夹（旧数据没有该字段 → null）。 */
export function folderOf(doc: Pick<Doc, 'folder'>): string | null {
  return doc.folder ?? null;
}

/** 归一化单个标签：去首尾空白、折叠内部空白；空串返回 null。 */
export function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, TAG_MAX_LEN);
}

/**
 * 归一化标签列表：逐项归一化 → 去重（大小写不敏感，保留首次大小写）→ 截断数量。
 * 用 `Set` 记录已有小写形式，保证「Deep Work」与「deep work」不会并存。
 */
export function normalizeTags(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const tag = normalizeTag(item);
    if (tag === null) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= TAG_MAX_COUNT) break;
  }
  return out;
}

/** 归一化文件夹名；空白/非字符串返回 null。 */
export function normalizeFolder(raw: unknown): string | null {
  if (typeof raw !== 'string' && raw !== null) return null;
  if (raw === null) return null;
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  return trimmed.length === 0 ? null : trimmed.slice(0, FOLDER_MAX_LEN);
}

/** 把文档上的标签/文件夹字段规整成合法值（读库后套用）。 */
export function normalizeLibraryDoc(doc: Doc): Doc {
  const tags = normalizeTags(doc.tags);
  const folder = normalizeFolder(doc.folder);
  // 没有变化时返回原对象：书架签名与列表比对都按引用，避免无谓重绘
  const sameTags = doc.tags !== undefined && doc.tags.length === tags.length && doc.tags.every((t, i) => t === tags[i]);
  const sameFolder = (doc.folder ?? null) === folder;
  if (sameTags && sameFolder) return doc;
  return { ...doc, tags, folder };
}

/** 一个筛选维度下的计数（用于 chip 上的数字与排序）。 */
export interface FacetCount {
  readonly value: string;
  /** 使用该标签/文件夹的文档数。 */
  readonly count: number;
}

export interface LibraryFacets {
  readonly total: number;
  readonly favorites: number;
  readonly tags: readonly FacetCount[];
  readonly folders: readonly FacetCount[];
}

/**
 * 统计筛选维度：标签/文件夹按使用次数降序、同次数按名称升序（稳定，便于测试与截图对比）。
 * 收藏数来自独立存储的 bookmarks，可能包含已被删除的文档 id —— 只统计仍存在的文档。
 */
export function collectFacets(docs: readonly Doc[], bookmarks: readonly string[]): LibraryFacets {
  const tagCounts = new Map<string, number>();
  const folderCounts = new Map<string, number>();
  const liveIds = new Set(docs.map((d) => d.id));
  for (const doc of docs) {
    for (const tag of tagsOf(doc)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    const folder = folderOf(doc);
    if (folder !== null) folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
  }
  const toSorted = (counts: Map<string, number>): FacetCount[] =>
    [...counts.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh-Hans-CN'));
  return {
    total: docs.length,
    favorites: bookmarks.filter((id) => liveIds.has(id)).length,
    tags: toSorted(tagCounts),
    folders: toSorted(folderCounts),
  };
}

/** 按筛选条件过滤文档。顺序保持传入顺序（排序由调用方负责）。 */
export function filterDocs(docs: readonly Doc[], filter: ShelfFilter, bookmarks: readonly string[]): Doc[] {
  if (filter.kind === 'all') return [...docs];
  if (filter.kind === 'favorites') {
    const favorites = new Set(bookmarks);
    return docs.filter((d) => favorites.has(d.id));
  }
  if (filter.kind === 'tag') {
    const wanted = filter.tag.toLowerCase();
    return docs.filter((d) => tagsOf(d).some((t) => t.toLowerCase() === wanted));
  }
  return docs.filter((d) => folderOf(d) === filter.folder);
}

/** 筛选条件是否生效（用于决定要不要显示「清除筛选」与筛选空态）。 */
export function isFiltering(filter: ShelfFilter): boolean {
  return filter.kind !== 'all';
}

/** 标签在给定文档集合里的三态：全部有 / 部分有 / 都没有。 */
export type TagSelectionState = 'all' | 'some' | 'none';

export function tagSelectionState(docs: readonly Doc[], tag: string): TagSelectionState {
  if (docs.length === 0) return 'none';
  const wanted = tag.toLowerCase();
  let have = 0;
  for (const doc of docs) {
    if (tagsOf(doc).some((t) => t.toLowerCase() === wanted)) have += 1;
  }
  if (have === 0) return 'none';
  return have === docs.length ? 'all' : 'some';
}

/** 给指定文档加上一个标签（已在的跳过；返回新数组，未变化的文档保持原引用）。 */
export function addTagToDocs(docs: readonly Doc[], ids: readonly string[], rawTag: unknown): Doc[] {
  const tag = normalizeTag(rawTag);
  if (tag === null) return [...docs];
  const targets = new Set(ids);
  return docs.map((doc) => {
    if (!targets.has(doc.id)) return doc;
    const current = tagsOf(doc);
    if (current.some((t) => t.toLowerCase() === tag.toLowerCase())) return doc;
    const next = normalizeTags([...current, tag]);
    return { ...doc, tags: next };
  });
}

/** 从指定文档移除一个标签（大小写不敏感）。 */
export function removeTagFromDocs(docs: readonly Doc[], ids: readonly string[], rawTag: unknown): Doc[] {
  const tag = normalizeTag(rawTag);
  if (tag === null) return [...docs];
  const wanted = tag.toLowerCase();
  const targets = new Set(ids);
  return docs.map((doc) => {
    if (!targets.has(doc.id)) return doc;
    const current = tagsOf(doc);
    const next = current.filter((t) => t.toLowerCase() !== wanted);
    return next.length === current.length ? doc : { ...doc, tags: next };
  });
}

/** 把指定文档移动到文件夹（null = 移出文件夹）。 */
export function setFolderForDocs(docs: readonly Doc[], ids: readonly string[], rawFolder: unknown): Doc[] {
  const folder = normalizeFolder(rawFolder);
  const targets = new Set(ids);
  return docs.map((doc) => {
    if (!targets.has(doc.id)) return doc;
    return folderOf(doc) === folder ? doc : { ...doc, folder };
  });
}

/** 从一组文档里收集它们现有的全部标签（标签面板的候选，按出现次数降序）。 */
export function tagsAmongDocs(docs: readonly Doc[]): readonly FacetCount[] {
  const counts = new Map<string, number>();
  for (const doc of docs) {
    for (const tag of tagsOf(doc)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh-Hans-CN'));
}
