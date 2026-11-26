import { afterEach, describe, expect, it } from 'vitest';
import type { DictEntry } from '../core/types';
import {
  clearDictCache,
  lookup,
  normalizeWord,
  parseLemma,
  parseShard,
  setDictLoaders,
  shardKeyOf,
} from './dict';

/** 词库文件里用「字面量反斜杠 + n」表示换行，测试里用常量拼，避免转义看不明白。 */
const LITERAL_NEWLINE = '\\n';

/** 造一个内存分片加载器，把「词 → 释义」直接喂进去，不碰网络。 */
function loaderFrom(
  entries: ReadonlyArray<[string, string, string]>,
  lemma: ReadonlyArray<[string, string]>,
) {
  const shards = new Map<string, Map<string, DictEntry>>();
  for (const [word, phonetic, translation] of entries) {
    const key = shardKeyOf(word);
    const shard = shards.get(key) ?? new Map<string, DictEntry>();
    shard.set(normalizeWord(word), { word, phonetic, translation });
    shards.set(key, shard);
  }
  const lemmaMap = new Map<string, string>();
  for (const [form, base] of lemma) lemmaMap.set(normalizeWord(form), base);

  setDictLoaders({
    shard: (key) => Promise.resolve(shards.get(key) ?? new Map<string, DictEntry>()),
    lemma: () => Promise.resolve(lemmaMap),
  });
}

afterEach(() => {
  setDictLoaders({ shard: null, lemma: null });
  clearDictCache();
});

describe('normalizeWord', () => {
  it('小写化并去掉首尾连字符与撇号', () => {
    expect(normalizeWord('  Prospect ')).toBe('prospect');
    expect(normalizeWord('-word-')).toBe('word');
    expect(normalizeWord("'quoted'")).toBe('quoted');
  });

  it('保留内部连字符与撇号', () => {
    expect(normalizeWord('well-known')).toBe('well-known');
    expect(normalizeWord("don't")).toBe("don't");
  });
});

describe('shardKeyOf', () => {
  it('取小写前两个字符', () => {
    expect(shardKeyOf('Prospect')).toBe('pr');
  });

  it('不足两个字符归 _ 组', () => {
    expect(shardKeyOf('a')).toBe('_');
  });
});

describe('parseShard', () => {
  it('按三列切分，并把字面量反斜杠 n 还原成真换行', () => {
    const line = ['prospect', "'prɒspekt", 'n. 景色' + LITERAL_NEWLINE + 'vt. 勘探'].join('\t') + '\n';
    const map = parseShard(line);
    expect(map.get('prospect')).toEqual({
      word: 'prospect',
      phonetic: "'prɒspekt",
      translation: 'n. 景色\nvt. 勘探',
    });
  });

  it('跳过空行与列数不足的行', () => {
    expect(parseShard('\nbroken-line\nok\t\t释义量\n').size).toBe(1);
  });

  it('键小写化，值保留原词形', () => {
    const map = parseShard('China\t\t中国\n');
    expect(map.get('china')?.word).toBe('China');
  });
});

describe('parseLemma', () => {
  it('解析 变形词 → 原形', () => {
    const map = parseLemma('prospects\tprospect\n');
    expect(map.get('prospects')).toBe('prospect');
  });

  it('跳过坏行', () => {
    expect(parseLemma('broken\n\t\nok\tbase\n').size).toBe(1);
  });
});

describe('lookup', () => {
  it('精确命中返回 exact', async () => {
    loaderFrom([['prospect', "'prɒspekt", 'n. 景色']], []);
    const result = await lookup('Prospect');
    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.matchedBy).toBe('exact');
      expect(result.entry.translation).toBe('n. 景色');
    }
  });

  it('精确命中但自身缺音标时，顺带补回原形词的音标（如 careers → career）', async () => {
    loaderFrom(
      [
        ['careers', '', 'n. 职业生涯（career的复数）'],
        ['career', "kә'riә", 'n. 事业'],
      ],
      [['careers', 'career']],
    );
    const result = await lookup('careers');
    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.matchedBy).toBe('exact');
      expect(result.lemmaOf).toBe('career');
      expect(result.lemmaPhonetic).toBe("kә'riә");
    }
  });

  it('精确查不到时走 lemma 索引，matchedBy 为 lemma', async () => {
    loaderFrom([['persistence', '', 'n. 坚持']], [['persistences', 'persistence']]);
    const result = await lookup('persistences');
    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.matchedBy).toBe('lemma');
      expect(result.entry.word).toBe('persistence');
    }
  });

  it('lemma 索引也没有时走后缀规则', async () => {
    loaderFrom([['persistence', '', 'n. 坚持']], []);
    const result = await lookup('persistences');
    expect(result.hit).toBe(true);
    if (result.hit) {
      expect(result.matchedBy).toBe('lemma');
      expect(result.entry.word).toBe('persistence');
    }
  });

  it('全都查不到返回 hit:false（不抛错）', async () => {
    loaderFrom([], []);
    await expect(lookup('skibidi')).resolves.toEqual({ hit: false });
  });

  it('空串与非单词直接返回 hit:false', async () => {
    loaderFrom([], []);
    await expect(lookup('')).resolves.toEqual({ hit: false });
    await expect(lookup('---')).resolves.toEqual({ hit: false });
  });

  it('分片读失败按查不到处理，不把异常抛给调用方', async () => {
    setDictLoaders({
      shard: () => Promise.reject(new Error('boom')),
      lemma: () => Promise.resolve(new Map()),
    });
    await expect(lookup('prospect')).resolves.toEqual({ hit: false });
  });

  it('同一个分片只加载一次（并发与串行都复用缓存）', async () => {
    let calls = 0;
    setDictLoaders({
      shard: () => {
        calls += 1;
        return Promise.resolve(
          new Map([['prospect', { word: 'prospect', phonetic: '', translation: 'n. 前景' }]]),
        );
      },
      lemma: () => Promise.resolve(new Map()),
    });
    await Promise.all([lookup('prospect'), lookup('prospect'), lookup('prospect')]);
    await lookup('prospect');
    expect(calls).toBe(1);
  });
});
