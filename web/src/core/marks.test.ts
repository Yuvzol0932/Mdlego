import { describe, expect, it } from 'vitest';
import { captureAnchor, QUOTE_MAX } from './anchors';
import {
  buildMark,
  markLabel,
  marksForDoc,
  marksToMarkdown,
  orderMarks,
  relocateMarks,
} from './marks';
import type { Anchor, Mark } from './types';

const NOW = 1_700_000_000_000;

/** 取数组首元素并断言存在（noUncheckedIndexedAccess 下让测试读起来干净些）。 */
function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error('期望数组至少有一个元素');
  return item;
}

/** 构造一条标注；默认黄色高亮、无备注。 */
function makeMark(
  id: string,
  anchor: Anchor,
  extra: Partial<Pick<Mark, 'docId' | 'type' | 'color' | 'note' | 'createdAt'>> = {},
): Mark {
  return {
    id,
    docId: extra.docId ?? 'doc-1',
    anchor,
    type: extra.type ?? 'highlight',
    color: extra.color === undefined ? 'yellow' : extra.color,
    note: extra.note ?? null,
    createdAt: extra.createdAt ?? NOW,
  };
}

describe('relocateMarks — 偏移未变', () => {
  it('原文仍在原偏移时保持原对象引用', () => {
    const text = 'The quick brown fox jumps';
    const mark = makeMark('m1', captureAnchor('p-1', text, 4, 9));

    const result = relocateMarks([mark], new Map([['p-1', text]]));

    expect(result.marks).toHaveLength(1);
    expect(result.marks[0]).toBe(mark);
    expect(result.changed).toEqual([]);
    expect(result.orphans).toEqual([]);
  });
});

describe('relocateMarks — 偏移变化', () => {
  it('偏移变化时生成新对象并重算 quote/prefix/suffix', () => {
    const original = 'The quick brown fox jumps';
    const mark = makeMark('m1', captureAnchor('p-1', original, 4, 9)); // "quick"

    const edited = 'NEW The quick brown fox jumps';
    const result = relocateMarks([mark], new Map([['p-1', edited]]));

    expect(result.changed).toHaveLength(1);
    expect(result.orphans).toEqual([]);

    const changed = first(result.changed);
    expect(changed).not.toBe(mark);
    expect(result.marks[0]).toBe(changed);
    expect(changed.anchor.start).toBe(8);
    expect(changed.anchor.end).toBe(13);
    expect(changed.anchor.quote).toBe('quick');
    expect(changed.anchor.prefix).toBe('NEW The ');
    expect(changed.anchor.suffix).toBe(' brown fox jumps');

    // 输入对象本身不被修改
    expect(mark.anchor.start).toBe(4);
    expect(mark.anchor.end).toBe(9);
  });
});

describe('relocateMarks — 失效', () => {
  it('块不存在时进入 orphans，marks 保留原对象', () => {
    const mark = makeMark('m1', captureAnchor('gone', 'Some text here', 0, 4));

    const result = relocateMarks([mark], new Map([['p-1', 'Some text here']]));

    expect(result.orphans).toEqual([mark]);
    expect(result.changed).toEqual([]);
    expect(result.marks[0]).toBe(mark);
  });

  it('原文多处出现且上下文失配时进入 orphans，绝不猜测位置', () => {
    // 第 1 档：slice(1,6) = "pple " ≠ "apple"；第 2 档：组合串不存在；第 3 档：3 处 → ambiguous
    const anchor: Anchor = {
      bid: 'p-1',
      start: 1,
      end: 6,
      quote: 'apple',
      prefix: 'zzz',
      suffix: 'yyy',
    };
    const mark = makeMark('m1', anchor);

    const result = relocateMarks([mark], new Map([['p-1', 'apple and apple and apple']]));

    expect(result.orphans).toEqual([mark]);
    expect(result.changed).toEqual([]);
    expect(result.marks[0]).toBe(mark);
    // 失效时锚点保持原样，不做任何改写
    expect(mark.anchor).toEqual(anchor);
  });

  it('quote 为空时视为无法定位，进入 orphans', () => {
    const mark = makeMark('m1', { bid: 'p-1', start: 0, end: 0, quote: '', prefix: '', suffix: '' });

    const result = relocateMarks([mark], new Map([['p-1', 'anything']]));

    expect(result.orphans).toEqual([mark]);
  });
});

describe('relocateMarks — 批量与不可变性', () => {
  it('空输入返回三个空数组', () => {
    const result = relocateMarks([], new Map([['p-1', 'text']]));
    expect(result).toEqual({ marks: [], changed: [], orphans: [] });
  });

  it('混合场景下 marks 顺序与输入一致，changed/orphans 各自保序', () => {
    const missing = makeMark('m-missing', captureAnchor('deleted-block', 'word here', 0, 4));
    const unchanged = makeMark('m-same', captureAnchor('p-1', 'Same text forever', 0, 4));
    const shifted = makeMark('m-moved', captureAnchor('p-2', 'The cat sat on the mat', 4, 7)); // "cat"

    const result = relocateMarks(
      [missing, unchanged, shifted],
      new Map([
        ['p-1', 'Same text forever'],
        ['p-2', 'NEW The cat sat on the mat'],
      ]),
    );

    expect(result.marks).toHaveLength(3);
    expect(result.marks[0]).toBe(missing);
    expect(result.marks[1]).toBe(unchanged);
    expect(result.marks[2]).toBe(first(result.changed));
    expect(result.orphans).toEqual([missing]);
    expect(result.changed).toHaveLength(1);
    expect(first(result.changed).id).toBe('m-moved');
    expect(first(result.changed).anchor.start).toBe(8);
  });

  it('不修改输入数组与其中的标注对象', () => {
    const text = 'abcdef';
    const a = makeMark('a', captureAnchor('p-1', text, 0, 2));
    const b = makeMark('b', captureAnchor('p-1', text, 2, 4));
    const input = Object.freeze([a, b]) as readonly Mark[];

    const result = relocateMarks(input, new Map([['p-1', 'XXabcdef']]));

    expect(input).toHaveLength(2);
    expect(input[0]).toBe(a);
    expect(a.anchor.start).toBe(0);
    expect(first(result.changed).anchor.start).toBe(2);
  });
});

describe('marksForDoc', () => {
  it('只保留目标文档的标注，且保持原有顺序', () => {
    const a = makeMark('a', captureAnchor('p-1', 'x', 0, 1), { docId: 'doc-1' });
    const b = makeMark('b', captureAnchor('p-1', 'x', 0, 1), { docId: 'doc-2' });
    const c = makeMark('c', captureAnchor('p-1', 'x', 0, 1), { docId: 'doc-1' });

    const result = marksForDoc([a, b, c], 'doc-1');

    expect(result).toEqual([a, c]);
    expect(result[0]).toBe(a);
  });

  it('没有匹配文档时返回空数组', () => {
    expect(marksForDoc([makeMark('a', captureAnchor('p-1', 'x', 0, 1))], 'doc-9')).toEqual([]);
  });
});

describe('orderMarks', () => {
  it('按 blockTexts 里的块顺序排列（与输入顺序无关）', () => {
    const blockTexts = new Map([
      ['b1', '第一块'],
      ['b2', '第二块'],
    ]);
    const inB2 = makeMark('m2', captureAnchor('b2', '第二块', 0, 1));
    const inB1 = makeMark('m1', captureAnchor('b1', '第一块', 2, 3));

    const result = orderMarks([inB2, inB1], blockTexts);

    expect(result).toEqual([inB1, inB2]);
  });

  it('同一块内按 start 升序', () => {
    const blockTexts = new Map([['b1', 'abcdefghij']]);
    const later = makeMark('later', captureAnchor('b1', 'abcdefghij', 6, 8));
    const earlier = makeMark('earlier', captureAnchor('b1', 'abcdefghij', 1, 3));

    const result = orderMarks([later, earlier], blockTexts);

    expect(result.map((m) => m.id)).toEqual(['earlier', 'later']);
  });

  it('blockTexts 中没有的块排最后，缺失块之间按块 id 稳定排序', () => {
    const blockTexts = new Map([['b1', '已知块']]);
    const known = makeMark('known', captureAnchor('b1', '已知块', 0, 1));
    const missingZ = makeMark('missing-z', captureAnchor('z-block', 'zzz', 0, 1));
    const missingA = makeMark('missing-a', captureAnchor('a-block', 'aaa', 0, 1));

    const result = orderMarks([missingZ, known, missingA], blockTexts);

    expect(result.map((m) => m.id)).toEqual(['known', 'missing-a', 'missing-z']);
  });

  it('排序键完全相同时保持输入顺序（稳定排序）', () => {
    const blockTexts = new Map([['b1', 'abcdef']]);
    const a = makeMark('a', captureAnchor('b1', 'abcdef', 1, 3));
    const b = makeMark('b', captureAnchor('b1', 'abcdef', 1, 3));

    expect(orderMarks([a, b], blockTexts).map((m) => m.id)).toEqual(['a', 'b']);
    expect(orderMarks([b, a], blockTexts).map((m) => m.id)).toEqual(['b', 'a']);
  });
});

describe('buildMark', () => {
  it('用 captureAnchor 生成锚点并保留其余字段', () => {
    const mark = buildMark({
      id: 'm1',
      docId: 'doc-1',
      bid: 'p-1',
      blockText: 'The quick brown fox',
      start: 4,
      end: 9,
      type: 'highlight',
      color: 'green',
      note: '记一笔',
      createdAt: NOW,
    });

    expect(mark).toEqual({
      id: 'm1',
      docId: 'doc-1',
      anchor: {
        bid: 'p-1',
        start: 4,
        end: 9,
        quote: 'quick',
        prefix: 'The ',
        suffix: ' brown fox',
      },
      type: 'highlight',
      color: 'green',
      note: '记一笔',
      createdAt: NOW,
    });
  });

  it('start/end 越界时被夹到合法范围', () => {
    const mark = buildMark({
      id: 'm1',
      docId: 'doc-1',
      bid: 'p-1',
      blockText: 'abcdef',
      start: -5,
      end: 999,
      type: 'underline',
      color: null,
      note: null,
      createdAt: NOW,
    });

    expect(mark.anchor.start).toBe(0);
    expect(mark.anchor.end).toBe(6);
    expect(mark.anchor.quote).toBe('abcdef');
  });

  it('end 小于 start 时夹成空区间而不抛异常', () => {
    const mark = buildMark({
      id: 'm1',
      docId: 'doc-1',
      bid: 'p-1',
      blockText: 'abcdef',
      start: 4,
      end: 2,
      type: 'strike',
      color: null,
      note: null,
      createdAt: NOW,
    });

    expect(mark.anchor.start).toBe(4);
    expect(mark.anchor.end).toBe(4);
    expect(mark.anchor.quote).toBe('');
  });

  it('quote 被截断到 QUOTE_MAX（80 字符）', () => {
    const blockText = 'x'.repeat(200);
    const mark = buildMark({
      id: 'm1',
      docId: 'doc-1',
      bid: 'p-1',
      blockText,
      start: 0,
      end: 200,
      type: 'note',
      color: null,
      note: '长选区',
      createdAt: NOW,
    });

    expect(mark.anchor.quote.length).toBe(QUOTE_MAX);
    expect(QUOTE_MAX).toBe(80);
  });
});

describe('markLabel', () => {
  it('四种高亮按颜色给出不同中文名', () => {
    expect(markLabel('highlight', 'yellow')).toBe('黄色高亮');
    expect(markLabel('highlight', 'green')).toBe('绿色高亮');
    expect(markLabel('highlight', 'blue')).toBe('蓝色高亮');
    expect(markLabel('highlight', 'pink')).toBe('粉色高亮');
  });

  it('下划线 / 删除线 / 批注与颜色无关', () => {
    expect(markLabel('underline', null)).toBe('下划线');
    expect(markLabel('underline', 'blue')).toBe('下划线');
    expect(markLabel('strike', null)).toBe('删除线');
    expect(markLabel('strike', 'pink')).toBe('删除线');
    expect(markLabel('note', null)).toBe('批注');
    expect(markLabel('note', 'yellow')).toBe('批注');
  });

  it('高亮缺少颜色时退化为「高亮」而不是崩溃', () => {
    expect(markLabel('highlight', null)).toBe('高亮');
  });
});

describe('marksToMarkdown — 固定格式', () => {
  it('输出标题、条数、类型前缀与缩进备注行', () => {
    const blockTexts = new Map([
      ['b1', '这是重点内容'],
      ['b2', '另一处文字'],
    ]);
    const highlighted = makeMark(
      'm1',
      { bid: 'b1', start: 2, end: 4, quote: '重点', prefix: '这是', suffix: '内容' },
      { type: 'highlight', color: 'yellow', note: '这是一条备注' },
    );
    const underlined = makeMark(
      'm2',
      { bid: 'b2', start: 0, end: 3, quote: '另一处', prefix: '', suffix: '文字' },
      { type: 'underline', color: null },
    );

    const md = marksToMarkdown('深度工作', [highlighted, underlined], blockTexts);

    expect(md).toBe(
      '# 深度工作 · 批注（2 条）\n' +
        '\n' +
        '- [黄色高亮] 重点\n' +
        '  - 备注：这是一条备注\n' +
        '- [下划线] 另一处\n',
    );
  });

  it('没有标注时只输出标题行（0 条）', () => {
    expect(marksToMarkdown('空文档', [], new Map())).toBe('# 空文档 · 批注（0 条）\n');
  });

  it('标题为空或纯空白时用「未命名文档」', () => {
    expect(marksToMarkdown('', [], new Map())).toBe('# 未命名文档 · 批注（0 条）\n');
    expect(marksToMarkdown('   ', [], new Map())).toBe('# 未命名文档 · 批注（0 条）\n');
  });

  it('orphanIds 里的条目标「失效」', () => {
    const mark = makeMark('m1', { bid: 'b1', start: 0, end: 2, quote: '原文', prefix: '', suffix: '' });

    const md = marksToMarkdown('标题', [mark], new Map([['b1', '原文']]), new Set(['m1']));

    expect(md).toBe('# 标题 · 批注（1 条）\n\n- [失效] 原文\n');
    // 失效条目的备注仍然保留
    const withNote = makeMark(
      'm1',
      { bid: 'b1', start: 0, end: 2, quote: '原文', prefix: '', suffix: '' },
      { note: '仍要导出' },
    );
    expect(marksToMarkdown('标题', [withNote], new Map([['b1', '原文']]), new Set(['m1']))).toContain(
      '  - 备注：仍要导出',
    );
  });

  it('原文里的换行被压成空格', () => {
    const mark = makeMark('m1', {
      bid: 'b1',
      start: 0,
      end: 7,
      quote: '第一行\n第二行',
      prefix: '',
      suffix: '',
    });

    const md = marksToMarkdown('标题', [mark], new Map([['b1', '第一行\n第二行']]));

    expect(md).toContain('- [黄色高亮] 第一行 第二行');
    expect(md).not.toContain('第一行\n第二行');
  });

  it('按正文顺序导出，而不是按输入顺序', () => {
    const blockTexts = new Map([
      ['b1', '前面的块'],
      ['b2', '后面的块'],
    ]);
    const later = makeMark('m2', { bid: 'b2', start: 0, end: 2, quote: '后面', prefix: '', suffix: '' });
    const earlier = makeMark('m1', { bid: 'b1', start: 0, end: 2, quote: '前面', prefix: '', suffix: '' });

    const md = marksToMarkdown('标题', [later, earlier], blockTexts);

    expect(md.indexOf('[黄色高亮] 前面')).toBeLessThan(md.indexOf('[黄色高亮] 后面'));
  });

  it('不转义引号与反引号（给人看的导出，不是再解析）', () => {
    const quote = '他说“别用 `rm -rf`”';
    const mark = makeMark('m1', { bid: 'b1', start: 0, end: quote.length, quote, prefix: '', suffix: '' });

    const md = marksToMarkdown('标题', [mark], new Map([['b1', quote]]));

    expect(md).toContain(`- [黄色高亮] ${quote}`);
    expect(md).not.toContain('\\`');
    expect(md).not.toContain('\\"');
  });
});
