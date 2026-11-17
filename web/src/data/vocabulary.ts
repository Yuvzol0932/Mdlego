/**
 * 生词本 / 查词历史的持久化（阶段 E4，data 层 IO）。
 *
 * 存 meta 的 `wordbook` / `lookupHistory` 两个键（JSON 数组），
 * 读取时一律走 core/vocabulary.ts 的归一化，写回前同样归一化，
 * 保证 localStorage/IndexedDB 里不会留下脏数据。
 */

import { normalizeHistory, normalizeWords, type LookupHistoryEntry, type WordEntry } from '../core/vocabulary';
import { getMeta, setMeta } from './db';

export interface VocabularySnapshot {
  readonly words: readonly WordEntry[];
  readonly history: readonly LookupHistoryEntry[];
}

/** 读取生词本与查词历史（脏数据会被过滤而不是抛错）。 */
export async function loadVocabulary(): Promise<VocabularySnapshot> {
  const [rawWords, rawHistory] = await Promise.all([getMeta('wordbook'), getMeta('lookupHistory')]);
  return { words: normalizeWords(rawWords), history: normalizeHistory(rawHistory) };
}

/** 写回生词本（写前归一化）。 */
export async function saveWordbook(words: readonly WordEntry[]): Promise<void> {
  await setMeta('wordbook', normalizeWords(words));
}

/** 写回查词历史（写前归一化）。 */
export async function saveLookupHistory(history: readonly LookupHistoryEntry[]): Promise<void> {
  await setMeta('lookupHistory', normalizeHistory(history));
}
