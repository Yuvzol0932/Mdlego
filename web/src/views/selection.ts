/**
 * 正文选区与标注工具条（阶段 E2）。
 *
 * 为什么自绘选区：M5 为了让长按查词不被系统菜单抢走，给 .article 关了 user-select；
 * Android WebView 的系统 ActionMode 又无法定制。这里自己做：
 *   - 长按 500ms → 取词并选中
 *   - 按住拖动 → 从起点到当前点构造 Range（可跨块）
 *   - 选区用 CSS Highlight API 显示（与标注同一套机制，不改正文 DOM）
 *   - 松手弹工具条：4 色高亮 / 下划线 / 删除线 / 批注 / 查词 / 复制 / 挂载
 *
 * 兼容路径：浏览器原生选区（桌面调试/自动化）落在正文里时，selectionchange 也会弹条。
 * 本模块只做 DOM 与交互：偏移换算/高亮绘制在 marks-render，数据持久化在 main。
 */

import type { HighlightColor, MarkType, SelectionPart } from '../core/types';
import { el, icon } from './app';
import { buildNormalizedIndex, markAtPoint, type NormalizedIndex } from './marks-render';

/** 长按选词判定时长（与 M5 查词一致）。 */
const LONG_PRESS_MS = 500;
/** 移动超过这个距离视为拖选而不是长按。 */
const DRAG_TOLERANCE_PX = 8;
/** 原生选区兼容路径的防抖。 */
const NATIVE_SELECTION_DEBOUNCE_MS = 120;
/** 选区 Highlight 组名。 */
const SELECTION_GROUP = 'mdlego-selection';
/** 工具条 testid（文档里也是断言契约）。 */
const SELECTION_TOOLBAR = 'mark-toolbar';
const ACTION_TOOLBAR = 'mark-actions';

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

/** 同一时刻只允许一个工具条。 */
let activeToolbar: HTMLElement | null = null;
/** 最近一次 pointerdown 发生时工具条是否可见（供阅读页点击逻辑消费）。 */
let pointerDownHadToolbar = false;

/** 取走「按下时工具条是否开着」并复位，保证一次点击只消费一次。 */
export function consumeToolbarOnPointerDown(): boolean {
  const value = pointerDownHadToolbar;
  pointerDownHadToolbar = false;
  return value;
}
let activeClear: (() => void) | null = null;

/** 收起工具条与选区高亮。 */
export function hideSelectionToolbar(): void {
  activeToolbar?.remove();
  activeToolbar = null;
  activeClear?.();
  activeClear = null;
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

// ── 工具条 ─────────────────────────────────────

function placeBar(bar: HTMLElement, rect: DOMRect): void {
  document.body.append(bar);
  const width = bar.offsetWidth || 300;
  const height = bar.offsetHeight || 44;
  const center = rect.left + rect.width / 2;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, center - width / 2));
  const above = rect.top - height - 8;
  const top = above > 8 ? above : Math.min(window.innerHeight - height - 8, rect.bottom + 8);
  bar.style.setProperty('left', `${Math.round(left)}px`);
  bar.style.setProperty('top', `${Math.round(top)}px`);
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

function showSelectionToolbar(parts: readonly SelectionPart[], rect: DOMRect, handlers: SelectionHandlers): void {
  hideSelectionToolbar();
  const text = parts.map((part) => part.quote).join('');
  if (text.trim().length === 0) return;

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
  if (handlers.lookupEnabled()) {
    bar.append(
      button('查词', 'mark-lookup', icon('search'), () => {
        const word = firstWord(text);
        hideSelectionToolbar();
        if (word !== null) handlers.onLookup(word, rect);
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

  placeBar(bar, rect);
  activeToolbar = bar;
  activeClear = () => clearSelectionHighlight();
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
  const match = /[A-Za-z][A-Za-z'-]*/.exec(text);
  return match === null ? null : match[0];
}

// ── 手势绑定 ───────────────────────────────────

interface TextPoint {
  readonly node: Text;
  readonly offset: number;
}

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

function textPointAt(article: HTMLElement, x: number, y: number): TextPoint | null {
  const doc = document as unknown as { caretRangeFromPoint?: (left: number, top: number) => Range | null };
  if (typeof doc.caretRangeFromPoint !== 'function') return null;
  // #D：转场期间先换算回布局坐标，否则永远命不中文本节点
  const morph = activeMorphTransform(article);
  const pt = morph === null ? { x, y } : toLayoutPoint(x, y, morph);
  const range = doc.caretRangeFromPoint(pt.x, pt.y);
  if (range === null || range.startContainer.nodeType !== Node.TEXT_NODE) return null;
  return { node: range.startContainer as Text, offset: range.startOffset };
}

function blockOfPoint(article: HTMLElement, point: TextPoint): HTMLElement | null {
  const block = point.node.parentElement?.closest<HTMLElement>('[data-bid]') ?? null;
  if (block === null || !article.contains(block)) return null;
  return block;
}

/** 长按取词：Range + 矩形；取不到返回 null。 */
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
  const word = wordRangeInText(index.text, offset);
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
  const isWord = (ch: string): boolean => /[A-Za-z'-]/.test(ch);
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

/**
 * 给正文绑定选区与标注手势。正文重建时先 hide() 再重新绑定。
 */
export function bindTextSelection(article: HTMLElement, handlers: SelectionHandlers): SelectionBinding {
  let timer: number | null = null;
  let nativeTimer: number | null = null;
  let startPoint: TextPoint | null = null;
  let startX = 0;
  let startY = 0;
  let dragging = false;
  let dragRange: Range | null = null;

  const clearTimer = (): void => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };

  const showForRange = (range: Range, rect: DOMRect): void => {
    const parts = rangeToParts(article, range);
    if (parts.length === 0) return;
    paintSelection([range]);
    showSelectionToolbar(parts, rect, handlers);
  };

  /**
   * 转场期间按下的那一下（1.2.1 #D 的补发机制）。
   *
   * 转场进行中正文还在挂载（首屏只有 64 块、`data-article` 尚未 complete），
   * 这时长按取不到词是**正常的**：内容还没稳定，取到的位置随时会变。
   *
   * 但用户不该「按了完全没反应」。所以这里把「按下时没取到词」的位置记下来，
   * 等转场结束（`mdlego:transition-end`）时如果手指还按着、且位置没怎么动，
   * 就按原位置补一次判定。这样「刚打开就长按」也能出工具条。
   */
  let pendingPress: { x: number; y: number; at: number } | null = null;

  const onDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    hideSelectionToolbar();
    const point = textPointAt(article, event.clientX, event.clientY);
    if (point === null) {
      // 取不到词：转场中 / 正文未就位 —— 记下位置，等转场结束补判
      pendingPress = { x: event.clientX, y: event.clientY, at: performance.now() };
      return;
    }
    pendingPress = null;
    startPoint = point;
    startX = event.clientX;
    startY = event.clientY;
    dragging = false;
    dragRange = null;
    clearTimer();
    timer = window.setTimeout(() => {
      timer = null;
      const word = wordRangeAtPoint(article, point, handlers.blockTexts());
      if (word !== null) showForRange(word.range, word.rect);
    }, LONG_PRESS_MS);
  };

  const onMove = (event: PointerEvent): void => {
    if (startPoint === null) return;
    if (!dragging && Math.hypot(event.clientX - startX, event.clientY - startY) > DRAG_TOLERANCE_PX) {
      dragging = true;
      clearTimer();
      dragRange = document.createRange();
      dragRange.setStart(startPoint.node, startPoint.offset);
    }
    if (!dragging || dragRange === null) return;
    const current = textPointAt(article, event.clientX, event.clientY);
    if (current === null) return;
    try {
      dragRange.setEnd(current.node, current.offset);
    } catch {
      return;
    }
    paintSelection(dragRange.collapsed ? [] : [dragRange]);
  };

  const onUp = (event: PointerEvent): void => {
    clearTimer();
    pendingPress = null;
    const wasDragging = dragging;
    const range = dragRange;
    startPoint = null;
    dragging = false;
    dragRange = null;
    if (wasDragging && range !== null) {
      if (range.collapsed) clearSelectionHighlight();
      else showForRange(range, range.getBoundingClientRect());
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

  const onNativeSelection = (): void => {
    if (nativeTimer !== null) window.clearTimeout(nativeTimer);
    nativeTimer = window.setTimeout(() => {
      nativeTimer = null;
      const selection = window.getSelection();
      if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return;
      const range = selection.getRangeAt(0);
      if (!article.contains(range.commonAncestorContainer)) return;
      showForRange(range, range.getBoundingClientRect());
    }, NATIVE_SELECTION_DEBOUNCE_MS);
  };

  /**
   * 工具条外的 pointerdown 要先收起工具条（捕获阶段，早于正文自己的 onDown）。
   *
   * 同时记下「这一下按下时工具条是否还开着」：pointerdown 已经把工具条收掉了，
   * 等到 click 再查 DOM 就永远查不到。阅读页「点空白处切沉浸」靠它判断
   * 这一下应该只关工具条，还是继续切换沉浸。
   */
  const onOutsideDown = (event: Event): void => {
    pointerDownHadToolbar = activeToolbar !== null;
    if (activeToolbar === null) return;
    const target = event.target;
    if (target instanceof Element && target.closest('.sel-toolbar') !== null) return;
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
    // 与用户自己长按同一套判定：直接出工具条（已经等过转场时长，够了）
    const word = wordRangeAtPoint(article, point, handlers.blockTexts());
    if (word !== null) showForRange(word.range, word.rect);
  };
  document.addEventListener('mdlego:transition-end', retryPendingPress);
  // 正文全部挂载完成后也试一次：转场结束时首屏可能只挂了 64 块，
  // 用户按的位置在前插补齐之后才落到正确段落里。
  document.addEventListener('mdlego:article-complete', retryPendingPress);

  article.addEventListener('pointerdown', onDown);
  article.addEventListener('pointermove', onMove);
  article.addEventListener('pointerup', onUp);
  document.addEventListener('selectionchange', onNativeSelection);
  document.addEventListener('pointerdown', onOutsideDown, { capture: true });

  return {
    hide(): void {
      clearTimer();
      hideSelectionToolbar();
    },
    destroy(): void {
      clearTimer();
      if (nativeTimer !== null) window.clearTimeout(nativeTimer);
      nativeTimer = null;
      article.removeEventListener('pointerdown', onDown);
      article.removeEventListener('pointermove', onMove);
      article.removeEventListener('pointerup', onUp);
      document.removeEventListener('mdlego:transition-end', retryPendingPress);
      document.removeEventListener('mdlego:article-complete', retryPendingPress);
      document.removeEventListener('selectionchange', onNativeSelection);
      document.removeEventListener('pointerdown', onOutsideDown, { capture: true });
      hideSelectionToolbar();
    },
  };
}
