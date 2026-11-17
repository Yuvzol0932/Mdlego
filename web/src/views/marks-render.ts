/**
 * 标注渲染层（阶段 E2）—— DOM 文本 ↔ 块内归一化偏移、CSS Custom Highlight 绘制、坐标命中。
 *
 * 三条不变量：
 *  1. **绝不改正文 DOM**：只用 `CSS.highlights` 注册 Range（见 docs/DECISION-phase-E2.md §1.1）。
 *     正文是阶段 A 的铁律，包 `<span>` 会破坏 inline 结构、重叠标注无法嵌套、重渲染还要撤销一遍。
 *  2. **只有一套偏移空间**：块文本按 `core/text.ts::collapseWhitespace` 的规则归一化，
 *     与 `RenderResult.blockTexts` / `Anchor.start/end` / `core/anchors.ts::relocate` 完全一致。
 *  3. **不伪造**：系统不支持 CSS Highlight API 时如实返回 `supported: false`，
 *     由调用方明确提示用户，绝不偷偷塞内联标记顶替。
 *
 * 本模块只依赖 core 的类型，不碰 data/state（见 docs/CONVENTIONS.md §2）。
 */

import type { HighlightColor, Mark } from '../core/types';

// ─────────────────────────────────────────────
// Highlight 组名
// ─────────────────────────────────────────────

/** 四种高亮底色各一组。 */
const GROUP_YELLOW = 'mdlego-hl-yellow';
const GROUP_GREEN = 'mdlego-hl-green';
const GROUP_BLUE = 'mdlego-hl-blue';
const GROUP_PINK = 'mdlego-hl-pink';
/** 下划线 / 删除线各一组。 */
const GROUP_UNDERLINE = 'mdlego-underline';
const GROUP_STRIKE = 'mdlego-strike';
/** 批注标记组：虚线下划线（底色由颜色组负责，见 E2 设计 §1.4）。 */
const GROUP_NOTE = 'mdlego-note';

/**
 * 全部 7 个组名。
 * 清空必须逐组 delete —— 少清一组，上一次渲染的标注就会以残影形式留着。
 */
const HIGHLIGHT_GROUPS: readonly string[] = [
  GROUP_YELLOW,
  GROUP_GREEN,
  GROUP_BLUE,
  GROUP_PINK,
  GROUP_UNDERLINE,
  GROUP_STRIKE,
  GROUP_NOTE,
];

/** 颜色 → 底色组。color 为 null（或脏数据）时按黄色处理。 */
const COLOR_GROUP: Readonly<Record<HighlightColor, string>> = {
  yellow: GROUP_YELLOW,
  green: GROUP_GREEN,
  blue: GROUP_BLUE,
  pink: GROUP_PINK,
};

/** 最近一次成功画出的标注，供 markAtPoint 做命中测试（见文件末尾说明）。 */
let activeMarks: readonly Mark[] = [];

// ─────────────────────────────────────────────
// 归一化索引：块文本 ↔ DOM 文本节点位置
// ─────────────────────────────────────────────

/** 归一化文本第 i 个字符在原文里的位置。 */
export interface NormalizedPosition {
  readonly node: Text;
  /** 该字符在 `node.data` 内的下标，从 0 开始。 */
  readonly offset: number;
}

/**
 * 一个块的归一化视图。
 * `positions.length === text.length`：归一化下标 i ⇄ 原文位置一一对应。
 */
export interface NormalizedIndex {
  /** 块内文本按 collapseWhitespace 的规则折叠后的结果。 */
  readonly text: string;
  /** 归一化下标 → 原文位置。 */
  readonly positions: readonly NormalizedPosition[];
}

/** 与 collapseWhitespace 里的 `\s` 完全一致（含全角空格、换行、制表符等）。 */
const WHITESPACE = /\s/;

/** TreeWalker 的 SHOW_TEXT。写成常量，避免依赖 NodeFilter 全局（测试环境可能没有）。 */
const SHOW_TEXT = 4;

/** 这些元素里的文本不是正文，不参与偏移（SVG 的 `<text>` 也算）。 */
const SKIPPED_TEXT_ANCESTOR = 'script, style, svg';

/**
 * 为一个块建立归一化索引。
 *
 * 规则必须与 `core/text.ts::collapseWhitespace` 逐字一致：
 * 连续空白折叠成一个空格，**两端空白去掉（trim）**。唯一区别是这里同时记下
 * 每个归一化字符来自哪个文本节点的哪个下标，用于反向生成 Range。
 *
 * 折叠出来的空格映射到该空白段的第一个字符位置；被 trim 掉的两端空白没有位置。
 */
export function buildNormalizedIndex(root: HTMLElement): NormalizedIndex {
  const walker = root.ownerDocument.createTreeWalker(root, SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const text = node as Text;
    if (text.data.length === 0) continue;
    const parent = text.parentElement;
    if (parent !== null && parent.closest(SKIPPED_TEXT_ANCESTOR) !== null) continue;
    nodes.push(text);
  }

  // 先把所有文本节点按文档顺序拼成原文，并记下每个原文下标来自哪个节点。
  let raw = '';
  const rawPositions: NormalizedPosition[] = [];
  for (const node of nodes) {
    const data = node.data;
    for (let i = 0; i < data.length; i++) {
      rawPositions.push({ node, offset: i });
    }
    raw += data;
  }

  // 再按 collapseWhitespace 的规则折叠：逐字符扫描，空白段只留一个空格，
  // 段前或段后没有实质字符（即位于全文两端）就整段丢掉，等价于 trim。
  const chars: string[] = [];
  const positions: NormalizedPosition[] = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i] as string;
    if (!WHITESPACE.test(ch)) {
      chars.push(ch);
      positions.push(rawPositions[i] as NormalizedPosition);
      i++;
      continue;
    }

    let end = i;
    while (end < raw.length && WHITESPACE.test(raw[end] as string)) end++;
    if (i > 0 && end < raw.length) {
      chars.push(' ');
      positions.push(rawPositions[i] as NormalizedPosition);
    }
    i = end;
  }

  return { text: chars.join(''), positions };
}

// ─────────────────────────────────────────────
// CSS Highlight API 能力探测与默认 sink
// ─────────────────────────────────────────────

/** 可以注入的绘制出口：测试注入假实现，生产用 CSS.highlights。 */
export interface HighlightSink {
  set(name: string, ranges: readonly Range[]): void;
  clear(name: string): void;
}

export interface ApplyOptions {
  /** 绘制出口；缺省用 CSS.highlights。测试注入 fake sink，不依赖浏览器能力。 */
  readonly sink?: HighlightSink;
}

export interface ApplyResult {
  /** 是否有可用的绘制出口（注入 sink，或系统支持 CSS Highlight API）。 */
  readonly supported: boolean;
  /** 成功建出 Range 并画出的标注数（批注算一条，尽管它同时进两个组）。 */
  readonly applied: number;
  /** 真实失效的标注 id：块不存在、bid 不在 blockTexts、偏移越界/非法。 */
  readonly orphanIds: readonly string[];
  /** 每组实际画出的 Range 数（测试与诊断用）。 */
  readonly groups: Readonly<Record<string, number>>;
}

/**
 * `CSS.highlights` 的最小结构。
 * TS 5.9 的 lib.dom 只给 HighlightRegistry 声明了 forEach，浏览器实际提供 Map 式接口，
 * 所以这里用自己的结构化类型接住，避免与 lib.dom 的声明打架。
 */
interface HighlightRegistryLike {
  set(name: string, highlight: unknown): void;
  delete(name: string): boolean;
}

/** `new Highlight(...ranges)` 的最小构造签名。 */
type HighlightConstructor = new (...ranges: Range[]) => unknown;

/** 取 CSS.highlights 注册表；浏览器不支持时返回 null。 */
function highlightRegistry(): HighlightRegistryLike | null {
  const scope = globalThis as unknown as { CSS?: { highlights?: HighlightRegistryLike } };
  const registry = scope.CSS?.highlights;
  if (registry === undefined) return null;
  return typeof registry.set === 'function' && typeof registry.delete === 'function' ? registry : null;
}

/** 取全局 Highlight 构造函数；浏览器不支持时返回 null。 */
function highlightConstructor(): HighlightConstructor | null {
  const scope = globalThis as unknown as { Highlight?: unknown };
  return typeof scope.Highlight === 'function' ? (scope.Highlight as HighlightConstructor) : null;
}

/** 默认绘制出口：真的往 CSS.highlights 注册；不支持（老 WebView / jsdom）返回 null。 */
function defaultSink(): HighlightSink | null {
  const registry = highlightRegistry();
  const Ctor = highlightConstructor();
  if (registry === null || Ctor === null) return null;
  return {
    set(name, ranges) {
      registry.set(name, new Ctor(...ranges));
    },
    clear(name) {
      registry.delete(name);
    },
  };
}

/** 系统是否支持 CSS Custom Highlight API（两个能力缺一不可）。 */
export function supportsHighlightApi(): boolean {
  return highlightRegistry() !== null && highlightConstructor() !== null;
}

/** 逐组清空；sink 保证非空。 */
function clearGroups(sink: HighlightSink): void {
  for (const name of HIGHLIGHT_GROUPS) sink.clear(name);
}

/**
 * 清空 7 个高亮组，并忘掉命中测试用的标注集合。
 *
 * 没有可用出口时（不支持且没注入 sink）静默返回 —— 降级由调用方提示。
 */
export function clearMarkHighlights(options: ApplyOptions = {}): void {
  activeMarks = [];
  const sink = options.sink ?? defaultSink();
  if (sink !== null) clearGroups(sink);
}

// ─────────────────────────────────────────────
// 绘制
// ─────────────────────────────────────────────

/** 正文里按 bid 找块。用扫描 + getAttribute 比较，避免拼选择器时依赖 CSS.escape。 */
function findBlockByBid(article: HTMLElement, bid: string): HTMLElement | null {
  const blocks = article.querySelectorAll<HTMLElement>('[data-bid]');
  for (const block of blocks) {
    if (block.getAttribute('data-bid') === bid) return block;
  }
  return null;
}

/** 一条标注要画进哪些组。批注 = 高亮底色（默认黄）+ note 组的虚线下划线。 */
function groupsForMark(mark: Mark): readonly string[] {
  if (mark.type === 'underline') return [GROUP_UNDERLINE];
  if (mark.type === 'strike') return [GROUP_STRIKE];
  // color 字段若是脏数据，回落到黄色，不让一条坏记录连累整页
  const colorGroup = COLOR_GROUP[mark.color ?? 'yellow'] ?? GROUP_YELLOW;
  if (mark.type === 'note') return [colorGroup, GROUP_NOTE];
  return [colorGroup];
}

/** 用归一化下标生成 Range：起点位置 → 终点字符之后（end 是开区间）。 */
function buildRange(
  doc: Document,
  index: NormalizedIndex,
  start: number,
  end: number,
): Range | null {
  const startPosition = index.positions[start];
  const endPosition = index.positions[end - 1];
  if (startPosition === undefined || endPosition === undefined) return null;
  const range = doc.createRange();
  try {
    range.setStart(startPosition.node, startPosition.offset);
    range.setEnd(endPosition.node, endPosition.offset + 1);
  } catch {
    // 文本节点已脱离文档（正文刚被替换）时宁可这一帧不画，也不要抛出去搞崩阅读页
    return null;
  }
  return range;
}

/** 偏移是否合法且非空：整数、落在块文本内、end 在 start 之后。 */
function isValidSpan(start: number, end: number, textLength: number): boolean {
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end <= textLength &&
    start < end
  );
}

/**
 * 把一批标注画到正文上。
 *
 * 流程：
 *  1. 先 `clearMarkHighlights`，保证重复调用幂等（不叠画、不留残影）；
 *  2. 每条标注校验块存在、bid 在 blockTexts 里、偏移合法，失败进 `orphanIds`；
 *  3. 合法的生成 Range 并按类型分组，最后一次 `sink.set` 每组一次；
 *  4. 不支持且没注入 sink 时：仍如实算 `orphanIds`，但 `applied` 计 0、不画也不报错。
 *
 * @param article    正文根节点（找 `[data-bid]` 的范围）
 * @param blockTexts 渲染产出的块纯文本（偏移空间的唯一权威）
 * @param marks      已经过重定位、准备落盘的标注（顺序即渲染顺序，命中时后渲染优先）
 */
export function applyMarkHighlights(
  article: HTMLElement,
  blockTexts: ReadonlyMap<string, string>,
  marks: readonly Mark[],
  options: ApplyOptions = {},
): ApplyResult {
  const supported = options.sink !== undefined || supportsHighlightApi();
  const sink = options.sink ?? defaultSink();

  // 幂等：先清掉上一次的 7 个组
  clearMarkHighlights(options);

  const orphanIds: string[] = [];
  const painted: Mark[] = [];
  const rangesByGroup = new Map<string, Range[]>();
  // 同一个块可能有多条标注：块查找与归一化索引都只做一次
  const indexCache = new Map<string, NormalizedIndex | null>();
  const indexFor = (bid: string): NormalizedIndex | null => {
    const cached = indexCache.get(bid);
    if (cached !== undefined) return cached;
    const block = findBlockByBid(article, bid);
    const index = block === null ? null : buildNormalizedIndex(block);
    indexCache.set(bid, index);
    return index;
  };

  for (const mark of marks) {
    const { bid, start, end } = mark.anchor;

    // blockTexts 是渲染产出的块清单：里面没有 bid，等于「块不存在」
    if (!blockTexts.has(bid)) {
      orphanIds.push(mark.id);
      continue;
    }

    const index = indexFor(bid);
    if (index === null) {
      orphanIds.push(mark.id);
      continue;
    }

    if (!isValidSpan(start, end, index.text.length)) {
      orphanIds.push(mark.id);
      continue;
    }

    // 没有出口：失效照常审计，但不假装画上了
    if (!supported || sink === null) continue;

    const range = buildRange(article.ownerDocument, index, start, end);
    if (range === null) {
      orphanIds.push(mark.id);
      continue;
    }

    for (const group of groupsForMark(mark)) {
      const bucket = rangesByGroup.get(group);
      if (bucket === undefined) rangesByGroup.set(group, [range]);
      else bucket.push(range);
    }
    painted.push(mark);
  }

  const groups: Record<string, number> = {};
  if (supported && sink !== null) {
    for (const [group, ranges] of rangesByGroup) {
      if (ranges.length === 0) continue;
      sink.set(group, ranges);
      groups[group] = ranges.length;
    }
  }

  // 命中测试只认「真的画出来了」的标注：没画出来的不该有可点区域
  activeMarks = supported ? painted : [];

  return { supported, applied: painted.length, orphanIds, groups };
}

// ─────────────────────────────────────────────
// 坐标命中：点已有标注
// ─────────────────────────────────────────────

/** 元素容器上的 caret 落点 → 最近的文本节点位置。 */
function nearestTextPosition(element: Element, offset: number): NormalizedPosition | null {
  const children = element.childNodes;
  const at = Math.max(0, Math.min(offset, children.length));
  // 先向后：插入点右侧第一个文本节点的起点
  for (let i = at; i < children.length; i++) {
    const start = firstTextNode(children[i] as Node);
    if (start !== null) return { node: start, offset: 0 };
  }
  // 再向前：插入点左侧最后一个文本节点的终点
  for (let i = at - 1; i >= 0; i--) {
    const end = lastTextNode(children[i] as Node);
    if (end !== null) return { node: end, offset: end.data.length };
  }
  return null;
}

/** 深度优先取子树里第一个文本节点。 */
function firstTextNode(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) return node as Text;
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    const found = firstTextNode(child);
    if (found !== null) return found;
  }
  return null;
}

/** 深度优先取子树里最后一个文本节点。 */
function lastTextNode(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) return node as Text;
  for (let child = node.lastChild; child !== null; child = child.previousSibling) {
    const found = lastTextNode(child);
    if (found !== null) return found;
  }
  return null;
}

/** caret 落点 → `{文本节点, 节点内偏移}`；元素节点退到最近的文本节点。 */
function caretTextPosition(container: Node, offset: number): NormalizedPosition | null {
  if (container.nodeType === Node.TEXT_NODE) {
    return { node: container as Text, offset };
  }
  if (container.nodeType !== Node.ELEMENT_NODE) return null;
  return nearestTextPosition(container as Element, offset);
}

/** 从一个点向上找最近的 `[data-bid]` 块；必须是 article 的后代。 */
function blockOfNode(article: HTMLElement, node: Node): HTMLElement | null {
  const start = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (start === null) return null;
  const block = start.closest<HTMLElement>('[data-bid]');
  if (block === null || !article.contains(block)) return null;
  return block;
}

/**
 * 把「文本节点 + 节点内偏移」换算成归一化偏移。
 *
 * caret 常停在词尾（offset 指向下一个字符），也可能落在被折叠掉的空白上，
 * 所以先找精确匹配，再向后取最近的归一化字符，最后向前取。
 * 找不到（节点不在块文本里，如 script/隐藏内容）返回 null。
 */
function normalizedOffsetAt(index: NormalizedIndex, node: Text, offset: number): number | null {
  let before = -1;
  let after = -1;
  for (let i = 0; i < index.positions.length; i++) {
    const position = index.positions[i];
    if (position === undefined || position.node !== node) continue;
    if (position.offset === offset) return i;
    if (position.offset < offset) before = i;
    else if (after < 0) after = i;
  }
  if (after >= 0) return after;
  return before >= 0 ? before : null;
}

/**
 * 坐标命中已有标注：返回覆盖该位置、最后渲染的那条标注 id；没命中返回 null。
 *
 * 命中集合来自最近一次 `applyMarkHighlights` 成功画出的标注（模块内记录），
 * 所以调用顺序固定为「先画、后点」。没有 `caretRangeFromPoint`（老 WebView / jsdom）
 * 或坐标不在可标注块内时都静默返回 null。
 */
export function markAtPoint(
  article: HTMLElement,
  blockTexts: ReadonlyMap<string, string>,
  x: number,
  y: number,
): string | null {
  const doc = article.ownerDocument;
  if (typeof doc.caretRangeFromPoint !== 'function') return null;
  const range = doc.caretRangeFromPoint(x, y);
  if (range === null) return null;

  const point = caretTextPosition(range.startContainer, range.startOffset);
  if (point === null) return null;

  const block = blockOfNode(article, point.node);
  if (block === null) return null;
  const bid = block.getAttribute('data-bid');
  if (bid === null || !blockTexts.has(bid)) return null;

  const index = buildNormalizedIndex(block);
  const offset = normalizedOffsetAt(index, point.node, point.offset);
  if (offset === null) return null;

  // 后创建/后渲染者优先：顺序遍历，最后命中的覆盖前面的
  let hit: string | null = null;
  for (const mark of activeMarks) {
    if (mark.anchor.bid !== bid) continue;
    if (mark.anchor.start <= offset && offset < mark.anchor.end) hit = mark.id;
  }
  return hit;
}
