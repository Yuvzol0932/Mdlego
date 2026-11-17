import { describe, expect, it } from 'vitest';
import { DEFAULT_QUOTES, normalizeQuotes, QUOTES_MAX_COUNT, QUOTE_MAX_LEN } from './quotes';

describe('横幅语录', () => {
  it('内置默认语录非空且长度受控', () => {
    expect(DEFAULT_QUOTES.length).toBeGreaterThanOrEqual(1);
    for (const q of DEFAULT_QUOTES) {
      expect(q.trim().length).toBeGreaterThan(0);
      expect(q.length).toBeLessThanOrEqual(QUOTE_MAX_LEN);
    }
  });

  it('非数组 / 垃圾输入 → 空数组（表示用内置默认）', () => {
    expect(normalizeQuotes(undefined)).toEqual([]);
    expect(normalizeQuotes('读书')).toEqual([]);
    expect(normalizeQuotes({ 0: '读书' })).toEqual([]);
  });

  it('去空白、压缩连续空白、丢弃空行与非字符串', () => {
    expect(normalizeQuotes(['  读书   让人自由  ', '', '   ', 42, null, '第二条'])).toEqual([
      '读书 让人自由',
      '第二条',
    ]);
  });

  it('按原文去重，超长截断到 60 字', () => {
    const long = '字'.repeat(QUOTE_MAX_LEN + 20);
    const out = normalizeQuotes(['同一句', '同一句', long]);
    expect(out).toHaveLength(2);
    expect(out[1]).toHaveLength(QUOTE_MAX_LEN);
  });

  it('条数上限', () => {
    const many = Array.from({ length: QUOTES_MAX_COUNT + 10 }, (_, i) => `第 ${i} 句`);
    expect(normalizeQuotes(many)).toHaveLength(QUOTES_MAX_COUNT);
  });
});
