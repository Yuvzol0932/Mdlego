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
import { formLine, normalizePhonetic, parseTranslation } from '../core/dict-format';
import { allowsTransform, sheetDuration, type MotionLevel } from '../core/motion';
import { lookup } from '../data/dict';
import { enableSheetDrag, type SheetDragControl } from './sheet-drag';
import type { LookupResult } from '../core/types';
import { el, icon } from './app';

/** 长按判定时长，与系统长按同量级。 */
const LONG_PRESS_MS = 500;

/** 移动超过这个距离就认为在滚动，取消长按。 */
const MOVE_TOLERANCE_PX = 10;

/** 库外词提示的停留时间。 */
const MISS_HINT_MS = 2000;

/** 查词卡片根节点选择器（手势要能识别「这是卡片不是正文」）。 */
const CARD_SELECTOR = '[data-testid="lookup-card"]';

/** 词与弹层上沿之间至少留出的空隙（px）：贴着边看不清上下文。 */
const WORD_MARGIN_PX = 12;

/**
 * 把被查的词挪到弹层上方的可见区（lookup #6）。
 *
 * 只在「词会被挡住」时才滚，且只保证「词完整可见」为止 —— 不做居中对齐，
 * 也不在关闭后回滚：阅读位置变了就是变了，用户能接受；但绝不能把
 * 阅读进度写错（进度是 scrollTop / 文档高，滚动本身就同步，不需要额外处理）。
 */
function revealWordAbovePanel(article: HTMLElement, panel: HTMLElement, wordRect: DOMRect): void {
  const panelTop = panel.getBoundingClientRect().top;
  const limit = panelTop - WORD_MARGIN_PX;
  if (wordRect.bottom <= limit && wordRect.top >= 0) return;
  // 词在弹层上方还差多少；负数表示需要往下滚（词被顶到屏幕上方之外）
  const delta = wordRect.bottom > limit
    ? wordRect.bottom - limit
    : wordRect.top - WORD_MARGIN_PX;
  if (Math.abs(delta) < 2) return;
  if (!article.isConnected) return;
  // 用瞬时滚动：弹层刚出现，动画期间做平滑滚动会跟入场动画打架
  window.scrollBy({ top: delta, behavior: 'auto' });
}

/** 查词卡片的动作钩子（由 main 注入：生词本 + 历史 + 动效等级）。 */
export interface LookupHooks {
  readonly isSaved: (word: string) => boolean;
  readonly onToggleWord: (entry: { word: string; phonetic: string; translation: string }) => void;
  readonly onRecord: (word: string) => void;
  /**
   * 当前动效强度（lookup #8）。
   *
   * 可选：不传时按 full 处理（旧调用点与单测不必跟着改）。
   * 「动效：关/简约」下不挂跟手拖动 —— 把动画硬塞给关掉动效的用户是错的，
   * 他们仍然可以点遮罩或关闭键。
   */
  readonly motionLevel?: () => MotionLevel;
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
function mount(article: HTMLElement, node: HTMLElement, wordRect: DOMRect | null = null): void {
  closeLookupCard();
  article.append(node);
  activeCard = node;
  visibilityListener?.(true);
  if (wordRect !== null) {
    const panel = node.querySelector<HTMLElement>('.lookup-panel');
    // 弹层是刚挂上的同步节点，getBoundingClientRect 会强制一次布局 ——
    // 一次布局换「词不被挡住」，值得。命中不到面板（提示类节点）就不做让位。
    if (panel !== null) revealWordAbovePanel(article, panel, wordRect);
  }
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

  const phonetic = normalizePhonetic(entry.phonetic);
  const form = formLine(pressedWord, result.lemmaOf);
  if (phonetic.length > 0 || form !== null) {
    const meta = el('div', { class: 'lookup__meta' });
    if (phonetic.length > 0) {
      meta.append(
        el('div', {
          class: 'lookup__phonetic',
          'data-testid': 'lookup-phonetic',
          text: phonetic,
        }),
      );
    }
    if (form !== null) {
      meta.append(
        el('div', {
          class: 'lookup__form',
          'data-testid': 'lookup-form',
          text: form,
        }),
      );
    }
    body.append(meta);
  }

  body.append(el('div', { class: 'lookup__rule', 'aria-hidden': 'true' }));

  const lines = el('div', { class: 'lookup__translation', 'data-testid': 'lookup-translation' });
  for (const line of parseTranslation(entry.translation)) {
    // 每条释义是一整块（词性标签 + 正文），杜绝「被裁成半个」的可能
    const row = el('div', { class: 'lookup__line', 'data-testid': 'lookup-line' });
    if (line.pos !== null) {
      row.append(
        el('span', { class: 'lookup__pos', 'data-testid': 'lookup-pos', text: line.pos }),
      );
    }
    if (line.domain !== null) {
      row.append(
        el('span', { class: 'lookup__domain', 'data-testid': 'lookup-domain', text: line.domain }),
      );
    }
    row.append(el('span', { class: 'lookup__text', text: line.text }));
    lines.append(row);
  }
  body.append(lines);

  if (matchedBy === 'lemma' && form === null) {
    // 规则/索引推断出来的释义，必须让用户知道这是推断（方案 §4.3）。
    // 有词形行时这一行是冗余的（词形行已经说明「按 X 释义」），不再重复。
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
      class: saved
        ? 'lookup__action lookup__save lookup__save--on'
        : 'lookup__action lookup__save',
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
    saveBtn.className = nowSaved
      ? 'lookup__action lookup__save lookup__save--on'
      : 'lookup__action lookup__save';
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
        class: 'icon-btn lookup__action lookup__close',
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

  // 内容区外壳：真正的滚动容器是 .lookup__body，渐隐遮罩贴在它下沿（不进滚动流）
  const fade = el('span', {
    class: 'lookup__fade',
    'data-testid': 'lookup-fade',
    'aria-hidden': 'true',
  });
  const scroller = el('div', { class: 'lookup__scroll' }, body, fade);

  // 滚到底就把渐隐淡掉：已经到底了还在暗示「下面还有」是误导。
  // 内容不足一屏时同样视为到底（scrollHeight 与 clientHeight 相等）。
  const syncFade = (): void => {
    const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 1;
    scroller.setAttribute('data-at-end', atEnd ? '1' : '0');
  };
  body.addEventListener('scroll', syncFade, { passive: true });
  // 首帧就要按内容高度算一次：短词条不该显示「还能滚」的暗示
  window.requestAnimationFrame(syncFade);

  // 下拉关闭（lookup #8）：把手与整个标题行都能抓。
  //
  // 把手必须是弹层的第一个子元素（#1 的硬要求），所以不能用一个盖层把
  // 「把手 + 标题行」包起来；改成给 sheet-drag 传多个抓取元素，
  // 并在标题行里排除两个按钮（点它们是动作，不是拖拽）。
  const panel = el(
    'div',
    { class: 'drawer drawer--bottom glass lookup-panel', role: 'dialog', 'aria-label': '释义' },
    handle,
    head,
    scroller,
  );

  const root = el(
    'div',
    { class: 'drawer-root lookup-root', 'data-testid': 'lookup-card' },
    mask,
    panel,
  );

  const level = activeHooks?.motionLevel?.() ?? 'full';
  const drag: SheetDragControl = enableSheetDrag({
    panel,
    scrim: mask,
    handles: [handle, head],
    ignoreTargetSelector: '.lookup__action',
    // 与其它 bottom sheet 同口径：只有「动效：完整」才挂跟手拖动；
    // simple/off 仍可点遮罩或关闭键关掉（不强行塞动画给关掉动效的用户）。
    enabled: allowsTransform(level),
    durationMs: sheetDuration(level),
    onDismiss: () => closeLookupCard(),
  });
  // 卡片被移除时解绑，避免手势处理器留在已脱离文档的节点上
  const observer = new MutationObserver(() => {
    if (root.isConnected) return;
    drag.destroy();
    observer.disconnect();
  });
  observer.observe(article, { childList: true });

  return root;
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

/**
 * 被查词在屏幕上的矩形（lookup #6 用）。
 *
 * 长按路径可以直接拿到按下点；工具条路径拿到的是选区矩形。
 * 两者都算「用户此刻看着的那个词」，弹层不许把它盖住。
 */
interface WordAnchor {
  readonly rect: DOMRect;
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

  void performLookup(article, word, rectAt(position, word));
}

/** 命中的词在文本节点里的矩形（取整词范围，避免只拿到一个字符的宽度）。 */
function rectAt(position: { node: Text; offset: number }, word: string): DOMRect | null {
  const text = position.node.data;
  const at = text.indexOf(word, Math.max(0, position.offset - word.length));
  const start = at >= 0 ? at : Math.max(0, position.offset);
  const range = document.createRange();
  const safeStart = Math.min(start, Math.max(0, text.length - 1));
  const safeEnd = Math.min(text.length, safeStart + word.length);
  try {
    range.setStart(position.node, safeStart);
    range.setEnd(position.node, safeEnd);
    return range.getBoundingClientRect();
  } catch {
    return null;
  }
}

/**
 * 工具条「查词」入口：对给定词查询并渲染卡片（E2 起长按不再自动弹卡）。
 *
 * `wordRect` 由工具条按钮传入（弹工具条时算好的选区矩形）——
 * 点按钮那一刻选区已被收起，事后再从 selection 取是取不到的。
 */
export function lookupWord(
  article: HTMLElement,
  word: string,
  wordRect: DOMRect | null = null,
  nextHooks: LookupHooks | null = null,
): void {
  const cleaned = word.trim().replace(/\s+/g, ' ');
  if (cleaned.length === 0 || cleaned.length > 40) return;
  hooks = nextHooks;
  void performLookup(article, cleaned, wordRect);
}

/** 查词并渲染。查词失败/查不到都不抛错，绝不让长按把阅读页搞崩。 */
async function performLookup(
  article: HTMLElement,
  word: string,
  wordRect: DOMRect | null = null,
): Promise<void> {
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
    mount(article, renderCard(result, word, article, hooks), wordRect);
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
