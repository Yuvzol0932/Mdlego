import { describe, expect, it } from 'vitest';
import { captureAnchor, makeBid, QUOTE_MAX, relocate } from './anchors';

describe('makeBid', () => {
  it('相同前缀与序号得到相同 id', () => {
    expect(makeBid('p', '同样的开头', 0)).toBe(makeBid('p', '同样的开头', 0));
  });

  it('序号不同则 id 不同', () => {
    expect(makeBid('p', '同样的开头', 0)).not.toBe(makeBid('p', '同样的开头', 1));
  });

  it('块类型不同则 id 不同', () => {
    expect(makeBid('p', 'abc', 0)).not.toBe(makeBid('li', 'abc', 0));
  });

  it('开头 24 字符相同、之后不同的块得到相同 id（这正是设计意图：小改字不影响锚点）', () => {
    // 必须让两段文字共享同样的前 24 个字符，差异只在第 24 位之后
    const head = '这是一段足够长的中文内容，用来触发前缀截断逻辑的边界条件';
    expect(head.length).toBeGreaterThan(24);
    const a = makeBid('p', head + '，第一种结尾', 0);
    const b = makeBid('p', head + '，第二种结尾', 0);
    expect(a).toBe(b);
  });

  it('短段落整段参与哈希，改字会换 id（短段落本就没有稳定前缀可用）', () => {
    const a = makeBid('p', '短句一', 0);
    const b = makeBid('p', '短句二', 0);
    expect(a).not.toBe(b);
  });

  it('超过 24 字符后才分叉', () => {
    const base = 'x'.repeat(24);
    expect(makeBid('p', base + 'A', 0)).toBe(makeBid('p', base + 'B', 0));
    // 第 25 个字符不同 → 前缀不同 → id 不同
    const short = 'x'.repeat(23);
    expect(makeBid('p', short + 'A', 0)).not.toBe(makeBid('p', short + 'B', 0));
  });

  it('格式可被解析', () => {
    expect(makeBid('h2', '标题', 3)).toMatch(/^h2-[0-9a-z]+-3$/);
  });
});

describe('captureAnchor', () => {
  const text = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  it('保存偏移与原文', () => {
    const a = captureAnchor('p-1', text, 3, 8);
    expect(a.start).toBe(3);
    expect(a.end).toBe(8);
    expect(a.quote).toBe('defgh');
  });

  it('保存前 16 字符上下文', () => {
    const a = captureAnchor('p-1', text, 20, 25);
    expect(a.prefix).toBe(text.slice(4, 20));
    expect(a.prefix.length).toBe(16);
  });

  it('保存后 16 字符上下文', () => {
    const a = captureAnchor('p-1', text, 20, 25);
    expect(a.suffix).toBe(text.slice(25, 41));
    expect(a.suffix.length).toBe(16);
  });

  it('块首时 prefix 为空串而非报错', () => {
    const a = captureAnchor('p-1', text, 0, 3);
    expect(a.prefix).toBe('');
  });

  it('块尾时 suffix 为空串', () => {
    const a = captureAnchor('p-1', text, text.length - 3, text.length);
    expect(a.suffix).toBe('');
  });

  it('quote 被截断到上限', () => {
    const long = 'x'.repeat(500);
    const a = captureAnchor('p-1', long, 0, 500);
    expect(a.quote.length).toBe(QUOTE_MAX);
  });

  it('越界偏移被夹紧而不抛异常', () => {
    const a = captureAnchor('p-1', 'short', -5, 999);
    expect(a.start).toBe(0);
    expect(a.end).toBe(5);
  });

  it('end 小于 start 时被夹紧', () => {
    const a = captureAnchor('p-1', 'abcdef', 4, 2);
    expect(a.start).toBe(4);
    expect(a.end).toBe(4);
  });
});

describe('relocate — 第 1 档：原文未变', () => {
  it('偏移完全吻合时直接返回', () => {
    const blockText = 'The quick brown fox jumps';
    const a = captureAnchor('p-1', blockText, 4, 9);
    const r = relocate(a, blockText);
    expect(r).toEqual({ ok: true, start: 4, end: 9 });
  });
});

describe('relocate — 第 2 档：前后文定位', () => {
  it('在前面插入内容后仍能定位', () => {
    const original = 'The quick brown fox jumps';
    const a = captureAnchor('p-1', original, 4, 9); // "quick"

    const edited = 'NEW PREFIX ADDED The quick brown fox jumps';
    const r = relocate(a, edited);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(edited.slice(r.start, r.end)).toBe('quick');
    }
  });

  it('在后面追加内容后仍能定位', () => {
    const original = 'The quick brown fox';
    const a = captureAnchor('p-1', original, 4, 9);

    const edited = 'The quick brown fox and more text here';
    const r = relocate(a, edited);
    expect(r.ok).toBe(true);
    if (r.ok) expect(edited.slice(r.start, r.end)).toBe('quick');
  });
});

describe('relocate — 第 3 档：仅靠原文', () => {
  it('上下文变化但原文唯一时仍能定位', () => {
    const a = {
      bid: 'p-1',
      start: 0,
      end: 5,
      quote: 'MAGIC',
      prefix: 'old-prefix-here',
      suffix: 'old-suffix-here',
    };
    const edited = 'totally different MAGIC in the middle';
    const r = relocate(a, edited);
    expect(r.ok).toBe(true);
    if (r.ok) expect(edited.slice(r.start, r.end)).toBe('MAGIC');
  });
});

describe('relocate — 失败必须显式', () => {
  it('原文被删除时返回 quote-missing', () => {
    const a = captureAnchor('p-1', 'The quick brown fox', 4, 9);
    const r = relocate(a, '完全没有这段内容了');
    expect(r).toEqual({ ok: false, reason: 'quote-missing' });
  });

  it('原文出现多次且上下文无助于区分时返回 ambiguous，绝不猜', () => {
    // 构造「原偏移处已不匹配 + 前后文失配 + 原文多处出现」的场景
    const edited = 'apple and apple and apple';
    const a = {
      bid: 'p-1',
      start: 1,
      end: 6,
      quote: 'apple',
      prefix: 'zzz',
      suffix: 'yyy',
    };
    // 第 1 档：slice(1,6) === 'pple ' ≠ 'apple'，跳过
    // 第 2 档：'zzzappleyyy' 不存在，跳过
    // 第 3 档：'apple' 出现 3 次 → ambiguous
    expect(relocate(a, edited)).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('原偏移处仍然吻合时优先采用原位置（第 1 档优先于其余两档）', () => {
    const a = {
      bid: 'p-1',
      start: 0,
      end: 5,
      quote: 'apple',
      prefix: 'zzz',
      suffix: 'yyy',
    };
    const edited = 'apple and apple and apple';
    expect(relocate(a, edited)).toEqual({ ok: true, start: 0, end: 5 });
  });

  it('quote 为空时视为无法定位', () => {
    const a = { bid: 'p-1', start: 0, end: 0, quote: '', prefix: '', suffix: '' };
    expect(relocate(a, 'anything')).toEqual({ ok: false, reason: 'quote-missing' });
  });
});

describe('relocate — 小改动不破坏锚点', () => {
  it('同段落改一个字后，标注仍落在原词上', () => {
    const original = 'I love reading books every single day';
    const a = captureAnchor('p-1', original, 7, 14); // "reading"

    // 只在末尾把 day 改成 week
    const edited = 'I love reading books every single week';
    const r = relocate(a, edited);
    expect(r.ok).toBe(true);
    if (r.ok) expect(edited.slice(r.start, r.end)).toBe('reading');
  });
});
