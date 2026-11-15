import { describe, expect, it } from 'vitest';
import { lemmaCandidates } from './lemma';

describe('lemmaCandidates', () => {
  it('复数 -ies 还原成 -y', () => {
    expect(lemmaCandidates('studies')[0]).toBe('study');
  });

  it('复数 -es 先去 es 再留 e', () => {
    expect(lemmaCandidates('boxes')).toContain('box');
    expect(lemmaCandidates('closes')).toContain('close');
  });

  it('复数 -s 直接去 s', () => {
    expect(lemmaCandidates('prospects')).toContain('prospect');
  });

  it('ss 结尾不去 s', () => {
    expect(lemmaCandidates('glass')).not.toContain('glas');
  });

  it('过去式 -ed 去 ed', () => {
    expect(lemmaCandidates('looked')).toContain('look');
  });

  it('过去式 -d 补出词尾 e（liked → like）', () => {
    expect(lemmaCandidates('liked')).toContain('like');
  });

  it('双写辅音还原（stopped → stop）', () => {
    expect(lemmaCandidates('stopped')).toContain('stop');
  });

  it('过去式 -ied 还原成 -y', () => {
    expect(lemmaCandidates('carried')).toContain('carry');
  });

  it('现在分词 -ing 去 ing', () => {
    expect(lemmaCandidates('looking')).toContain('look');
  });

  it('现在分词双写辅音还原（running → run）', () => {
    expect(lemmaCandidates('running')).toContain('run');
  });

  it('现在分词补 e（making → make）', () => {
    expect(lemmaCandidates('making')).toContain('make');
  });

  it('比较级与最高级还原成 -y', () => {
    expect(lemmaCandidates('happier')).toContain('happy');
    expect(lemmaCandidates('happiest')).toContain('happy');
  });

  it('-er / -est 去后缀', () => {
    expect(lemmaCandidates('worker')).toContain('work');
    expect(lemmaCandidates('highest')).toContain('high');
  });

  it('派生词缀只去一层', () => {
    expect(lemmaCandidates('quickly')).toContain('quick');
    expect(lemmaCandidates('darkness')).toContain('dark');
    expect(lemmaCandidates('movement')).toContain('move');
  });

  it('真实用例：persistences 能给出 persistence', () => {
    // 方案 §6.2 第 12 个词，上游实测精确查不到，必须走 lemma/规则
    expect(lemmaCandidates('persistences')).toContain('persistence');
  });

  it('规则猜不出的词不硬凑（teeth / gave）', () => {
    expect(lemmaCandidates('teeth')).toEqual([]);
    expect(lemmaCandidates('gave').length).toBeLessThan(3);
  });

  it('中文、连字符词、撇号词一律不管', () => {
    expect(lemmaCandidates('中文')).toEqual([]);
    expect(lemmaCandidates('well-known')).toEqual([]);
    expect(lemmaCandidates("don't")).toEqual([]);
  });

  it('太短的词不跑规则', () => {
    expect(lemmaCandidates('as')).toEqual([]);
    expect(lemmaCandidates('the')).toEqual([]);
  });

  it('候选去重、不含自身、不超过 5 个', () => {
    for (const word of ['persistences', 'happiest', 'considered', 'organizations']) {
      const out = lemmaCandidates(word);
      expect(out.length).toBeLessThanOrEqual(5);
      expect(new Set(out).size).toBe(out.length);
      expect(out).not.toContain(word);
    }
  });

  it('大小写不敏感', () => {
    expect(lemmaCandidates('Studies')).toEqual(lemmaCandidates('studies'));
  });
});
