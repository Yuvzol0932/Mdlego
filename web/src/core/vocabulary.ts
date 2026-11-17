/**
 * 生词本与查词历史（阶段 E4，纯函数）。
 *
 * 存哪里：meta 的 `wordbook` / `lookupHistory` 两个键（JSON 数组）。
 * 为什么不建新 IndexedDB 仓库：生词量级在几百级、整表读写就够，
 * 上仓库要升 DB 版本、写迁移与迁移测试；这层先保持轻量。
 *
 * 规则：
 *   - 单词归一化：去空白、转小写、只接受英文字母/连字符/撇号，长度 2..64；
 *   - 生词本按 word 去重（重复收藏视为更新词条与时间，不重复占位），上限 500；
 *   - 查词历史按 word 去重（同一个词只留最近一次），最新在前，上限 100；
 *   - 所有函数不修改输入、不做 IO。
 */

export interface WordEntry {
  /** 归一化后的小写单词。 */
  readonly word: string;
  readonly phonetic: string;
  readonly translation: string;
  /** 收藏时刻（毫秒）。 */
  readonly addedAt: number;
}

export interface LookupHistoryEntry {
  readonly word: string;
  readonly at: number;
}

/** 生词本上限。 */
export const WORD_MAX = 500;
/** 查词历史上限。 */
export const HISTORY_MAX = 100;
/** 单词最大长度（超出视为脏数据）。 */
const WORD_MAX_LEN = 64;

/** 归一化单词；非法返回 null。 */
export function normalizeWord(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const word = raw.trim().toLowerCase();
  if (word.length < 2 || word.length > WORD_MAX_LEN) return null;
  return /^[a-z][a-z'-]*$/.test(word) ? word : null;
}

function normalizeText(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/** 归一化一条生词；word 非法或缺少释义返回 null（不展示空词条）。 */
export function normalizeWordEntry(raw: unknown): WordEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const word = normalizeWord(record['word']);
  if (word === null) return null;
  const translation = normalizeText(record['translation']);
  if (translation.length === 0) return null;
  const addedAt = typeof record['addedAt'] === 'number' && Number.isFinite(record['addedAt'])
    ? record['addedAt']
    : 0;
  return {
    word,
    phonetic: normalizeText(record['phonetic']),
    translation,
    addedAt,
  };
}

/** 归一化整个生词本：逐项校验、按 word 去重（保留最新一条）、按收藏时间倒序、截断上限。 */
export function normalizeWords(raw: unknown): WordEntry[] {
  if (!Array.isArray(raw)) return [];
  const byWord = new Map<string, WordEntry>();
  for (const item of raw) {
    const entry = normalizeWordEntry(item);
    if (entry === null) continue;
    const existing = byWord.get(entry.word);
    if (existing === undefined || entry.addedAt >= existing.addedAt) byWord.set(entry.word, entry);
  }
  return [...byWord.values()]
    .sort((a, b) => b.addedAt - a.addedAt || a.word.localeCompare(b.word))
    .slice(0, WORD_MAX);
}

/** 加入/更新生词；返回新数组与是否新增（重复收藏返回 added:false 但时间会更新）。 */
export function upsertWord(
  words: readonly WordEntry[],
  entry: WordEntry,
): { readonly words: readonly WordEntry[]; readonly added: boolean } {
  const exists = words.some((item) => item.word === entry.word);
  const next = [entry, ...words.filter((item) => item.word !== entry.word)];
  return { words: next.slice(0, WORD_MAX), added: !exists };
}

/** 从生词本移除（大小写不敏感）。 */
export function removeWord(words: readonly WordEntry[], rawWord: string): WordEntry[] {
  const word = normalizeWord(rawWord);
  if (word === null) return [...words];
  return words.filter((item) => item.word !== word);
}

/** 是否已收藏。 */
export function hasWord(words: readonly WordEntry[], rawWord: string): boolean {
  const word = normalizeWord(rawWord);
  if (word === null) return false;
  return words.some((item) => item.word === word);
}

/** 归一化历史：word 合法、at 有限数；同词保留最近一次；最新在前；截断上限。 */
export function normalizeHistory(raw: unknown): LookupHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const byWord = new Map<string, LookupHistoryEntry>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const word = normalizeWord(record['word']);
    if (word === null) continue;
    const at = typeof record['at'] === 'number' && Number.isFinite(record['at']) ? record['at'] : 0;
    const existing = byWord.get(word);
    if (existing === undefined || at >= existing.at) byWord.set(word, { word, at });
  }
  return [...byWord.values()]
    .sort((a, b) => b.at - a.at || a.word.localeCompare(b.word))
    .slice(0, HISTORY_MAX);
}

/** 记一次查词：同一个词只留最近一次，最新在前。 */
export function pushHistory(
  history: readonly LookupHistoryEntry[],
  rawWord: string,
  at: number,
): LookupHistoryEntry[] {
  const word = normalizeWord(rawWord);
  if (word === null) return [...history];
  const next = [{ word, at }, ...history.filter((item) => item.word !== word)];
  return next.slice(0, HISTORY_MAX);
}
