/**
 * 生词本与查词历史单测（阶段 E4）。
 *
 * 验归一化/去重/上限/排序与「不修改输入」，这些规则同时被
 * 备份恢复（schemaVersion 2 的 vocabulary 字段）复用。
 */

import { describe, expect, it } from 'vitest';
import {
  HISTORY_MAX,
  WORD_MAX,
  hasWord,
  normalizeHistory,
  normalizeWord,
  normalizeWordEntry,
  normalizeWords,
  pushHistory,
  removeWord,
  upsertWord,
} from './vocabulary';

function letterWord(index: number): string {
  // 生成纯字母单词：w + base26，保证 normalizeWord 通过
  let n = index;
  let suffix = '';
  do {
    suffix = String.fromCharCode(97 + (n % 26)) + suffix;
    n = Math.floor(n / 26);
  } while (n > 0);
  return `w${suffix}`;
}

function entry(word: string, addedAt: number, translation = '"释义"') {
  return { word, phonetic: '', translation, addedAt };
}

describe('单词归一化', () => {
  it('去空白、转小写；非法字符/长度返回 null', () => {
    expect(normalizeWord('  Inspect  ')).toBe('inspect');
    expect(normalizeWord("don't")).toBe("don't");
    expect(normalizeWord('well-known')).toBe('well-known');
    expect(normalizeWord('中文')).toBeNull();
    expect(normalizeWord('a')).toBeNull();
    expect(normalizeWord('x'.repeat(70))).toBeNull();
    expect(normalizeWord(42)).toBeNull();
  });

  it('词条缺释义/非法 word 被拒绝', () => {
    expect(normalizeWordEntry(entry('inspect', 1))).toMatchObject({ word: 'inspect' });
    expect(normalizeWordEntry({ word: 'inspect', translation: '  ' })).toBeNull();
    expect(normalizeWordEntry({ word: '中文', translation: '检查' })).toBeNull();
    expect(normalizeWordEntry(null)).toBeNull();
  });
});

describe('生词本', () => {
  it('归一化去重（同词保留最新）、按收藏时间倒序、截断上限', () => {
    const list = normalizeWords([entry('inspect', 1), entry('Inspect', 5), entry('prospect', 3)]);
    expect(list.map((item) => item.word)).toEqual(['inspect', 'prospect']);
    expect(list[0]?.addedAt).toBe(5);
    const many = Array.from({ length: WORD_MAX + 5 }, (_, i) => entry(letterWord(i), i));
    expect(normalizeWords(many)).toHaveLength(WORD_MAX);
  });

  it('加入生词：新增在首位、added 标记正确、重复收藏更新时间不重复占位', () => {
    const first = upsertWord([], entry('inspect', 1));
    expect(first.added).toBe(true);
    expect(first.words).toHaveLength(1);
    const again = upsertWord(first.words, entry('inspect', 9));
    expect(again.added).toBe(false);
    expect(again.words).toHaveLength(1);
    expect(again.words[0]?.addedAt).toBe(9);
  });

  it('移除与查询大小写不敏感，不修改输入', () => {
    const words = [entry('inspect', 1), entry('prospect', 2)];
    const snapshot = [...words];
    expect(hasWord(words, 'INSPECT')).toBe(true);
    expect(hasWord(words, 'spect')).toBe(false);
    expect(removeWord(words, 'Inspect').map((item) => item.word)).toEqual(['prospect']);
    expect(words).toEqual(snapshot);
  });
});

describe('查词历史', () => {
  it('同词只留最近一次，最新在前，截断上限', () => {
    let history = pushHistory([], 'inspect', 1);
    history = pushHistory(history, 'prospect', 2);
    history = pushHistory(history, 'inspect', 3);
    expect(history).toEqual([
      { word: 'inspect', at: 3 },
      { word: 'prospect', at: 2 },
    ]);
    const many = Array.from({ length: HISTORY_MAX + 10 }, (_, i) => ({ word: letterWord(i), at: i }));
    expect(normalizeHistory(many)).toHaveLength(HISTORY_MAX);
  });

  it('非法词/词条被丢弃', () => {
    expect(pushHistory([], '中', 1)).toEqual([]);
    expect(normalizeHistory([{ word: 'inspect', at: 1 }, null, { word: 'x', at: 2 }])).toEqual([
      { word: 'inspect', at: 1 },
    ]);
  });
});
