/**
 * 正文选区与标注工具条（阶段 E2 + 中文拖选游标增强）。
 *
 * 为什么自绘选区与手柄：M5 为了让长按不被系统菜单抢走，给 .article 关了 user-select；
 * Android WebView 的系统 ActionMode 又无法定制。这里自己做：
 *   - 长按 500ms → 英文取整词、中文及其他语言按词/字选中并弹出左右拖动手柄与工具条
 *   - 长按后直接滑动 / 拖动左右游标手柄 → 从锚定端到当前点跨词、跨行、跨块拖选
 *   - 选区用 CSS Highlight API 显示（与标注同一套机制，不改正文 DOM）
 *   - 松手后刷新工具条：4 色高亮 / 下划线 / 删除线 / 批注 / 查词（英文可用）/ 复制 / 挂载
 *
 * 兼容路径：浏览器原生选区（桌面调试/自动化）落在正文里时，selectionchange 也会弹条并挂手柄。
 * 本模块只做 DOM 与交互：偏移换算/高亮绘制在 marks-render，数据持久化在 main。
 */

import type { HighlightColor, MarkType, SelectionPart } from '../core/types';
import { el, icon } from './app';
import { buildNormalizedIndex, markAtPoint, type NormalizedIndex } from './marks-render';

/** 长按选词判定时长（略早于 Android 系统 400ms 长按菜单，防止触发 pointercancel）。 */
const LONG_PRESS_MS = 380;
/** 移动超过这个距离视为滑走（触摸滚动）或拖选（长按触发后 / 鼠标）。 */
const DRAG_TOLERANCE_PX = 12;
/** 原生选区兼容路径的防抖。 */
const NATIVE_SELECTION_DEBOUNCE_MS = 120;
/** 拖动手柄靠近视口上下缘时触发自动滚动的边距（px）。 */
const EDGE_SCROLL_ZONE_PX = 64;
/** 选区 Highlight 组名。 */
const SELECTION_GROUP = 'mdlego-selection';
/** 工具条 testid（文档里也是断言契约）。 */
const SELECTION_TOOLBAR = 'mark-toolbar';
const ACTION_TOOLBAR = 'mark-actions';
/** 需要从文本中跳过的非正文祖先节点（与 marks-render 保持一致）。 */
const SKIPPED_TEXT_ANCESTOR = 'script, style, svg';

export interface TextPoint {
  readonly node: Text;
  readonly offset: number;
}

export interface SelectionHandlers {
  /** 取当前文档的块纯文本（来自 RenderResult.blockTexts）；没有渲染结果返回 null。 */
  readonly blockTexts: () => ReadonlyMap<string, string> | null;
  /** 新建标注。 */
  readonly onMark: (parts: readonly SelectionPart[], type: MarkType, color: HighlightColor | null) => void;
  /** 新建批注：先记下选区，由 main 打开备注面板。 */
  readonly onNote: (parts: readonly SelectionPart[]) => void;
  /**
   * 查词（工具条按钮）；lookupEnabled 为 false 时不显示按钮。
   *
   * 第二个参数是「被查词在屏幕上的矩形」：查词弹层要用它判断自己的
   * 出现会不会把词盖住，被盖住就把正文滚一下（lookup #6）。
   * 这里传的是弹工具条时算好的 rect —— 点按钮时选区已经被收起，
   * 事后再从 selection 取是取不到的。
   */
  readonly onLookup: (word: string, rect: DOMRect) => void;
  /** 复制选中文字。 */
  readonly onCopy: (text: string) => void;
  /** 点已有标注（正文命中）。 */
  readonly onMarkTap: (markId: string, rect: DOMRect) => void;
  /** 是否在等待「失效标注重新挂载」。 */
  readonly isReanchorPending: () => boolean;
  readonly onReanchor: (parts: readonly SelectionPart[]) => void;
  readonly lookupEnabled: () => boolean;
}

export interface SelectionBinding {
  hide(): void;
  destroy(): void;
}

/** 同一时刻只允许一个工具条及一对选区手柄。 */
let activeToolbar: HTMLElement | null = null;
let activeHandles: { start: HTMLElement; end: HTMLElement } | null = null;
let activeRange: Range | null = null;
/** 最近一次 pointerdown 发生时工具条或手柄是否可见（供阅读页点击逻辑消费）。 */
let pointerDownHadToolbar = false;
/** 手柄拖拽时取消内部自动滚动 rAF 的钩子，供 hideSelectionToolbar 清理。 */
let cancelActiveDrag: (() => void) | null = null;
let activeCleanup: (() => void) | null = null;

/** 取走「按下时工具条/选区是否开着」并复位，保证一次点击只消费一次。 */
export function consumeToolbarOnPointerDown(): boolean {
  const value = pointerDownHadToolbar;
  pointerDownHadToolbar = false;
  return value;
}

/** 收起工具条、选区手柄与高亮。 */
export function hideSelectionToolbar(): void {
  cancelActiveDrag?.();
  cancelActiveDrag = null;
  activeCleanup?.();
  activeCleanup = null;
  activeToolbar?.remove();
  activeToolbar = null;
  activeHandles?.start.remove();
  activeHandles?.end.remove();
  activeHandles = null;
  activeRange = null;
}

// ── 选区高亮（CSS Highlight API）───────────────

/** 尝试往选区 Highlight 组里放 Range；不支持时静默（标注仍可用）。 */
function paintSelection(ranges: readonly Range[]): void {
  const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const Ctor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (highlights === undefined || Ctor === undefined) return;
  if (ranges.length === 0) highlights.delete(SELECTION_GROUP);
  else highlights.set(SELECTION_GROUP, new Ctor(...ranges));
}

function clearSelectionHighlight(): void {
  paintSelection([]);
  window.getSelection()?.removeAllRanges();
}

// ── Range ↔ 文本点与几何换算 ──────────────────────

function clampOffset(text: Text, offset: number): number {
  return Math.max(0, Math.min(offset, text.data.length));
}

function compareTextPoints(a: TextPoint, b: TextPoint): number {
  if (a.node === b.node) return a.offset - b.offset;
  const pos = a.node.compareDocumentPosition(b.node);
  if ((pos & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return -1;
  if ((pos & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return 1;
  return 0;
}

/**
 * 用任意前后顺序的两个 TextPoint 构造有序、非折叠 Range。
 * 支持反向拖选与手柄交叉；起点终点重合时返回 null，避免把选区拖没。
 */
export function makeOrderedRange(a: TextPoint, b: TextPoint): Range | null {
  const cmp = compareTextPoints(a, b);
  const rawStart = cmp <= 0 ? a : b;
  const rawEnd = cmp <= 0 ? b : a;
  const startOffset = clampOffset(rawStart.node, rawStart.offset);
  const endOffset = clampOffset(rawEnd.node, rawEnd.offset);
  if (rawStart.node === rawEnd.node && startOffset === endOffset) return null;
  const range = document.createRange();
  try {
    range.setStart(rawStart.node, startOffset);
    range.setEnd(rawEnd.node, endOffset);
    return range.collapsed ? null : range;
  } catch {
    return null;
  }
}

function findEdgeTextNode(node: Node, fromEnd: boolean): Text | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node as Text;
    return text.data.length > 0 ? text : null;
  }
  if (node.nodeType === Node.ELEMENT_NODE && (node as Element).matches(SKIPPED_TEXT_ANCESTOR)) {
    return null;
  }
  const children = node.childNodes;
  if (fromEnd) {
    for (let i = children.length - 1; i >= 0; i--) {
      const hit = findEdgeTextNode(children[i] as Node, true);
      if (hit !== null) return hit;
    }
  } else {
    for (let i = 0; i < children.length; i++) {
      const hit = findEdgeTextNode(children[i] as Node, false);
      if (hit !== null) return hit;
    }
  }
  return null;
}

function normalizeRangeEndpoint(
  article: HTMLElement,
  container: Node,
  offset: number,
  side: 'start' | 'end',
): TextPoint | null {
  if (container.nodeType === Node.TEXT_NODE) {
    const text = container as Text;
    const pt: TextPoint = { node: text, offset: clampOffset(text, offset) };
    return blockOfPoint(article, pt) !== null ? pt : null;
  }
  if (container.nodeType !== Node.ELEMENT_NODE) return null;
  const children = container.childNodes;
  const at = Math.max(0, Math.min(offset, children.length));

  const tryForward = (): TextPoint | null => {
    for (let i = at; i < children.length; i++) {
      const node = findEdgeTextNode(children[i] as Node, false);
      if (node !== null) return { node, offset: 0 };
    }
    return null;
  };
  const tryBackward = (): TextPoint | null => {
    for (let i = at - 1; i >= 0; i--) {
      const node = findEdgeTextNode(children[i] as Node, true);
      if (node !== null) return { node, offset: node.data.length };
    }
    return null;
  };

  const pt = side === 'start' ? (tryForward() ?? tryBackward()) : (tryBackward() ?? tryForward());
  if (pt === null || blockOfPoint(article, pt) === null) return null;
  return pt;
}

function getRangeEdgeRects(range: Range): { start: DOMRect; end: DOMRect; box: DOMRect } | null {
  const clientRectsFn = (range as unknown as { getClientRects?: () => DOMRectList }).getClientRects;
  const rects: DOMRect[] = [];
  if (typeof clientRectsFn === 'function') {
    const list = clientRectsFn.call(range);
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (r !== undefined && r.width > 0.5 && r.height > 0.5) rects.push(r);
    }
  }
  const box = range.getBoundingClientRect();
  if (rects.length === 0) {
    if (box.width <= 0 && box.height <= 0) return null;
    return { start: box, end: box, box };
  }
  const start = rects[0] as DOMRect;
  const end = rects[rects.length - 1] as DOMRect;
  return { start, end, box };
}

// ── Range ↔ 选区切片（纯 DOM 换算，导出供测试）──

/** 把 Range 切成「块 + 归一化偏移」的若干片；空白片丢弃。 */
export function rangeToParts(article: HTMLElement, range: Range): SelectionPart[] {
  const parts: SelectionPart[] = [];
  const blocks = article.querySelectorAll<HTMLElement>('[data-bid]');
  for (const block of blocks) {
    let intersects = false;
    try {
      intersects = range.intersectsNode(block);
    } catch {
      intersects = false;
    }
    if (!intersects) continue;
    const bid = block.getAttribute('data-bid');
    if (bid === null) continue;
    const index = buildNormalizedIndex(block);
    if (index.text.length === 0) continue;
    const local = intersectRange(range, block);
    if (local === null) continue;
    const a = offsetAtPoint(index, block, local.startContainer, local.startOffset, 'start');
    const b = offsetAtPoint(index, block, local.endContainer, local.endOffset, 'end');
    const from = Math.max(0, Math.min(a, b));
    const to = Math.min(index.text.length, Math.max(a, b));
    if (to <= from) continue;
    const quote = index.text.slice(from, to);
    if (quote.trim().length === 0) continue;
    parts.push({ bid, start: from, end: to, quote });
  }
  return parts;
}

/** 取 Range 与块内容的交集；不相交返回 null。 */
function intersectRange(range: Range, block: HTMLElement): Range | null {
  const bounds = document.createRange();
  bounds.selectNodeContents(block);
  const startBefore = range.compareBoundaryPoints(Range.START_TO_START, bounds) < 0;
  const endAfter = range.compareBoundaryPoints(Range.END_TO_END, bounds) > 0;
  const local = range.cloneRange();
  try {
    if (startBefore) local.setStart(block, 0);
    if (endAfter) local.setEnd(block, block.childNodes.length);
    return local.collapsed ? null : local;
  } catch {
    return null;
  }
}

/** DOM 点 → 块内归一化偏移（元素节点退到最近文本节点）。 */
function offsetAtPoint(
  index: NormalizedIndex,
  block: HTMLElement,
  node: Node,
  offset: number,
  side: 'start' | 'end',
): number {
  let target: Text | null = node.nodeType === Node.TEXT_NODE ? (node as Text) : null;
  let targetOffset = offset;
  if (target === null) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let first: Text | null = null;
    let last: Text | null = null;
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      if (first === null) first = n as Text;
      last = n as Text;
    }
    target = side === 'start' ? first : last;
    targetOffset = side === 'start' ? 0 : (target?.data.length ?? 0);
  }
  if (target === null) return side === 'start' ? 0 : index.text.length;

  // 起点与终点统一规则：找该 DOM 点之后的第一个归一化字符位置。
  // （end 是 Range 的「结束边界」，即该偏移之前的字符都算选中）
  let best = index.text.length;
  for (let i = 0; i < index.positions.length; i++) {
    const pos = index.positions[i];
    if (pos === undefined || pos.node !== target) continue;
    if (pos.offset >= targetOffset) {
      best = i;
      break;
    }
  }
  return Math.max(0, Math.min(index.text.length, best));
}

// ── 工具条与选区游标手柄 ────────────────────────

function positionToolbar(bar: HTMLElement, rect: DOMRect): void {
  const width = bar.offsetWidth || 300;
  const height = bar.offsetHeight || 44;
  const center = rect.left + rect.width / 2;
  const maxLeft = Math.max(8, window.innerWidth - width - 8);
  const left = Math.max(8, Math.min(maxLeft, center - width / 2));

  // 为起终点水滴圆头留出 22px 净空，防止工具条压住游标手柄
  const gap = 22;
  const minAboveTop = 48;
  const maxTop = Math.max(12, window.innerHeight - height - 16);
  const above = rect.top - height - gap;
  let top: number;
  if (above >= minAboveTop && rect.top > 16) {
    top = above;
  } else if (rect.bottom + gap + height <= window.innerHeight - 16) {
    top = rect.bottom + gap;
  } else {
    top = Math.max(Math.min(56, maxTop), Math.min(maxTop, rect.top + 8));
  }
  bar.style.setProperty('left', `${Math.round(left)}px`);
  bar.style.setProperty('top', `${Math.round(top)}px`);
}

function setToolbarHidden(hidden: boolean): void {
  activeToolbar?.classList.toggle('sel-toolbar--hidden', hidden);
}

function placeBar(bar: HTMLElement, rect: DOMRect): void {
  document.body.append(bar);
  positionToolbar(bar, rect);
}

function button(label: string, testId: string, content: Node | string, onClick: () => void): HTMLElement {
  const node = el('button', {
    class: 'sel-toolbar__btn',
    type: 'button',
    'data-testid': testId,
    'aria-label': label,
    title: label,
  }, content);
  node.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return node;
}

function colorButton(color: HighlightColor, label: string, onPick: () => void): HTMLElement {
  return button(label, `mark-color-${color}`, el('span', { class: `sel-toolbar__dot sel-toolbar__dot--${color}` }), onPick);
}

function buildSelectionToolbar(parts: readonly SelectionPart[], rect: DOMRect, handlers: SelectionHandlers): HTMLElement {
  const text = parts.map((part) => part.quote).join('');
  const bar = el('div', { class: 'sel-toolbar', role: 'toolbar', 'data-testid': SELECTION_TOOLBAR });
  const act = (type: MarkType, color: HighlightColor | null): void => {
    hideSelectionToolbar();
    handlers.onMark(parts, type, color);
  };
  bar.append(
    colorButton('yellow', '黄色高亮', () => act('highlight', 'yellow')),
    colorButton('green', '绿色高亮', () => act('highlight', 'green')),
    colorButton('blue', '蓝色高亮', () => act('highlight', 'blue')),
    colorButton('pink', '粉色高亮', () => act('highlight', 'pink')),
    el('span', { class: 'sel-toolbar__sep', 'aria-hidden': 'true' }),
    button('下划线', 'mark-underline', icon('underline'), () => act('underline', null)),
    button('删除线', 'mark-strike', icon('strike'), () => act('strike', null)),
    button('批注', 'mark-note', icon('note'), () => {
      hideSelectionToolbar();
      handlers.onNote(parts);
    }),
  );
  const lookupTarget = firstWord(text);
  if (handlers.lookupEnabled() && lookupTarget !== null) {
    bar.append(
      button('查词', 'mark-lookup', icon('search'), () => {
        hideSelectionToolbar();
        handlers.onLookup(lookupTarget, rect);
      }),
    );
  }
  bar.append(
    button('复制', 'mark-copy', icon('copy'), () => {
      hideSelectionToolbar();
      handlers.onCopy(text);
    }),
  );
  if (handlers.isReanchorPending()) {
    bar.append(
      button('挂载到此', 'mark-reanchor', icon('check'), () => {
        hideSelectionToolbar();
        handlers.onReanchor(parts);
      }),
    );
  }
  return bar;
}

function mountSelectionToolbar(parts: readonly SelectionPart[], rect: DOMRect, handlers: SelectionHandlers): void {
  activeToolbar?.remove();
  activeToolbar = null;
  if (parts.length === 0) return;
  const text = parts.map((part) => part.quote).join('');
  if (text.trim().length === 0) return;
  const bar = buildSelectionToolbar(parts, rect, handlers);
  placeBar(bar, rect);
  activeToolbar = bar;
}

function createHandle(side: 'start' | 'end'): HTMLElement {
  return el(
    'div',
    {
      class: `sel-handle sel-handle--${side}`,
      'data-testid': `sel-handle-${side}`,
      role: 'slider',
      'aria-label': side === 'start' ? '调整选区起点' : '调整选区终点',
    },
    el('span', { class: 'sel-handle__bar', 'aria-hidden': 'true' }),
    el('span', { class: 'sel-handle__knob', 'aria-hidden': 'true' }),
  );
}

function positionHandles(range: Range): void {
  if (activeHandles === null) return;
  const edges = getRangeEdgeRects(range);
  if (edges === null) return;

  const startLineH = Math.max(16, edges.start.height);
  const startOff = edges.start.bottom < -12 || edges.start.top > window.innerHeight + 12;
  activeHandles.start.hidden = startOff;
  activeHandles.start.style.setProperty('left', `${Math.round(edges.start.left - 28)}px`);
  activeHandles.start.style.setProperty('top', `${Math.round(edges.start.top - 20)}px`);
  activeHandles.start.style.setProperty('height', `${Math.round(startLineH + 24)}px`);

  const endLineH = Math.max(16, edges.end.height);
  const endOff = edges.end.bottom < -12 || edges.end.top > window.innerHeight + 12;
  activeHandles.end.hidden = endOff;
  activeHandles.end.style.setProperty('left', `${Math.round(edges.end.right - 10)}px`);
  activeHandles.end.style.setProperty('top', `${Math.round(edges.end.top - 4)}px`);
  activeHandles.end.style.setProperty('height', `${Math.round(endLineH + 24)}px`);
}

/** 已有标注的动作条：删除 / 编辑备注 / 复制原文。 */
export function showMarkActions(
  rect: DOMRect,
  handlers: { onDelete: () => void; onEditNote: () => void; onCopy: (text: string) => void; quote: string },
): void {
  hideSelectionToolbar();
  const bar = el('div', { class: 'sel-toolbar', role: 'toolbar', 'data-testid': ACTION_TOOLBAR });
  bar.append(
    button('删除标注', 'mark-delete', icon('trash'), () => {
      hideSelectionToolbar();
      handlers.onDelete();
    }),
    button('编辑备注', 'mark-edit-note', icon('note'), () => {
      hideSelectionToolbar();
      handlers.onEditNote();
    }),
    button('复制原文', 'mark-copy-text', icon('copy'), () => {
      hideSelectionToolbar();
      handlers.onCopy(handlers.quote);
    }),
  );
  placeBar(bar, rect);
  activeToolbar = bar;
}

/** 取文本里第一个英文单词（查词按钮用）；没有返回 null。 */
function firstWord(text: string): string | null {
  const match = /[A-Za-z][A-Za-z'’-]*/.exec(text);
  return match === null ? null : match[0];
}

// ── 坐标系与命中点 ─────────────────────────────────

/**
 * 把**视觉**坐标换算回**布局**坐标（1.2.1 #D）。
 *
 * `pointerdown` 给的是视觉坐标，`caretRangeFromPoint()` 用的是布局坐标。
 * 平时两者相同，但只要有祖先带 `transform: scale()`（转场形变壳），
 * 就会差 `1/scale` 倍 —— 那时 `caretRangeFromPoint` 会命中形变壳自身
 * 而不是文本节点，长按选词失效。
 *
 * 公式（transform-origin = (ox, oy)，无 translate 分量参与）：
 * `P = origin + (visual − origin) / scale`
 *
 * @param x 视觉坐标 x
 * @param y 视觉坐标 y
 * @param transform 当前形变壳的 scale 与 transform-origin（px）
 */
export function toLayoutPoint(
  x: number,
  y: number,
  transform: { readonly scale: number; readonly originX: number; readonly originY: number },
): { readonly x: number; readonly y: number } {
  const s = transform.scale;
  if (!Number.isFinite(s) || s <= 0) return { x, y };
  return {
    x: transform.originX + (x - transform.originX) / s,
    y: transform.originY + (y - transform.originY) / s,
  };
}

/**
 * 当前阅读页是否处在带缩放的形变壳里；返回 null 表示正常态、无需换算。
 */
function activeMorphTransform(article: HTMLElement): { scale: number; originX: number; originY: number } | null {
  const shell = article.closest<HTMLElement>('[data-testid="page-mask"]');
  if (shell === null) return null;
  const layoutH = shell.offsetHeight;
  const visualH = shell.getBoundingClientRect().height;
  if (layoutH <= 0 || visualH <= 0) return null;
  const scale = visualH / layoutH;
  if (!Number.isFinite(scale) || scale >= 0.999) return null;
  const parts = getComputedStyle(shell).transformOrigin.split(' ').map((v) => parseFloat(v) || 0);
  return { scale, originX: parts[0] ?? 0, originY: parts[1] ?? 0 };
}

/** 命中探测时暂时让自绘浮层穿透，避免手柄或工具条自身抢走 caretRangeFromPoint。 */
function withOverlayPassThrough<T>(fn: () => T): T {
  const nodes: HTMLElement[] = [];
  if (activeHandles !== null) nodes.push(activeHandles.start, activeHandles.end);
  if (activeToolbar !== null) nodes.push(activeToolbar);
  const prev = nodes.map((node) => node.style.pointerEvents);
  for (const node of nodes) node.style.pointerEvents = 'none';
  try {
    return fn();
  } finally {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node !== undefined) node.style.pointerEvents = prev[i] ?? '';
    }
  }
}

function probeCaret(
  article: HTMLElement,
  caretFromPoint: (left: number, top: number) => Range | null,
  x: number,
  y: number,
  morph: { scale: number; originX: number; originY: number } | null,
): TextPoint | null {
  const pt = morph === null ? { x, y } : toLayoutPoint(x, y, morph);
  const range = caretFromPoint(pt.x, pt.y);
  if (range === null) return null;
  return normalizeRangeEndpoint(article, range.startContainer, range.startOffset, 'start');
}

function textPointAt(article: HTMLElement, x: number, y: number, clampX = false): TextPoint | null {
  const doc = document as unknown as { caretRangeFromPoint?: (left: number, top: number) => Range | null };
  if (typeof doc.caretRangeFromPoint !== 'function') return null;
  const caretFromPoint = (left: number, top: number): Range | null => doc.caretRangeFromPoint!(left, top);
  // #D：转场期间先换算回布局坐标，否则永远命不中文本节点
  const morph = activeMorphTransform(article);

  return withOverlayPassThrough(() => {
    const direct = probeCaret(article, caretFromPoint, x, y, morph);
    if (direct !== null) return direct;
    if (!clampX) return null;

    const rect = article.getBoundingClientRect();
    if (rect.width <= 40) return null;
    const cs = getComputedStyle(article);
    const padL = parseFloat(cs.paddingLeft) || 16;
    const padR = parseFloat(cs.paddingRight) || 16;
    const minX = rect.left + padL + 2;
    const maxX = rect.right - padR - 2;
    if (maxX <= minX) return null;
    const clampedX = Math.max(minX, Math.min(maxX, x));
    if (clampedX === x) return null;
    return probeCaret(article, caretFromPoint, clampedX, y, morph);
  });
}

function blockOfPoint(article: HTMLElement, point: TextPoint): HTMLElement | null {
  const block = point.node.parentElement?.closest<HTMLElement>('[data-bid]') ?? null;
  if (block === null || !article.contains(block)) return null;
  return block;
}

/** 长按取词/选段：英文取整词，中文及其他语言取所在词或字，确保均可呼出工具条；取不到返回 null。 */
function wordRangeAtPoint(
  article: HTMLElement,
  point: TextPoint,
  blockTexts: ReadonlyMap<string, string> | null,
): { range: Range; rect: DOMRect } | null {
  if (blockTexts === null) return null;
  const block = blockOfPoint(article, point);
  if (block === null) return null;
  const index = buildNormalizedIndex(block);
  const offset = offsetAtPoint(index, block, point.node, point.offset, 'start');
  const word = longPressRangeInText(index.text, offset);
  if (word === null) return null;
  const startPos = index.positions[word.start];
  const endPos = index.positions[word.end - 1];
  if (startPos === undefined || endPos === undefined) return null;
  const range = document.createRange();
  try {
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset + 1);
  } catch {
    return null;
  }
  return { range, rect: range.getBoundingClientRect() };
}

/** 在归一化文本里找 offset 所在英文单词的 [start,end)。 */
export function wordRangeInText(text: string, offset: number): { start: number; end: number } | null {
  const isWord = (ch: string): boolean => /[A-Za-z'’-]/.test(ch);
  if (text.length === 0) return null;
  let at = Math.min(Math.max(0, offset), text.length - 1);
  // 光标常停在词尾：往回退一格
  if (!isWord(text[at] ?? '') && at > 0 && isWord(text[at - 1] ?? '')) at -= 1;
  if (!isWord(text[at] ?? '')) return null;
  let start = at;
  let end = at + 1;
  while (start > 0 && isWord(text[start - 1] ?? '')) start -= 1;
  while (end < text.length && isWord(text[end] ?? '')) end += 1;
  return { start, end };
}

interface WordSegment {
  readonly segment: string;
  readonly index: number;
  readonly isWordLike?: boolean;
}

type WordSegmenterCtor = new (locale: string, options: { granularity: 'word' }) => {
  segment(input: string): Iterable<WordSegment>;
};

const BREAK_CHAR_RE = /[\s，。！？、；：“”‘’（）【】《》,.!?;:'"()[\]{}<>·—…`~@#$%^&*+=|\\/]/;

/**
 * 通用长按选区范围（支持英文、中文、日韩文、数字及混排正文）：
 *   1. 若命中英文单词，沿用完整英文取词（供「查词」与标注共用）
 *   2. 否则利用系统 Intl.Segmenter 对中文等语言按词切分；退化环境选相邻词片段或单字
 *   3. 仅在空白位置返回 null
 */
export function longPressRangeInText(text: string, offset: number): { start: number; end: number } | null {
  if (text.length === 0) return null;
  const eng = wordRangeInText(text, offset);
  if (eng !== null) return eng;

  let at = Math.min(Math.max(0, offset), text.length - 1);
  // 若落在标点或空白右侧，尝试往左退一格命中有效字符
  if (BREAK_CHAR_RE.test(text[at] ?? '') && at > 0 && !BREAK_CHAR_RE.test(text[at - 1] ?? '')) {
    at -= 1;
  }
  if (/\s/.test(text[at] ?? '')) return null;

  const segCtor = (Intl as unknown as { Segmenter?: WordSegmenterCtor }).Segmenter;
  if (typeof segCtor === 'function') {
    const segmenter = new segCtor('zh-CN', { granularity: 'word' });
    let prevWord: { start: number; end: number } | null = null;
    for (const seg of segmenter.segment(text)) {
      const segStart = seg.index;
      const segEnd = seg.index + seg.segment.length;
      if (seg.isWordLike === true) {
        prevWord = { start: segStart, end: segEnd };
      }
      if (at >= segStart && at < segEnd) {
        if (seg.isWordLike === true) {
          return { start: segStart, end: segEnd };
        }
        if (prevWord !== null && prevWord.end === segStart) {
          return prevWord;
        }
        return { start: at, end: at + 1 };
      }
    }
  }

  // 无 Intl.Segmenter 时的回落：取最多 4 个非分隔字符作为默认选中片段
  if (BREAK_CHAR_RE.test(text[at] ?? '')) return { start: at, end: at + 1 };
  let start = at;
  let end = at + 1;
  while (start > 0 && !BREAK_CHAR_RE.test(text[start - 1] ?? '') && end - start < 4) start -= 1;
  while (end < text.length && !BREAK_CHAR_RE.test(text[end] ?? '') && end - start < 4) end += 1;
  return { start, end };
}

function findScroller(article: HTMLElement): HTMLElement | null {
  const reader = article.closest<HTMLElement>('[data-testid="page-mask-reader"]');
  if (reader !== null) return reader;
  const mask = article.closest<HTMLElement>('[data-testid="page-mask"]');
  return mask;
}

function edgeScrollDelta(clientY: number): number {
  if (clientY < EDGE_SCROLL_ZONE_PX) {
    return -Math.min(8, Math.max(2, Math.round((EDGE_SCROLL_ZONE_PX - clientY) / 6)));
  }
  const bottomLimit = window.innerHeight - EDGE_SCROLL_ZONE_PX;
  if (clientY > bottomLimit) {
    return Math.min(8, Math.max(2, Math.round((clientY - bottomLimit) / 6)));
  }
  return 0;
}

function scrollByDelta(scroller: HTMLElement | null, delta: number): boolean {
  if (delta === 0) return false;
  if (scroller !== null) {
    const before = scroller.scrollTop;
    scroller.scrollTop += delta;
    return scroller.scrollTop !== before;
  }
  const before = window.scrollY;
  window.scrollBy(0, delta);
  return window.scrollY !== before;
}

// ── 手势绑定 ───────────────────────────────────

/**
 * 给正文绑定选区与标注手势。正文重建时先 hide() 再重新绑定。
 */
export function bindTextSelection(article: HTMLElement, handlers: SelectionHandlers): SelectionBinding {
  let timer: number | null = null;
  let nativeTimer: number | null = null;
  let activePointerId: number | null = null;
  let pointerType = '';
  let startPoint: TextPoint | null = null;
  let startX = 0;
  let startY = 0;
  let longPressFired = false;
  let longPressAnchor: { start: TextPoint; end: TextPoint } | null = null;
  let dragging = false;
  let touchMoveGuarded = false;
  let syncRaf: number | null = null;
  let isDraggingHandle = false;

  const clearTimer = (): void => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };

  const onTouchMoveGuard = (event: TouchEvent): void => {
    if (longPressFired && event.cancelable) event.preventDefault();
  };

  const setTouchMoveGuard = (enabled: boolean): void => {
    if (enabled === touchMoveGuarded) return;
    touchMoveGuarded = enabled;
    if (enabled) {
      article.addEventListener('touchmove', onTouchMoveGuard, { passive: false });
    } else {
      article.removeEventListener('touchmove', onTouchMoveGuard);
    }
  };

  const attachHandleDrag = (handle: HTMLElement, side: 'start' | 'end'): void => {
    let draggingPointerId: number | null = null;
    let fixedPoint: TextPoint | null = null;
    let grabOffsetX = 0;
    let grabOffsetY = 0;
    let lastClientX = 0;
    let lastClientY = 0;
    let autoScrollRaf: number | null = null;

    const stopAutoScroll = (): void => {
      if (autoScrollRaf !== null) {
        window.cancelAnimationFrame(autoScrollRaf);
        autoScrollRaf = null;
      }
    };

    const updateDragAt = (clientX: number, clientY: number): void => {
      if (fixedPoint === null) return;
      const moved = textPointAt(article, clientX + grabOffsetX, clientY + grabOffsetY, true);
      if (moved === null) return;
      const next = makeOrderedRange(fixedPoint, moved);
      if (next === null) return;
      if (rangeToParts(article, next).length === 0) return;
      activeRange = next;
      paintSelection([activeRange]);
      positionHandles(activeRange);
    };

    const runAutoScroll = (): void => {
      autoScrollRaf = null;
      if (draggingPointerId === null) return;
      const delta = edgeScrollDelta(lastClientY);
      if (delta === 0) return;
      const scrolled = scrollByDelta(findScroller(article), delta);
      if (scrolled) updateDragAt(lastClientX, lastClientY);
      autoScrollRaf = window.requestAnimationFrame(runAutoScroll);
    };

    const finishDrag = (): void => {
      if (draggingPointerId === null) return;
      const releasedPointer = draggingPointerId;
      draggingPointerId = null;
      isDraggingHandle = false;
      fixedPoint = null;
      cancelActiveDrag = null;
      stopAutoScroll();
      handle.classList.remove('is-dragging');
      try {
        if (handle.hasPointerCapture?.(releasedPointer) === true) {
          handle.releasePointerCapture(releasedPointer);
        }
      } catch {
        /* 合成事件/测试环境可能未绑定 capture */
      }
      if (activeRange !== null) {
        const parts = rangeToParts(article, activeRange);
        const edges = getRangeEdgeRects(activeRange);
        if (parts.length > 0 && edges !== null) {
          mountSelectionToolbar(parts, edges.box, handlers);
          positionHandles(activeRange);
        }
      }
      setToolbarHidden(false);
    };

    handle.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (activeRange === null) return;
      event.preventDefault();
      event.stopPropagation();
      pointerDownHadToolbar = true;
      window.getSelection()?.removeAllRanges();

      const curStart = normalizeRangeEndpoint(
        article,
        activeRange.startContainer,
        activeRange.startOffset,
        'start',
      );
      const curEnd = normalizeRangeEndpoint(
        article,
        activeRange.endContainer,
        activeRange.endOffset,
        'end',
      );
      if (curStart === null || curEnd === null) return;

      const edges = getRangeEdgeRects(activeRange);
      if (edges !== null && (edges.start.height > 0 || edges.end.height > 0)) {
        const targetX = side === 'start' ? edges.start.left : edges.end.right;
        const targetY =
          side === 'start'
            ? edges.start.top + edges.start.height / 2
            : edges.end.top + edges.end.height / 2;
        grabOffsetX = Math.max(-36, Math.min(36, targetX - event.clientX));
        grabOffsetY = Math.max(-44, Math.min(44, targetY - event.clientY));
      } else {
        grabOffsetX = 0;
        grabOffsetY = 0;
      }

      fixedPoint = side === 'start' ? curEnd : curStart;
      draggingPointerId = event.pointerId;
      isDraggingHandle = true;
      lastClientX = event.clientX;
      lastClientY = event.clientY;
      cancelActiveDrag = () => {
        stopAutoScroll();
        draggingPointerId = null;
        isDraggingHandle = false;
        fixedPoint = null;
        handle.classList.remove('is-dragging');
      };
      handle.classList.add('is-dragging');
      setToolbarHidden(true);
      try {
        handle.setPointerCapture?.(event.pointerId);
      } catch {
        /* 合成 PointerEvent 在 jsdom 下可能抛异常 */
      }
      if (edgeScrollDelta(lastClientY) !== 0 && autoScrollRaf === null) {
        autoScrollRaf = window.requestAnimationFrame(runAutoScroll);
      }
    });

    handle.addEventListener('pointermove', (event: PointerEvent) => {
      if (draggingPointerId !== event.pointerId) return;
      event.preventDefault();
      lastClientX = event.clientX;
      lastClientY = event.clientY;
      updateDragAt(lastClientX, lastClientY);
      if (edgeScrollDelta(lastClientY) !== 0 && autoScrollRaf === null) {
        autoScrollRaf = window.requestAnimationFrame(runAutoScroll);
      }
    });

    handle.addEventListener('pointerup', (event: PointerEvent) => {
      if (draggingPointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      finishDrag();
    });

    handle.addEventListener('pointercancel', (event: PointerEvent) => {
      if (draggingPointerId !== event.pointerId) return;
      finishDrag();
    });
  };

  const syncOverlayPositions = (): void => {
    syncRaf = null;
    if (isDraggingHandle || activeRange === null) return;
    positionHandles(activeRange);
    if (activeToolbar !== null && !activeToolbar.classList.contains('sel-toolbar--hidden')) {
      const edges = getRangeEdgeRects(activeRange);
      if (edges !== null) positionToolbar(activeToolbar, edges.box);
    }
  };

  const onViewportChange = (): void => {
    if (isDraggingHandle || activeRange === null || syncRaf !== null) return;
    syncRaf = window.requestAnimationFrame(syncOverlayPositions);
  };

  const showForRange = (range: Range, _rect: DOMRect, showToolbar = true): boolean => {
    const parts = rangeToParts(article, range);
    if (parts.length === 0) return false;
    const edges = getRangeEdgeRects(range);
    if (edges === null) return false;

    const cloned = range.cloneRange();
    hideSelectionToolbar();
    activeRange = cloned;
    paintSelection([activeRange]);

    const startHandle = createHandle('start');
    const endHandle = createHandle('end');
    attachHandleDrag(startHandle, 'start');
    attachHandleDrag(endHandle, 'end');
    activeHandles = { start: startHandle, end: endHandle };
    document.body.append(startHandle, endHandle);
    positionHandles(activeRange);

    if (showToolbar) {
      mountSelectionToolbar(parts, edges.box, handlers);
    }

    document.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
    window.addEventListener('resize', onViewportChange, { passive: true });
    activeCleanup = () => {
      if (syncRaf !== null) {
        window.cancelAnimationFrame(syncRaf);
        syncRaf = null;
      }
      document.removeEventListener('scroll', onViewportChange, { capture: true });
      window.removeEventListener('resize', onViewportChange);
      clearSelectionHighlight();
    };
    return true;
  };

  const activateLongPressAt = (point: TextPoint): void => {
    const word = wordRangeAtPoint(article, point, handlers.blockTexts());
    if (word === null) return;
    if (!showForRange(word.range, word.rect, true)) return;
    longPressFired = true;
    pointerDownHadToolbar = true;
    try {
      navigator.vibrate?.(10);
    } catch {
      /* 不支持震动反馈 */
    }
    const anchorStart = normalizeRangeEndpoint(
      article,
      word.range.startContainer,
      word.range.startOffset,
      'start',
    );
    const anchorEnd = normalizeRangeEndpoint(
      article,
      word.range.endContainer,
      word.range.endOffset,
      'end',
    );
    longPressAnchor =
      anchorStart !== null && anchorEnd !== null ? { start: anchorStart, end: anchorEnd } : null;
    setTouchMoveGuard(true);
  };

  /**
   * 转场期间按下的那一下（1.2.1 #D 的补发机制）。
   *
   * 转场进行中正文还在挂载（首屏只有 64 块、`data-article` 尚未 complete），
   * 这时长按取不到词是**正常的**：内容还没稳定，取到的位置随时会变。
   *
   * 但用户不该「按了完全没反应」。所以这里把「按下时没取到词」的位置记下来，
   * 等转场结束（`mdlego:transition-end`）时如果手指还按着、且位置没怎么动，
   * 就按原位置补一次判定。这样「刚打开就长按」也能出工具条与拖动手柄。
   */
  let pendingPress: { x: number; y: number; at: number } | null = null;

  const resetGestureState = (): void => {
    clearTimer();
    pendingPress = null;
    setTouchMoveGuard(false);
    activePointerId = null;
    pointerType = '';
    startPoint = null;
    longPressFired = false;
    longPressAnchor = null;
    dragging = false;
  };

  const onDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    hideSelectionToolbar();
    resetGestureState();
    const point =
      textPointAt(article, event.clientX, event.clientY) ??
      textPointAt(article, event.clientX, event.clientY, true);
    if (point === null) {
      // 取不到词：转场中 / 正文未就位 —— 记下位置，等转场结束补判
      pendingPress = { x: event.clientX, y: event.clientY, at: performance.now() };
      return;
    }
    activePointerId = event.pointerId;
    pointerType = event.pointerType;
    startPoint = point;
    startX = event.clientX;
    startY = event.clientY;
    timer = window.setTimeout(() => {
      timer = null;
      activateLongPressAt(point);
    }, LONG_PRESS_MS);
  };

  const onMove = (event: PointerEvent): void => {
    if (startPoint === null) return;
    if (activePointerId !== null && event.pointerId !== activePointerId) return;
    const movedEnough = Math.hypot(event.clientX - startX, event.clientY - startY) > DRAG_TOLERANCE_PX;

    if (!longPressFired) {
      if (!movedEnough) return;
      clearTimer();
      // 触摸在长按达成前滑动 → 是正常翻页/上下滚动，绝不抢占滚动手势
      if (pointerType === 'touch') {
        startPoint = null;
        pendingPress = null;
        return;
      }
      dragging = true;
      setToolbarHidden(true);
    } else if (!dragging && movedEnough) {
      dragging = true;
      setToolbarHidden(true);
    }

    if (!dragging) return;
    const current = textPointAt(article, event.clientX, event.clientY, true);
    if (current === null) return;

    let next: Range | null = null;
    if (longPressAnchor !== null) {
      if (compareTextPoints(current, longPressAnchor.start) < 0) {
        next = makeOrderedRange(current, longPressAnchor.end);
      } else if (compareTextPoints(current, longPressAnchor.end) > 0) {
        next = makeOrderedRange(longPressAnchor.start, current);
      } else {
        next = makeOrderedRange(longPressAnchor.start, longPressAnchor.end);
      }
    } else {
      next = makeOrderedRange(startPoint, current);
    }

    if (next === null) return;
    if (activeHandles === null) {
      showForRange(next, next.getBoundingClientRect(), false);
    } else if (rangeToParts(article, next).length > 0) {
      activeRange = next;
      paintSelection([activeRange]);
      positionHandles(activeRange);
    }
  };

  const finalizeTouchDrag = (wasDragging: boolean, wasLongPress: boolean): void => {
    if (wasDragging && activeRange !== null) {
      const parts = rangeToParts(article, activeRange);
      const edges = getRangeEdgeRects(activeRange);
      if (parts.length > 0 && edges !== null) {
        mountSelectionToolbar(parts, edges.box, handlers);
        positionHandles(activeRange);
        setToolbarHidden(false);
        return;
      }
      hideSelectionToolbar();
      return;
    }
    if (wasLongPress) {
      setToolbarHidden(false);
    }
  };

  const onUp = (event: PointerEvent): void => {
    if (activePointerId !== null && event.pointerId !== activePointerId) return;
    const wasDragging = dragging;
    const wasLongPress = longPressFired;
    resetGestureState();

    if (wasDragging || wasLongPress) {
      finalizeTouchDrag(wasDragging, wasLongPress);
      return;
    }

    // 没有拖选/长按：可能是点了一下已有标注
    const blockTexts = handlers.blockTexts();
    if (blockTexts === null) return;
    const markId = markAtPoint(article, blockTexts, event.clientX, event.clientY);
    if (markId !== null) {
      const rect = new DOMRect(event.clientX - 12, event.clientY - 12, 24, 24);
      handlers.onMarkTap(markId, rect);
    }
  };

  const onCancel = (event: PointerEvent): void => {
    if (activePointerId !== null && event.pointerId !== activePointerId) return;
    const wasDragging = dragging;
    const wasLongPress = longPressFired;
    resetGestureState();
    if (wasDragging || wasLongPress) {
      finalizeTouchDrag(wasDragging, wasLongPress);
    }
  };

  const onNativeSelection = (): void => {
    if (nativeTimer !== null) window.clearTimeout(nativeTimer);
    nativeTimer = window.setTimeout(() => {
      nativeTimer = null;
      const selection = window.getSelection();
      if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      if (!article.contains(range.commonAncestorContainer)) return;
      showForRange(range, range.getBoundingClientRect(), true);
    }, NATIVE_SELECTION_DEBOUNCE_MS);
  };

  /**
   * 工具条或游标手柄外的 pointerdown 要先收起选区（捕获阶段，早于正文自己的 onDown）。
   *
   * 同时记下「这一下按下时工具条/手柄是否还开着」：pointerdown 已经把选区收掉了，
   * 等到 click 再查 DOM 就永远查不到。阅读页「点空白处切沉浸」靠它判断
   * 这一下应该只关工具条，还是继续切换沉浸。
   */
  const onOutsideDown = (event: Event): void => {
    pointerDownHadToolbar = activeToolbar !== null || activeHandles !== null;
    if (!pointerDownHadToolbar) return;
    const target = event.target;
    if (
      target instanceof Element &&
      (target.closest('.sel-toolbar') !== null || target.closest('.sel-handle') !== null)
    ) {
      return;
    }
    hideSelectionToolbar();
  };

  /**
   * 转场结束：如果按下时没取到词，按原位置补一次长按判定。
   *
   * 只在「手指仍按着」时补：`pointerup` 会把 pendingPress 清掉。
   * 用 `elementFromPoint` 先确认按的点确实落在正文上，避免误触发。
   */
  const retryPendingPress = (): void => {
    if (pendingPress === null) return;
    const { x, y } = pendingPress;
    const point = textPointAt(article, x, y);
    if (point === null) {
      // 还取不到（正文仍在挂载）：留着，等 article-complete 再试一次。
      // 加一个老化上限：超过 4s 还没机会补判就放弃，避免用户早已松手
      // 却在很久之后突然弹出工具条。
      if (performance.now() - pendingPress.at > 4000) pendingPress = null;
      return;
    }
    pendingPress = null;
    activateLongPressAt(point);
  };
  document.addEventListener('mdlego:transition-end', retryPendingPress);
  // 正文全部挂载完成后也试一次：转场结束时首屏可能只挂了 64 块，
  // 用户按的位置在前插补齐之后才落到正确段落里。
  document.addEventListener('mdlego:article-complete', retryPendingPress);

  // 吞掉 WebView 原生长按菜单与选区启动，防止与自绘长按竞争触发 pointercancel
  const preventNativeLongPress = (event: Event): void => {
    event.preventDefault();
  };

  article.addEventListener('contextmenu', preventNativeLongPress, { capture: true });
  article.addEventListener('selectstart', preventNativeLongPress, { capture: true });
  article.addEventListener('pointerdown', onDown);
  article.addEventListener('pointermove', onMove);
  article.addEventListener('pointerup', onUp);
  article.addEventListener('pointercancel', onCancel);
  document.addEventListener('selectionchange', onNativeSelection);
  document.addEventListener('pointerdown', onOutsideDown, { capture: true });

  return {
    hide(): void {
      resetGestureState();
      hideSelectionToolbar();
    },
    destroy(): void {
      resetGestureState();
      if (nativeTimer !== null) window.clearTimeout(nativeTimer);
      nativeTimer = null;
      article.removeEventListener('contextmenu', preventNativeLongPress, { capture: true });
      article.removeEventListener('selectstart', preventNativeLongPress, { capture: true });
      article.removeEventListener('pointerdown', onDown);
      article.removeEventListener('pointermove', onMove);
      article.removeEventListener('pointerup', onUp);
      article.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('mdlego:transition-end', retryPendingPress);
      document.removeEventListener('mdlego:article-complete', retryPendingPress);
      document.removeEventListener('selectionchange', onNativeSelection);
      document.removeEventListener('pointerdown', onOutsideDown, { capture: true });
      hideSelectionToolbar();
    },
  };
}
