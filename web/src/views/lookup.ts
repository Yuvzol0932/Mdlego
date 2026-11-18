/**
 * 长按查词 —— 手势判定 + 释义卡片。
 *
 * 分工（不越界）：
 *   - 取词用 core/text.ts 的 wordAt（纯函数，零 DOM）
 *   - 查词走 data/dict.ts（data 层是唯一 IO 边界，views 不许 fetch）
 *   - 这里只管手势与渲染
 *
 * 为什么不复用 RenderResult.blockTexts 取词：
 * blockTexts 是 collapseWhitespace 过的块纯文本，与 DOM 字符偏移不是一一对应，
 * 把 DOM 偏移套上去会取错词。所以直接从 DOM 文本节点取词，wordAt 两种用法都成立。
 */

import { wordAt } from '../core/text';
import { lookup } from '../data/dict';
import type { LookupResult } from '../core/types';
import { el, icon } from './app';

/** 长按判定时长，与系统长按同量级。 */
const LONG_PRESS_MS = 500;

/** 移动超过这个距离就认为在滚动，取消长按。 */
const MOVE_TOLERANCE_PX = 10;

/** 库外词提示的停留时间。 */
const MISS_HINT_MS = 2000;

/** 卡片根节点的选择器（卡片挂在正文里，手势要能识别出「这是卡片不是正文」）。 */
const CARD_SELECTOR = '[data-testid="lookup-card"]';

/** 查词卡片的动作钩子（由 main 注入：生词本 + 历史）。 */
export interface LookupHooks {
  readonly isSaved: (word: string) => boolean;
  readonly onToggleWord: (entry: { word: string; phonetic: string; translation: string }) => void;
  readonly onRecord: (word: string) => void;
}

/** 当前挂着的卡片/提示，供系统返回键关闭。 */
let activeCard: HTMLElement | null = null;
/** 当前生效的钩子（每次 lookupWord 由 main 更新）。 */
let hooks: LookupHooks | null = null;

/** 当前进行中的查词序号：并发长按时只让最后一次落地，避免旧结果盖新结果。 */
let requestToken = 0;

/** 关闭卡片。返回是否真的关掉了（供系统返回键判断要不要吃掉这次返回）。 */
export function closeLookupCard(): boolean {
  if (activeCard === null) return false;
  activeCard.remove();
  activeCard = null;
  visibilityListener?.(false);
  return true;
}

/** 卡片当前是否挂着。 */
export function isLookupCardOpen(): boolean {
  return activeCard !== null;
}

/** 卡片显隐通知：路由层据此把它登记为一层浮层，返回键才会先关它。 */
let visibilityListener: ((open: boolean) => void) | null = null;
export function onLookupVisibility(listener: (open: boolean) => void): void {
  visibilityListener = listener;
}

/** 把节点挂到正文里；正文被重建时卡片随旧节点一起消失，由路由层的浮层同步收尾。 */
function mount(article: HTMLElement, node: HTMLElement): void {
  closeLookupCard();
  article.append(node);
  activeCard = node;
  visibilityListener?.(true);
}

/** 释义卡片。字段严格对应 DictEntry，不多不少。 */
function renderCard(
  result: Extract<LookupResult, { hit: true }>,
  pressedWord: string,
  article: HTMLElement,
  activeHooks: LookupHooks | null,
): HTMLElement {
  const { entry, matchedBy } = result;

  const body = el('div', { class: 'lookup__body', 'data-testid': 'lookup-body' });

  if (entry.phonetic.trim().length > 0) {
    body.append(
      el('div', {
        class: 'lookup__phonetic',
        'data-testid': 'lookup-phonetic',
        text: entry.phonetic,
      }),
    );
  }

  body.append(el('div', { class: 'lookup__rule', 'aria-hidden': 'true' }));

  const lines = el('div', { class: 'lookup__translation', 'data-testid': 'lookup-translation' });
  for (const line of entry.translation.split('\n')) {
    if (line.trim().length === 0) continue;
    // 用 div 而不是 p：p 会被 .article p 的段间距规则波及
    lines.append(el('div', { class: 'lookup__line', text: line }));
  }
  body.append(lines);

  if (matchedBy === 'lemma') {
    // 规则/索引推断出来的释义，必须让用户知道这是推断（方案 §4.3）
    body.append(
      el('div', {
        class: 'lookup__lemma',
        'data-testid': 'lookup-lemma-hint',
        text: `按 ${entry.word} 释义`,
      }),
    );
  }

  const normalized = pressedWord.trim().toLowerCase();
  const saved = activeHooks?.isSaved(normalized) ?? false;
  const saveBtn = el(
    'button',
    {
      class: saved ? 'lookup__save lookup__save--on' : 'lookup__save',
      type: 'button',
      'data-testid': 'lookup-save-word',
      'aria-pressed': saved ? 'true' : 'false',
      'aria-label': saved ? '从生词本移除' : '加入生词本',
    },
    icon(saved ? 'check' : 'bookmark'),
    el('span', { text: saved ? '已收藏' : '生词本' }),
  );
  saveBtn.addEventListener('click', () => {
    activeHooks?.onToggleWord({
      word: normalized,
      phonetic: entry.phonetic,
      translation: entry.translation,
    });
    const nowSaved = activeHooks?.isSaved(normalized) ?? !saved;
    saveBtn.className = nowSaved ? 'lookup__save lookup__save--on' : 'lookup__save';
    saveBtn.setAttribute('aria-pressed', nowSaved ? 'true' : 'false');
    saveBtn.setAttribute('aria-label', nowSaved ? '从生词本移除' : '加入生词本');
    saveBtn.replaceChildren(
      icon(nowSaved ? 'check' : 'bookmark'),
      el('span', { text: nowSaved ? '已收藏' : '生词本' }),
    );
  });

  // 标题行只放「强调竖线 + 词 + 生词本 + 关闭」；把手是弹层自己的第一个子元素，
  // 明确不参与这一行的横排布局（否则会被挤到最左、与竖线抢位置）。
  const handle = el('span', {
    class: 'sheet-panel__handle lookup__handle',
    'data-testid': 'lookup-handle',
    'aria-hidden': 'true',
  });
  const head = el(
    'header',
    { class: 'drawer__head' },
    el('span', { class: 'lookup__accent', 'data-testid': 'lookup-accent', 'aria-hidden': 'true' }),
    el('h2', { class: 'drawer__title', 'data-testid': 'lookup-word', text: pressedWord }),
    saveBtn,
    el(
      'button',
      {
        class: 'icon-btn',
        type: 'button',
        'data-testid': 'lookup-close',
        'aria-label': '关闭',
        title: '关闭',
        onclick: () => closeLookupCard(),
      },
      icon('close'),
    ),
  );

  const mask = el('div', { class: 'mask', 'data-testid': 'lookup-mask' });
  bindDismissGesture(mask, article);

  return el(
    'div',
    { class: 'drawer-root lookup-root', 'data-testid': 'lookup-card' },
    mask,
    el(
      'div',
      { class: 'drawer drawer--bottom glass lookup-panel', role: 'dialog', 'aria-label': '释义' },
      handle,
      head,
      body,
    ),
  );
}

/**
 * 词库加载失败（网络/资源损坏/解压失败）的降级提示。
 * 必须和「未收录」区分开：否则用户会以为词库里没有这个词，而不是加载失败。
 * 点提示可重试。
 */
function mountDictError(article: HTMLElement, word: string): void {
  const hint = el(
    'div',
    { class: 'lookup-hint lookup-hint--error', 'data-testid': 'lookup-error', role: 'status' },
    el('span', { text: `词库加载失败，点此重试「${word}」` }),
  );
  hint.addEventListener('click', () => {
    closeLookupCard();
    void performLookup(article, word);
  });
  mount(article, hint);
  window.setTimeout(() => {
    hint.remove();
    if (activeCard === hint) activeCard = null;
  }, MISS_HINT_MS * 2);
}

/** 库外词提示：一行，2 秒自动消失。点一下也能立刻关掉。 */
function mountMissHint(article: HTMLElement, word: string): void {
  const hint = el('div', {
    class: 'lookup-hint',
    'data-testid': 'lookup-miss',
    role: 'status',
    text: `未收录：${word}`,
  });
  hint.addEventListener('click', () => {
    hint.remove();
    if (activeCard === hint) activeCard = null;
  });
  mount(article, hint);
  window.setTimeout(() => {
    hint.remove();
    if (activeCard === hint) activeCard = null;
  }, MISS_HINT_MS);
}

/** 在遮罩上：轻点关闭；长按则关掉卡片并在原位查下面的新词。 */
function bindDismissGesture(mask: HTMLElement, article: HTMLElement): void {
  let timer: number | null = null;
  let startX = 0;
  let startY = 0;

  const clear = (): void => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };

  mask.addEventListener('pointerdown', (event) => {
    startX = event.clientX;
    startY = event.clientY;
    clear();
    timer = window.setTimeout(() => {
      timer = null;
      const x = startX;
      const y = startY;
      // 先撤卡片，遮罩没了才能命中它下面的正文
      closeLookupCard();
      triggerAt(article, x, y);
    }, LONG_PRESS_MS);
  });
  mask.addEventListener('pointermove', (event) => {
    if (timer === null) return;
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > MOVE_TOLERANCE_PX) clear();
  });
  mask.addEventListener('pointerup', () => {
    const pending = timer !== null;
    clear();
    // 长按定时器还活着 → 这是一次轻点，关掉卡片
    if (pending) closeLookupCard();
  });
  mask.addEventListener('pointercancel', clear);
}

/** 取坐标处的「文本节点 + 节点内偏移」。取不到返回 null（调用方静默）。 */
function textPositionAt(x: number, y: number): { node: Text; offset: number } | null {
  // 非标准 API 走结构化转换，避免与 lib.dom 的类型声明冲突
  const doc = document as unknown as {
    caretRangeFromPoint?: (left: number, top: number) => Range | null;
    caretPositionFromPoint?: (left: number, top: number) => {
      offsetNode: Node;
      offset: number;
    } | null;
  };

  if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y);
    if (range !== null && range.startContainer.nodeType === 3) {
      return { node: range.startContainer as Text, offset: range.startOffset };
    }
  }

  if (typeof doc.caretPositionFromPoint === 'function') {
    const position = doc.caretPositionFromPoint(x, y);
    if (position !== null && position.offsetNode.nodeType === 3) {
      return { node: position.offsetNode as Text, offset: position.offset };
    }
  }

  return null;
}

/** 在坐标处取词并查。取不到合法英文词就完全静默。 */
function triggerAt(article: HTMLElement, x: number, y: number): void {
  if (!article.isConnected) return;
  const position = textPositionAt(x, y);
  if (position === null) return;

  const text = position.node.data;
  // 光标可能停在词尾（即下一个字符上），往回退一个字符再试一次
  const word =
    wordAt(text, position.offset) ??
    (position.offset > 0 ? wordAt(text, position.offset - 1) : null);
  if (word === null || word.length === 0) return;

  void performLookup(article, word);
}

/** 工具条「查词」入口：对给定词查询并渲染卡片（E2 起长按不再自动弹卡）。 */
export function lookupWord(article: HTMLElement, word: string, nextHooks: LookupHooks | null = null): void {
  const cleaned = word.trim().replace(/\s+/g, ' ');
  if (cleaned.length === 0 || cleaned.length > 40) return;
  hooks = nextHooks;
  void performLookup(article, cleaned);
}

/** 查词并渲染。查词失败/查不到都不抛错，绝不让长按把阅读页搞崩。 */
async function performLookup(article: HTMLElement, word: string): Promise<void> {
  const token = ++requestToken;
  let result: LookupResult;
  let failed = false;
  try {
    result = await lookup(word);
  } catch {
    failed = true;
    result = { hit: false };
  }
  // 期间又长按了别的词 → 这次结果作废
  if (token !== requestToken) return;
  // 期间页面被换掉（退出阅读页/重渲染）→ 不再往上挂
  if (!article.isConnected) return;
  if (failed) {
    mountDictError(article, word);
    return;
  }

  if (result.hit) {
    hooks?.onRecord(word);
    mount(article, renderCard(result, word, article, hooks));
  } else {
    mountMissHint(article, word);
  }
}

/** 这些地方长按不查词：链接、任务复选框、代码块、以及卡片自己。 */
function isExcluded(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  if (target.closest(CARD_SELECTOR) !== null) return true;
  if (target.closest('a') !== null) return true;
  if (target.closest('.task-box') !== null) return true;
  if (target.closest('pre') !== null) return true;
  return false;
}

/**
 * 给正文挂上长按查词。
 *
 * 三层避让系统选词菜单（方案 §5.1）：
 *   1. CSS：.article 关掉 user-select / -webkit-touch-callout（见 styles/dict.css）
 *   2. 事件：capture 阶段吞掉 contextmenu，部分 ROM 仍会弹 ActionMode
 *   3. 判定：自己算长按，不依赖系统默认行为
 */
export function bindLongPress(article: HTMLElement): void {
  article.addEventListener(
    'contextmenu',
    (event) => {
      event.preventDefault();
    },
    { capture: true },
  );

  let timer: number | null = null;
  let startX = 0;
  let startY = 0;
  let tracking = false;

  const clear = (): void => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    tracking = false;
  };

  article.addEventListener('pointerdown', (event) => {
    // 鼠标只认左键；触摸与手写笔不限
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (isExcluded(event.target)) return;

    clear();
    startX = event.clientX;
    startY = event.clientY;
    tracking = true;
    // 刻意不对 pointerdown 做 preventDefault：一旦阻止默认行为，滚动就拖死了
    timer = window.setTimeout(() => {
      timer = null;
      tracking = false;
      triggerAt(article, startX, startY);
    }, LONG_PRESS_MS);
  });

  article.addEventListener('pointermove', (event) => {
    if (!tracking) return;
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > MOVE_TOLERANCE_PX) clear();
  });

  article.addEventListener('pointerup', clear);
  article.addEventListener('pointercancel', clear);
}
