import { describe, expect, it } from 'vitest';
import { collapseWhitespace, isWideChar, isWordChar, shortHash, truncate, wordAt } from './text';

describe('shortHash', () => {
  it('相同输入得到相同结果', () => {
    expect(shortHash('hello')).toBe(shortHash('hello'));
  });

  it('不同输入得到不同结果', () => {
    expect(shortHash('hello')).not.toBe(shortHash('hellp'));
  });

  it('返回非负 36 进制字符串', () => {
    for (const s of ['', 'a', '中文', 'x'.repeat(1000)]) {
      const h = shortHash(s);
      expect(h).toMatch(/^[0-9a-z]+$/);
    }
  });

  it('空串也有稳定值（FNV 偏移基数按 36 进制表示）', () => {
    // 0x811c9dc5 === 2166136261，转 36 进制即 ztntfp
    expect(shortHash('')).toBe((0x811c9dc5 >>> 0).toString(36));
    expect(shortHash('')).toBe('ztntfp');
  });
});

describe('truncate', () => {
  it('短于上限时原样返回', () => {
    expect(truncate('abc', 5)).toBe('abc');
  });

  it('等于上限时原样返回', () => {
    expect(truncate('abcde', 5)).toBe('abcde');
  });

  it('超出时截断', () => {
    expect(truncate('abcdef', 3)).toBe('abc');
  });
});

describe('collapseWhitespace', () => {
  it('折叠内部空白并去首尾', () => {
    expect(collapseWhitespace('  a   b\n\tc  ')).toBe('a b c');
  });
});

describe('isWideChar', () => {
  it('识别中文', () => {
    expect(isWideChar('中')).toBe(true);
  });

  it('识别全角标点', () => {
    expect(isWideChar('，')).toBe(true);
  });

  it('不把英文当宽字符', () => {
    expect(isWideChar('a')).toBe(false);
  });
});

describe('isWordChar', () => {
  it('接受字母', () => {
    expect(isWordChar('a')).toBe(true);
    expect(isWordChar('Z')).toBe(true);
  });

  it('接受撇号与连字符', () => {
    expect(isWordChar("'")).toBe(true);
    expect(isWordChar('’')).toBe(true);
    expect(isWordChar('-')).toBe(true);
  });

  it('拒绝中文与空格', () => {
    expect(isWordChar('中')).toBe(false);
    expect(isWordChar(' ')).toBe(false);
    expect(isWordChar('.')).toBe(false);
  });
});

describe('wordAt', () => {
  it('从句子中间取出完整单词', () => {
    expect(wordAt('I love reading books', 8)).toBe('reading');
  });

  it('位置在单词首尾也能取出', () => {
    const text = 'hello world';
    expect(wordAt(text, 0)).toBe('hello');
    expect(wordAt(text, 4)).toBe('hello');
  });

  it('不在单词内时返回 null', () => {
    expect(wordAt('hello world', 5)).toBeNull();
    expect(wordAt('中文内容', 1)).toBeNull();
  });

  it('越界返回 null', () => {
    expect(wordAt('abc', -1)).toBeNull();
    expect(wordAt('abc', 99)).toBeNull();
  });

  it('去掉首尾连字符残片', () => {
    expect(wordAt('-word-', 2)).toBe('word');
  });

  it('保留内部连字符', () => {
    expect(wordAt('well-known fact', 2)).toBe('well-known');
  });
});
