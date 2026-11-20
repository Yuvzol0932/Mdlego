import { describe, expect, it } from 'vitest';
import {
  BUILTIN_BANNERS,
  BUILTIN_QUOTES,
  DEFAULT_QUOTES,
  QUOTES_MAX_COUNT,
  QUOTE_MAX_LEN,
  createShuffleBag,
  nextFromShuffleBag,
  normalizeQuotes,
} from './quotes';

describe('横幅语录与风景库', () => {
  it('内置名言非空、带作者、长度受控且无重复', () => {
    expect(BUILTIN_QUOTES.length).toBeGreaterThanOrEqual(30);
    expect(DEFAULT_QUOTES.length).toBe(BUILTIN_QUOTES.length);
    const seen = new Set<string>();
    for (const q of BUILTIN_QUOTES) {
      expect(q.text.trim().length).toBeGreaterThan(0);
      expect(q.author.trim().length).toBeGreaterThan(0);
      expect(q.text.length).toBeLessThanOrEqual(QUOTE_MAX_LEN);
      expect(seen.has(q.text)).toBe(false);
      seen.add(q.text);
    }
  });

  it('内置风景图清单非空且路径合法', () => {
    expect(BUILTIN_BANNERS.length).toBe(8);
    for (const b of BUILTIN_BANNERS) {
      expect(b.id.length).toBeGreaterThan(0);
      expect(b.title.length).toBeGreaterThan(0);
      expect(b.src).toMatch(/^banners\/\d{2}\.webp$/);
    }
  });

  it('洗牌循环：一轮内覆盖全部索引且不重复，跨轮首尾不撞车', () => {
    let seed = 1;
    const rng = (): number => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    const count = 8;
    let bag = createShuffleBag(count, rng);
    const round1: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const res = nextFromShuffleBag(bag, count, rng);
      round1.push(res.index);
      bag = res.next;
    }
    expect(new Set(round1).size).toBe(count);

    const round2First = nextFromShuffleBag(bag, count, rng);
    expect(round2First.index).not.toBe(round1[round1.length - 1]);
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
