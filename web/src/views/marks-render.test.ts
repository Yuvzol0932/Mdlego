// @vitest-environment jsdom
/**
 * 标注渲染层测试（阶段 E2）。
 *
 * 验的是四件容易悄悄坏掉的事：
 *  - 归一化索引与 `core/text.ts::collapseWhitespace` 逐字一致，且每个下标都能回到原文位置；
 *  - 分组绘制与失效审计：越界/缺块的标注只进 orphanIds，不画、不计数；
 *  - 坐标命中：caretRangeFromPoint → 块内归一化偏移 → 覆盖该位置的标注（后渲染优先）；
 *  - 降级：系统不支持 CSS Highlight API 且没注入 sink 时如实返回 supported:false，不抛错、不伪造。
 *
 * jsdom 没有 `CSS.highlights` / `Highlight` / `caretRangeFromPoint`，
 * 测试自己提供并在 afterEach 删掉（删掉即回到 jsdom 原生状态，不污染其他测试）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collapseWhitespace } from '../core/text';
import type { Anchor, Mark } from '../core/types';
import {
  applyMarkHighlights,
  buildNormalizedIndex,
  clearMarkHighlights,
  markAtPoint,
  supportsHighlightApi,
} from './marks-render';
import type { HighlightSink } from './marks-render';

/** 7 个 Highlight 组名，顺序与实现里的清空顺序一致。 */
const GROUP_NAMES: readonly string[] = [
  'mdlego-hl-yellow',
  'mdlego-hl-green',
  'mdlego-hl-blue',
  'mdlego-hl-pink',
  'mdlego-underline',
  'mdlego-strike',
  'mdlego-note',
];

/** 取数组首元素并断言存在（noUncheckedIndexedAccess 下让测试读起来干净些）。 */
function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error('期望数组至少有一个元素');
  return item;
}

/** 构造一篇正文容器；块都挂在 article 里（与阅读页一致）。 */
function makeArticle(html: string): HTMLElement {
  const article = document.createElement('article');
  article.className = 'article';
  article.innerHTML = html;
  return article;
}

/** 取 article 里第一个可标注块。 */
function blockOf(article: HTMLElement): HTMLElement {
  const block = article.querySelector<HTMLElement>('[data-bid]');
  if (block === null) throw new Error('期望 article 里有可标注块');
  return block;
}

/** 构造一条标注；默认黄色高亮、无备注。 */
function makeMark(
  id: string,
  bid: string,
  start: number,
  end: number,
  extra: Partial<Pick<Mark, 'type' | 'color' | 'note'>> = {},
): Mark {
  const anchor: Anchor = { bid, start, end, quote: '', prefix: '', suffix: '' };
  return {
    id,
    docId: 'doc-1',
    anchor,
    type: extra.type ?? 'highlight',
    color: extra.color === undefined ? 'yellow' : extra.color,
    note: extra.note ?? null,
    createdAt: 1,
  };
}

/** 一次 sink 调用：set 记录分组与 Range，clear 记录组名。 */
type SinkCall =
  | { readonly kind: 'set'; readonly name: string; readonly ranges: readonly Range[] }
  | { readonly kind: 'clear'; readonly name: string };

interface FakeSink {
  readonly sink: HighlightSink;
  readonly calls: SinkCall[];
}

/** 记录每次 set/clear 的假出口：断言分组、Range 数与清空次数。 */
function fakeSink(): FakeSink {
  const calls: SinkCall[] = [];
  return {
    calls,
    sink: {
      set(name, ranges) {
        calls.push({ kind: 'set', name, ranges });
      },
      clear(name) {
        calls.push({ kind: 'clear', name });
      },
    },
  };
}

function clearsOf(calls: readonly SinkCall[]): string[] {
  return calls.filter((call) => call.kind === 'clear').map((call) => call.name);
}

/** 某个组最后一次被 set 的 Range 列表；没 set 过就是空数组。 */
function groupRanges(calls: readonly SinkCall[], name: string): readonly Range[] {
  const sets = calls.flatMap((call) =>
    call.kind === 'set' && call.name === name ? [call.ranges] : [],
  );
  if (sets.length === 0) return [];
  return sets[sets.length - 1] ?? [];
}

// ─────────────────────────────────────────────
// 全局 Highlight API 的安装与还原
// ─────────────────────────────────────────────

/** jsdom 有 CSS 对象（只有 escape/registerProperty/supports），但没有 highlights。 */
function cssHost(): Record<string, unknown> {
  const scope = globalThis as unknown as { CSS?: Record<string, unknown> };
  const host = scope.CSS;
  if (host === undefined) throw new Error('jsdom 环境缺少 CSS 对象');
  return host;
}

/** 删掉测试注入的能力 —— jsdom 原生没有这两个全局，删掉就是还原。 */
function removeHighlightApi(): void {
  const scope = globalThis as unknown as { CSS?: Record<string, unknown>; Highlight?: unknown };
  if (scope.CSS !== undefined) delete scope.CSS.highlights;
  delete scope.Highlight;
}

interface FakeHighlightApi {
  readonly registry: Map<string, unknown>;
  readonly created: Range[][];
}

/** 装一套最小可用的 CSS.highlights + Highlight，用来验「不注入 sink」的默认出口。 */
function installHighlightApi(): FakeHighlightApi {
  const registry = new Map<string, unknown>();
  const created: Range[][] = [];
  Object.defineProperty(cssHost(), 'highlights', {
    configurable: true,
    value: {
      set(name: string, highlight: unknown): void {
        registry.set(name, highlight);
      },
      delete(name: string): boolean {
        return registry.delete(name);
      },
    },
  });
  class FakeHighlight {
    readonly ranges: Range[];
    constructor(...ranges: Range[]) {
      this.ranges = ranges;
      created.push(ranges);
    }
  }
  Object.defineProperty(globalThis, 'Highlight', { configurable: true, value: FakeHighlight });
  return { registry, created };
}

/** 模拟浏览器：坐标落在指定文本节点的指定偏移（空选区）。 */
function stubCaret(node: Node, offset: number): void {
  const range = document.createRange();
  range.setStart(node, offset);
  Object.defineProperty(document, 'caretRangeFromPoint', {
    configurable: true,
    value: () => range,
  });
}

function removeCaretStub(): void {
  const host = document as unknown as {
    caretRangeFromPoint?: (left: number, top: number) => Range | null;
  };
  delete host.caretRangeFromPoint;
}

beforeEach(() => {
  // 每个用例从「老 WebView」状态起步：不支持的测试不用反复解释环境
  removeHighlightApi();
  removeCaretStub();
  clearMarkHighlights();
});

afterEach(() => {
  removeHighlightApi();
  removeCaretStub();
});

// ─────────────────────────────────────────────
// buildNormalizedIndex
// ─────────────────────────────────────────────

describe('buildNormalizedIndex — 空白折叠', () => {
  it('把连续空白折叠成一个空格并去掉两端空白', () => {
    const article = makeArticle('<p data-bid="p-1">  a  b\n c  </p>');
    const index = buildNormalizedIndex(blockOf(article));
    expect(index.text).toBe('a b c');
  });

  it('归一化结果与 collapseWhitespace 逐字一致，且 positions 与 text 等长', () => {
    const samples = ['a  b\n c', '  前后空白  ', '中\t文\r\n混排', '中 文　全角空格', 'x', '   '];
    for (const raw of samples) {
      const article = makeArticle('<p data-bid="p-1"></p>');
      const block = blockOf(article);
      block.textContent = raw;
      const index = buildNormalizedIndex(block);

      expect(index.text).toBe(collapseWhitespace(raw));
      expect(index.positions).toHaveLength(index.text.length);
    }
  });

  it('每个归一化字符都能回到原文的文本节点与偏移', () => {
    const article = makeArticle('<p data-bid="p-1">a  b</p>');
    const block = blockOf(article);
    const index = buildNormalizedIndex(block);

    expect(index.positions.map((position) => position.offset)).toEqual([0, 1, 3]);
    for (const position of index.positions) {
      expect(position.node).toBe(block.firstChild);
    }
  });

  it('跨 inline 元素按文档顺序收集文本', () => {
    const article = makeArticle('<p data-bid="p-1"><em>开头</em>与<strong>结尾</strong></p>');
    const index = buildNormalizedIndex(blockOf(article));

    expect(index.text).toBe('开头与结尾');
    expect(index.positions[0]?.node).toBe(article.querySelector('em')?.firstChild);
    expect(index.positions[2]?.node).toBe(article.querySelector('p')?.childNodes[1]);
    expect(index.positions[3]?.node).toBe(article.querySelector('strong')?.firstChild);
  });

  it('空块与纯空白块的 text、positions 都为空', () => {
    for (const html of ['<p data-bid="p-1"></p>', '<p data-bid="p-1"> \n\t </p>']) {
      const index = buildNormalizedIndex(blockOf(makeArticle(html)));
      expect(index.text).toBe('');
      expect(index.positions).toEqual([]);
    }
  });

  it('跳过 script/style/svg 里的文本', () => {
    const article = makeArticle(
      '<div data-bid="d-1">前<script>var a = 1;</script><style>p{}</style><svg><text>图</text></svg>后</div>',
    );
    const index = buildNormalizedIndex(blockOf(article));
    expect(index.text).toBe('前后');
  });
});

// ─────────────────────────────────────────────
// applyMarkHighlights
// ─────────────────────────────────────────────

describe('applyMarkHighlights — 分组绘制', () => {
  it('注入 sink：按颜色分组画 Range，applied 与 groups 正确', () => {
    const article = makeArticle('<p data-bid="p-1">hello world</p>');
    const blockTexts = new Map([['p-1', 'hello world']]);
    const { sink, calls } = fakeSink();

    const result = applyMarkHighlights(article, blockTexts, [makeMark('m-1', 'p-1', 6, 11)], {
      sink,
    });

    expect(result.supported).toBe(true);
    expect(result.applied).toBe(1);
    expect(result.orphanIds).toEqual([]);
    expect(result.groups).toEqual({ 'mdlego-hl-yellow': 1 });
    // 先清空 7 个组，再画
    expect(clearsOf(calls)).toEqual([...GROUP_NAMES]);
    const ranges = groupRanges(calls, 'mdlego-hl-yellow');
    expect(ranges).toHaveLength(1);
    expect(first(ranges).toString()).toBe('world');
  });

  it('跨 inline 元素的标注生成一个连续 Range', () => {
    const article = makeArticle('<p data-bid="p-1">one <strong>two</strong></p>');
    const blockTexts = new Map([['p-1', 'one two']]);
    const { sink, calls } = fakeSink();

    applyMarkHighlights(article, blockTexts, [makeMark('m-1', 'p-1', 0, 7)], { sink });

    expect(first(groupRanges(calls, 'mdlego-hl-yellow')).toString()).toBe('one two');
  });

  it('四色高亮 / 下划线 / 删除线 / 批注各进对应组', () => {
    const text = '一二三四五六七';
    const article = makeArticle(`<p data-bid="p-1">${text}</p>`);
    const blockTexts = new Map([['p-1', text]]);
    const { sink } = fakeSink();
    const marks = [
      makeMark('黄', 'p-1', 0, 1),
      makeMark('绿', 'p-1', 1, 2, { color: 'green' }),
      makeMark('蓝', 'p-1', 2, 4, { color: 'blue' }),
      makeMark('粉', 'p-1', 4, 5, { color: 'pink' }),
      makeMark('下划线', 'p-1', 5, 6, { type: 'underline', color: null }),
      makeMark('删除线', 'p-1', 6, 7, { type: 'strike', color: null }),
      makeMark('批注', 'p-1', 0, 1, { type: 'note', color: null, note: '备注' }),
    ];

    const result = applyMarkHighlights(article, blockTexts, marks, { sink });

    expect(result.applied).toBe(7);
    expect(result.groups).toEqual({
      'mdlego-hl-yellow': 2,
      'mdlego-hl-green': 1,
      'mdlego-hl-blue': 1,
      'mdlego-hl-pink': 1,
      'mdlego-underline': 1,
      'mdlego-strike': 1,
      'mdlego-note': 1,
    });
  });

  it('批注同时进底色组与 note 组（color 为 null 时按黄色）', () => {
    const article = makeArticle('<p data-bid="p-1">hello</p>');
    const blockTexts = new Map([['p-1', 'hello']]);
    const { sink, calls } = fakeSink();

    const result = applyMarkHighlights(
      article,
      blockTexts,
      [makeMark('n-1', 'p-1', 0, 2, { type: 'note', color: null, note: '批注' })],
      { sink },
    );

    expect(result.applied).toBe(1);
    expect(result.groups).toEqual({ 'mdlego-hl-yellow': 1, 'mdlego-note': 1 });
    expect(groupRanges(calls, 'mdlego-hl-yellow')).toHaveLength(1);
    expect(groupRanges(calls, 'mdlego-note')).toHaveLength(1);
  });

  it('缺块 / 越界 / 空区间的标注只进 orphanIds，不画也不计 applied', () => {
    const article = makeArticle('<p data-bid="p-1">abc</p>');
    const blockTexts = new Map([
      ['p-1', 'abc'],
      ['p-ghost', '幽灵'], // blockTexts 里有、DOM 里没有
    ]);
    const { sink, calls } = fakeSink();
    const marks = [
      makeMark('正常', 'p-1', 0, 2),
      makeMark('缺块', 'p-404', 0, 1),
      makeMark('缺DOM', 'p-ghost', 0, 1),
      makeMark('越界', 'p-1', 0, 4),
      makeMark('负数', 'p-1', -1, 2),
      makeMark('空区间', 'p-1', 1, 1),
      makeMark('倒序', 'p-1', 2, 1),
    ];

    const result = applyMarkHighlights(article, blockTexts, marks, { sink });

    expect(result.orphanIds).toEqual(['缺块', '缺DOM', '越界', '负数', '空区间', '倒序']);
    expect(result.applied).toBe(1);
    expect(clearsOf(calls)).toEqual([...GROUP_NAMES]);
    expect(groupRanges(calls, 'mdlego-hl-yellow')).toHaveLength(1);
  });

  it('重复调用先清空 7 个组，不叠画', () => {
    const article = makeArticle('<p data-bid="p-1">abc</p>');
    const blockTexts = new Map([['p-1', 'abc']]);
    const { sink, calls } = fakeSink();

    applyMarkHighlights(article, blockTexts, [makeMark('m-1', 'p-1', 0, 1)], { sink });
    applyMarkHighlights(article, blockTexts, [makeMark('m-2', 'p-1', 1, 2)], { sink });

    // 每次调用都清空 7 组 → 共 14 次 clear，顺序稳定
    expect(clearsOf(calls)).toEqual([...GROUP_NAMES, ...GROUP_NAMES]);
    // 第二次只画一条，不会把第一次的 Range 叠进来
    const ranges = groupRanges(calls, 'mdlego-hl-yellow');
    expect(ranges).toHaveLength(1);
    expect(first(ranges).toString()).toBe('b');
  });

  it('没有标注时也会清空 7 个组', () => {
    const article = makeArticle('<p data-bid="p-1">abc</p>');
    const { sink, calls } = fakeSink();

    const result = applyMarkHighlights(article, new Map([['p-1', 'abc']]), [], { sink });

    expect(result).toEqual({ supported: true, applied: 0, orphanIds: [], groups: {} });
    expect(clearsOf(calls)).toEqual([...GROUP_NAMES]);
    expect(calls.filter((call) => call.kind === 'set')).toEqual([]);
  });
});

describe('applyMarkHighlights — 降级与默认出口', () => {
  it('不支持 CSS Highlight 且没注入 sink：supported false、applied 0，失效照常审计', () => {
    const article = makeArticle('<p data-bid="p-1">abc</p>');
    const blockTexts = new Map([['p-1', 'abc']]);
    const marks = [makeMark('正常', 'p-1', 0, 1), makeMark('缺块', 'p-404', 0, 1)];

    const result = applyMarkHighlights(article, blockTexts, marks);

    expect(result.supported).toBe(false);
    expect(result.applied).toBe(0);
    // 不支持不等于标注失效：只有真正找不到块的才算 orphan
    expect(result.orphanIds).toEqual(['缺块']);
    expect(result.groups).toEqual({});
    expect(() => clearMarkHighlights()).not.toThrow();
  });

  it('不注入 sink 时走 CSS.highlights 默认出口，clear 会逐组 delete', () => {
    const api = installHighlightApi();
    const article = makeArticle('<p data-bid="p-1">hello</p>');

    const result = applyMarkHighlights(article, new Map([['p-1', 'hello']]), [
      makeMark('m-1', 'p-1', 0, 5),
    ]);

    expect(result.supported).toBe(true);
    expect(result.applied).toBe(1);
    expect(api.registry.has('mdlego-hl-yellow')).toBe(true);
    expect(api.created).toHaveLength(1);
    expect(first(first(api.created)).toString()).toBe('hello');

    clearMarkHighlights();
    expect(api.registry.size).toBe(0);
  });

  it('supportsHighlightApi 反映系统能力', () => {
    expect(supportsHighlightApi()).toBe(false);
    installHighlightApi();
    expect(supportsHighlightApi()).toBe(true);
    removeHighlightApi();
    expect(supportsHighlightApi()).toBe(false);
  });
});

// ─────────────────────────────────────────────
// clearMarkHighlights
// ─────────────────────────────────────────────

describe('clearMarkHighlights', () => {
  it('对 7 个组各调用一次 clear', () => {
    const { sink, calls } = fakeSink();

    clearMarkHighlights({ sink });

    expect(clearsOf(calls)).toEqual([...GROUP_NAMES]);
  });
});

// ─────────────────────────────────────────────
// markAtPoint
// ─────────────────────────────────────────────

interface PointRig {
  readonly article: HTMLElement;
  readonly blockTexts: Map<string, string>;
  readonly paragraph: HTMLElement;
  readonly text: Text;
}

/** 造一篇 "hello world"，按给定标注先画一遍（markAtPoint 只认画出来的标注）。 */
function setupPointRig(marks: readonly Mark[]): PointRig {
  const article = makeArticle('<p data-bid="p-1">hello world</p>');
  const blockTexts = new Map([['p-1', 'hello world']]);
  const { sink } = fakeSink();
  applyMarkHighlights(article, blockTexts, marks, { sink });

  const paragraph = article.querySelector<HTMLElement>('p');
  if (paragraph === null) throw new Error('期望 article 里有 p 块');
  const text = paragraph.firstChild;
  if (text === null || text.nodeType !== Node.TEXT_NODE) throw new Error('期望文本节点');
  return { article, blockTexts, paragraph, text: text as Text };
}

describe('markAtPoint — 命中', () => {
  it('命中覆盖该偏移的标注', () => {
    const rig = setupPointRig([makeMark('m-world', 'p-1', 6, 11)]);
    stubCaret(rig.text, 8); // "world" 里的 'r'

    expect(markAtPoint(rig.article, rig.blockTexts, 10, 10)).toBe('m-world');
  });

  it('没有标注覆盖该偏移时返回 null', () => {
    const rig = setupPointRig([makeMark('m-world', 'p-1', 6, 11)]);
    stubCaret(rig.text, 0); // "hello" 的 'h'，不在 world 区间内

    expect(markAtPoint(rig.article, rig.blockTexts, 10, 10)).toBeNull();
  });

  it('后渲染的标注优先（重叠时返回最后一条）', () => {
    const rig = setupPointRig([
      makeMark('m-先', 'p-1', 0, 9),
      makeMark('m-后', 'p-1', 6, 11),
    ]);
    stubCaret(rig.text, 7);

    expect(markAtPoint(rig.article, rig.blockTexts, 10, 10)).toBe('m-后');
  });

  it('caret 停在词尾（文本节点末尾）时回到最后一个字符', () => {
    const rig = setupPointRig([makeMark('m-world', 'p-1', 6, 11)]);
    stubCaret(rig.text, 11); // 文本长度 11，caret 在 'd' 之后

    expect(markAtPoint(rig.article, rig.blockTexts, 10, 10)).toBe('m-world');
  });

  it('caret 落在元素节点上时退到最近的子文本起点', () => {
    const rig = setupPointRig([makeMark('m-hello', 'p-1', 0, 5)]);
    stubCaret(rig.paragraph, 0);

    expect(markAtPoint(rig.article, rig.blockTexts, 10, 10)).toBe('m-hello');
  });

  it('没有 caretRangeFromPoint 时返回 null', () => {
    const rig = setupPointRig([makeMark('m-world', 'p-1', 6, 11)]);

    expect(markAtPoint(rig.article, rig.blockTexts, 10, 10)).toBeNull();
  });

  it('坐标落在非可标注块（没有被 data-bid 包住）时返回 null', () => {
    const article = makeArticle('<p data-bid="p-1">hello</p><blockquote>引言</blockquote>');
    const blockTexts = new Map([['p-1', 'hello']]);
    applyMarkHighlights(article, blockTexts, [makeMark('m-1', 'p-1', 0, 5)], { sink: fakeSink().sink });

    const quoteText = article.querySelector('blockquote')?.firstChild;
    if (quoteText === null || quoteText === undefined) throw new Error('期望 blockquote 文本');
    stubCaret(quoteText, 0);

    expect(markAtPoint(article, blockTexts, 10, 10)).toBeNull();
  });

  it('清空后不再命中', () => {
    const rig = setupPointRig([makeMark('m-hello', 'p-1', 0, 5)]);
    stubCaret(rig.text, 2);
    expect(markAtPoint(rig.article, rig.blockTexts, 10, 10)).toBe('m-hello');

    clearMarkHighlights({ sink: fakeSink().sink });
    expect(markAtPoint(rig.article, rig.blockTexts, 10, 10)).toBeNull();
  });

  it('不支持时没有画出的标注也就没有命中目标', () => {
    const article = makeArticle('<p data-bid="p-1">hello</p>');
    const blockTexts = new Map([['p-1', 'hello']]);
    const result = applyMarkHighlights(article, blockTexts, [makeMark('m-1', 'p-1', 0, 5)]);
    expect(result.supported).toBe(false);

    const text = article.querySelector('p')?.firstChild;
    if (text === null || text === undefined) throw new Error('期望文本节点');
    stubCaret(text, 2);

    expect(markAtPoint(article, blockTexts, 10, 10)).toBeNull();
  });
});
