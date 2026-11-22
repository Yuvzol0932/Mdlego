/**
 * 阅读页（阶段 C3 / C4）—— 对照参考图右机：
 *   顶栏（返回 / 标题 / 搜索 / 书签 / 更多，随滚动方向收放）
 *   正文（正文节点只在「渲染结果变了」或「长按查词开关变了」时重建）
 *   阅读底栏（已读 % + 进度条 + Aa + 明暗 + 下一章）
 *
 * 铁律（阶段 A 验收，host.test.ts 守着）：滚动、勾选、保存进度、开关浮层、
 * 改排版、换主题都**不得**重建 <article>。这里所有交互都只改属性/class。
 *
 * 沉浸模式：点正文空白处同时收起顶栏与底栏；再点一次恢复。
 */

import type { RenderResult, State, TaskState } from '../core/types';
import { el, icon, type PageView, type ViewDeps } from './app';
import { applyMarkHighlights, clearMarkHighlights } from './marks-render';
import {
  bindTextSelection,
  consumeToolbarOnPointerDown,
  hideSelectionToolbar,
  showMarkActions,
  type SelectionBinding,
} from './selection';
import { buildTtsChunks } from '../core/tts';
import {
  HEAD_IDLE_PX,
  HEAD_URGENT_PX,
  FIRST_WINDOW_BLOCKS,
  WINDOW_SIZE,
  chunksForBlockWindow,
  computeBlockWindow,
  type AnchorPoint,
} from '../core/window';
import { createTtsPlayer, speechSupported, type TtsPlayer } from './tts';
import type { MenuSpec } from './menu';

/** 空闲补挂时每批的分片数（分片本身约 64 块，一批 ≈ 128 块）。 */
const CHUNK_BATCH = 2;

/** 取出当前文档的任务状态。 */
function tasksFor(state: State): readonly TaskState[] {
  if (state.currentDocId === null) return [];
  return state.tasks.filter((t) => t.docId === state.currentDocId);
}

/** 把已保存的勾选状态套用到 DOM 上（原地改属性，不动节点结构）。 */
function applyTaskStates(article: HTMLElement, tasks: readonly TaskState[]): void {
  const boxes = article.querySelectorAll<HTMLInputElement>('.task-box');
  for (const box of boxes) {
    const bid = box.getAttribute('data-task-bid');
    if (bid === null) continue;
    const saved = tasks.find((t) => t.bid === bid);
    const checked = saved?.checked ?? box.hasAttribute('checked');
    box.checked = checked;
    box.setAttribute('data-task-checked', checked ? '1' : '0');
    const li = box.closest('li');
    if (li !== null) li.setAttribute('data-task-checked', checked ? '1' : '0');
  }
}

/** 绑定复选框点击。docId 取自最新状态，不捕获过期闭包。 */
function bindTaskToggles(article: HTMLElement, deps: ViewDeps): void {
  article.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.classList.contains('task-box')) return;

    const bid = target.getAttribute('data-task-bid');
    const docId = deps.getState().currentDocId;
    if (bid === null || docId === null) return;

    deps.dispatch({
      type: 'task/toggled',
      task: { docId, bid, index: 0, checked: target.checked },
    });
  });
}

/** 复制文本：优先 Clipboard API，失败回落到隐藏 textarea + execCommand。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 降级 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 两组任务状态是否逐项相同（引用相同的条目视为相同）。 */
function sameTasks(a: readonly TaskState[], b: readonly TaskState[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function createReaderPage(initial: State, deps: ViewDeps): PageView {
  // ── 顶栏 ──
  const title = el('h1', { class: 'appbar__title reader-title', 'data-testid': 'app-title', text: '墨读' });

  const backBtn = el('button', {
    class: 'icon-btn',
    type: 'button',
    'data-testid': 'back-to-shelf',
    'aria-label': '返回书架',
    title: '返回书架',
  }, icon('back'));
  backBtn.addEventListener('click', () => deps.dispatch({ type: 'doc/closed' }));

  const searchBtn = el('button', {
    class: 'icon-btn',
    type: 'button',
    'data-testid': 'open-search',
    'aria-label': '搜索本文',
    title: '搜索',
  }, icon('search'));
  searchBtn.addEventListener('click', () => deps.openSearch());

  const bookmarkBtn = el('button', {
    class: 'icon-btn reader-bookmark',
    type: 'button',
    'data-testid': 'bookmark-toggle',
    'aria-label': '收藏这篇文档',
    title: '收藏',
    'aria-pressed': 'false',
  }, icon('bookmark'));
  bookmarkBtn.addEventListener('click', () => {
    const docId = deps.getState().currentDocId;
    if (docId === null) return;
    deps.toggleBookmark(docId);
  });

  const moreBtn = el('button', {
    class: 'icon-btn',
    type: 'button',
    'data-testid': 'reader-more',
    'aria-label': '更多',
    title: '更多',
  }, icon('more'));
  moreBtn.addEventListener('click', () => openMoreMenu());

  const header = el(
    'header',
    { class: 'appbar appbar--reader', 'data-scrolled': '0' },
    backBtn,
    title,
    el('div', { class: 'appbar__actions' }, searchBtn, bookmarkBtn, moreBtn),
  );

  // ── 阅读底栏 ──
  const percentText = el('span', { class: 'reader-dock__percent', 'data-testid': 'reader-progress-text', text: '已读 0%' });
  const percentFill = el('i');
  const percentBar = el('span', { class: 'progress reader-dock__progress', 'data-testid': 'reader-progress' }, percentFill);

  const typesetBtn = el('button', {
    class: 'reader-dock__btn reader-dock__aa',
    type: 'button',
    'data-testid': 'open-typeset',
    'aria-label': '排版',
    title: '排版',
    text: 'Aa',
  });
  typesetBtn.addEventListener('click', () => deps.openTypeset());

  const themeBtn = el('button', {
    class: 'reader-dock__btn',
    type: 'button',
    'data-testid': 'reader-theme-toggle',
    'aria-label': '切换明暗',
    title: '切换明暗',
  }, icon('sun'));
  themeBtn.addEventListener('click', () => toggleTheme());

  const nextBtn = el('button', {
    class: 'reader-dock__btn',
    type: 'button',
    'data-testid': 'reader-next',
    'aria-label': '下一章',
    title: '下一章',
  }, icon('chevron'));
  nextBtn.addEventListener('click', () => goNextChapter());

  const dock = el(
    'nav',
    { class: 'reader-dock glass', 'data-testid': 'reader-bar', 'aria-label': '阅读工具' },
    el('div', { class: 'reader-dock__meta' }, percentText, percentBar),
    el('div', { class: 'reader-dock__actions' }, typesetBtn, themeBtn, nextBtn),
  );

  const main = el('main', { class: 'main main--reader' });
  const page = el(
    'div',
    { class: 'shell reader-page', 'data-testid': 'shell', 'data-bars': 'shown', 'data-immersive': '0' },
    header,
    main,
    dock,
  );

  // ── 正文（创建规则见文件头） ──
  let generation = 0;
  let builtRender: RenderResult | null = null;
  let builtLookup: boolean | null = null;
  let article: HTMLElement | null = null;
  let errorShown: string | null = null;
  let lastTasks: readonly TaskState[] | null = null;
  let lastBookmarked: boolean | null = null;
  let lastDocId: string | null = null;
  /** 标注渲染签名：标注/渲染变了才重画高亮（避免每次滚动都重建 Highlight）。 */
  let lastMarksKey: string | null = null;
  /** 选区手势绑定（正文重建时必须先解绑）。 */
  let selectionBinding: SelectionBinding | null = null;
  /** 朗读播放条（阶段 E6）。 */
  let ttsPlayer: TtsPlayer | null = null;

  /**
   * 正文分片游标（转场改造 Step 1）。
   *
   * 首屏不再固定挂「文档开头第一片」，而是以阅读进度锚点 `bid` 为中心取一个窗口。
   * 已挂载的分片区间恒为连续区间 `[headChunk, tailChunk)`：
   *   - 向下补齐：`appendTailBatch` 只会把 tailChunk 往后推；
   *   - 向上补齐：`prependHeadBatch` 只会把 headChunk 往前推（带滚动补偿）。
   */
  let headChunk = 0;
  let tailChunk = 0;
  let chunkTotal = 0;
  let idleHandle: number | null = null;

  const cancelRemainder = (): void => {
    remainderArmed = false;
    if (remainderTimer !== null) {
      window.clearTimeout(remainderTimer);
      remainderTimer = null;
    }
    if (idleHandle !== null) {
      const w = window as Window & { cancelIdleCallback?: (handle: number) => void };
      if (typeof w.cancelIdleCallback === 'function') w.cancelIdleCallback(idleHandle);
      else window.clearTimeout(idleHandle);
      idleHandle = null;
    }
  };

  /** 重新套一遍勾选状态与标注高亮（分片补齐后调用）。 */
  function invalidateDocHeight(): void {
    cachedDocHeight = 0;
    cachedDocHeightAt = 0;
  }

  function repaintArticleState(): void {
    if (article === null) return;
    invalidateDocHeight();
    const state = deps.getState();
    applyTaskStates(article, tasksFor(state));
    if (state.render !== null) applyMarkHighlights(article, state.render.blockTexts, state.marks);
    paintProgress();
  }

  /** 某分片的 HTML（懒渲染时按需渲染）；越界返回 null。 */
  function chunkHtml(index: number): string | null {
    if (builtRender === null) return null;
    if (index < 0 || index >= chunkTotal) return null;
    return builtRender.htmlChunkAt(index);
  }

  /**
   * 当前的滚动容器。
   *
   * 平时是文档根节点（整页滚动）；遮罩转场期间阅读页被塞进
   * `.page-mask`（`position: fixed; overflow: hidden`），滚动就发生在那层上。
   * 向上前插的高度补偿必须作用在**真正的滚动容器**上，否则补了等于没补。
   */
  function scrollContainer(): HTMLElement {
    // Step 3 把遮罩层拆成「形变壳 .page-mask + 内部阅读视口层 .page-mask__reader」：
    // 滚动发生在**内层** reader 上（形变壳 overflow 隐藏，只做 transform）。
    // 这里必须取内层，否则 scrollTop 写不进去，锚点定位全部失效。
    const reader = page.closest<HTMLElement>('[data-testid="page-mask-reader"]');
    if (reader !== null) return reader;
    const mask = page.closest<HTMLElement>('[data-testid="page-mask"]');
    return mask ?? document.documentElement;
  }

  /** 当前滚动位置（与 scrollContainer 对应）。 */
  function scrollTopNow(): number {
    const scroller = scrollContainer();
    return scroller === document.documentElement ? window.scrollY : scroller.scrollTop;
  }

  /** 正文是否已全部挂载。 */
  function isArticleComplete(): boolean {
    return chunkTotal > 0 && headChunk === 0 && tailChunk >= chunkTotal;
  }

  /**
   * 当前打开文档的阅读进度锚点（null = 从头读）。
   *
   * 只读 store，不碰 DOM：首屏挂载发生在转场第 1 帧，任何测量都会拖慢首帧。
   */
  function readAnchor(): AnchorPoint | null {
    const doc = deps.getState().docs.find((d) => d.id === deps.getState().currentDocId);
    const progress = doc?.progress;
    if (progress === null || progress === undefined) return null;
    if (typeof progress.bid !== 'string' || progress.bid.length === 0) return null;
    return { bid: progress.bid, ratio: progress.ratio };
  }

  /**
   * 按锚点窗口挂载首屏正文（转场改造 Step 1 的核心）。
   *
   * 步骤：
   *   1. core/window.ts 算出以目标块为中心的块窗口；
   *   2. 映射成需要挂载的分片区间；
   *   3. 只同步挂这几片 —— 首屏块数与原来「一片约 24 块」同量级，
   *      但呈现的是用户上次读到的位置。
   * 底部进度栏与滚动定位都由调用方（main.ts）在同一同步栈内完成。
   */
  function mountInitialWindow(render: RenderResult, anchor: AnchorPoint | null): void {
    if (article === null) return;
    // ── 清掉上一次挂载留下的「已锚定」标记（1.2.2 进度记忆回归的根因）──
    //
    // 这个标记是给 main.ts 的 anchorFirstFrame() 看的：它表示「本次首屏挂载
    // 已经在同一同步栈内定位过了，别再写一次 scrollTop」。
    //
    // 但阅读页根节点由宿主按页面 key 缓存并**反复复用** —— 同一个 DOM 节点
    // 会在多次「进入 → 退出 → 再进入」之间活着。标记从不清除，于是第二次
    // 进入时 main 看到上次留下的 '1'，直接走提前返回分支：**一步定位都没做，
    // 却返回「已恢复」**，用户停在文档开头（表现为「进度记忆失效」）。
    //
    // 为什么看起来是「间歇」的：节点被重建（换文档 / 渲染结果变化）就正常，
    // 被复用就失效。
    //
    // 修复：标记的生命周期必须与**一次挂载**绑定 —— 挂载开始就清，
    // 锚定成功后由 anchorToBlock() 重新设上。
    delete page.dataset['anchored'];
    // 首帧进度占位：有历史百分比就直接显示，绝不先渲染「已读 0%」再跳变
    const doc = deps.getState().docs.find((d) => d.id === deps.getState().currentDocId);
    const savedPercent = doc?.progress?.percent;
    percentSeed = typeof savedPercent === 'number' ? Math.max(0, Math.min(100, savedPercent)) : null;
    lastPaintedPercent = -1;
    paintProgress();

    const ranges = render.chunkBlockRanges;
    chunkTotal = ranges.length;

    // 没有阅读进度（第一次打开这本书 / 从头读）：保持原地一步到位的老行为 ——
    // 只挂首片（约 FIRST_SCREEN_BLOCKS 块）。这里绝不能因为「窗口 = 64 块」
    // 就多挂两三片：首次打开的首帧块数直接决定转场帧率。
    if (anchor === null) {
      headChunk = 0;
      tailChunk = 0;
      article.innerHTML = render.firstHtmlChunk;
      if (chunkTotal > 0) tailChunk = 1;
      return;
    }

    // #C：首屏用小窗口（够一屏 + 缓冲），不要用转场后的补齐粒度。
    // 实测窗口 64 块会跨到 2–3 个分片 → 实际挂载 481 块、首帧 40.8ms。
    const window = computeBlockWindow(render.blockCount, anchor, render.blockIds, FIRST_WINDOW_BLOCKS);
    const span = chunksForBlockWindow(ranges, window);

    if (span.firstChunk < 0) {
      // 没有块（空文档）或区间异常：退回「首片」语义，保证至少有内容
      headChunk = 0;
      tailChunk = 0;
      article.innerHTML = render.firstHtmlChunk;
      if (chunkTotal > 0) tailChunk = 1;
      return;
    }

    headChunk = span.firstChunk;
    tailChunk = span.firstChunk;
    article.replaceChildren();
    // 直接一次性拼出一个 HTML 字符串再赋值：比逐片 insertAdjacentHTML 少若干次布局失效
    const parts: string[] = [];
    for (let i = span.firstChunk; i <= span.lastChunk; i++) {
      const html = render.htmlChunkAt(i);
      if (html === null) continue;
      parts.push(html);
      tailChunk = i + 1;
    }
    if (parts.length === 0) {
      // 兜底：分片区间取不到内容时退回首片
      const first = render.htmlChunkAt(0);
      article.innerHTML = first ?? render.firstHtmlChunk;
      headChunk = 0;
      tailChunk = chunkTotal > 0 ? 1 : 0;
      return;
    }
    article.innerHTML = parts.join('');

    // 首帧同步定位（转场改造 Step 1 的收尾动作）：
    // 窗口已经以目标块为中心挂好，这里**在同一同步栈内**把滚动写到位。
    // 不能等 main 的异步回调 —— 那会先用「窗口顶部」画一帧再瞬移。
    // 同时关掉浏览器原生滚动锚定，避免它在我们算好的位置上再调一次（双重叠加会漂移）。
    disableNativeScrollAnchor();
    anchorToBlock(anchor.bid, anchor.ratio);
  }

  /**
   * 把滚动定位到指定块（在转场期间写遮罩层的 scrollTop，否则写 window）。
   *
   * 必须在正文已挂载的同一个同步栈内调用，否则会先露出窗口顶部再跳。
   *
   * 关键：这是「把目标块顶端对齐到顶栏下沿」，不是「滚到文档的第 N 像素」。
   * 窗口内锚点块可能位于几千像素处（首屏挂 64 块 ≈ 13000px 高），
   * 所以必须用 `rect.top + 当前滚动量` 求出它在内容坐标系里的真实位置，
   * 再减去顶栏高度。少减或多减都会让用户落在目标块上方/下方一整屏。
   */
  function anchorToBlock(bid: string, ratio: number): void {
    if (article === null) return;
    const target = article.querySelector<HTMLElement>(`[data-bid="${CSS.escape(bid)}"]`);
    if (target === null) return;
    const offset = appbarHeight();
    const scroller = scrollContainer();
    const isRoot = scroller === document.documentElement;

    // ── 坐标系换算（Step 3 之后必须做）─────────────────────────
    //
    // 打开转场期间 `.page-mask` 带着 `transform: translate(...) scale(...)`
    // 从被点封面矩形起飞。`getBoundingClientRect()` 返回的是**变换后**的视觉
    // 坐标，而 `scrollTop` 是**布局**坐标 —— 两者混用会差 1/scale 倍，
    // 而且还带着形变壳的 translate 偏移（无法从 reader 内部直接读到）。
    //
    // 解法：全程改用「相对滚动容器顶边」的差值，translate 在同一个变换空间
    // 里两边都有，做差就抵消了：
    //   blockContentTop = 当前滚动量 + (块视觉 top − 容器视觉 top) / scale
    //   targetScrollTop = blockContentTop − 顶栏高 + ratio × 块布局高
    // offsetHeight 不受 transform 影响，scale 由「视觉高 / 布局高」现算，
    // 不需要知道动画进度。
    const layoutH = article.offsetHeight;
    const visualH = article.getBoundingClientRect().height;
    const scale = layoutH > 0 && visualH > 0 ? visualH / layoutH : 1;
    const inv = scale > 0.01 ? 1 / scale : 1;
    const containerTop = isRoot ? 0 : scroller.getBoundingClientRect().top;

    // 多趟收敛，每趟都用**绝对**位置重算，绝不累加增量。
    //
    // 首屏是刚 innerHTML 进来的，第一次写 scrollTop 会强制完整布局，
    // 上方内容高度在那一刻才定稿，目标块的真实位置要重新量，所以要迭代。
    // 绝不能写 `scrollTop += 残差`：一旦某趟被夹到 0 或最大值，
    // 增量就会在错误的基础上继续叠加，越修越偏（实测 −26px 被放大到 −543px）。
    let lastResidual = Number.POSITIVE_INFINITY;
    for (let pass = 0; pass < 6; pass++) {
      const rect = target.getBoundingClientRect();
      const rectH = rect.height * inv;
      const baseTop = isRoot ? window.scrollY : scroller.scrollTop;
      const top = Math.max(0, baseTop + (rect.top - containerTop) * inv - offset + ratio * rectH);
      if (isRoot) window.scrollTo(0, top);
      else scroller.scrollTop = top;
      // 同一同步帧内复查（同样换算回布局坐标）
      const after = target.getBoundingClientRect();
      const given = isRoot ? window.scrollY : scroller.scrollTop;
      const residual = after.top * inv - (isRoot ? 0 : containerTop * inv) - offset + ratio * after.height * inv;
      if (Math.abs(residual) <= 1) break;
      if (Math.abs(residual) >= Math.abs(lastResidual)) break;
      lastResidual = residual;
    }
    // 标记「**本次挂载**的首屏已完成锚定」：main 的 anchorFirstFrame 看到它就不
    // 再重复定位，否则两处各写一次 scrollTop，第二次会在已滚动的基座上再算一遍
    // 高度，产生固定偏差（实测 300px 量级）。
    //
    // 注意生命周期：这个标记由 mountInitialWindow() 在每次挂载开始时清除，
    // 只对「本次挂载」有效。绝不能在页面节点上长期留存 —— 节点是被复用的，
    // 留着就会让下一次进入误以为已经定位过（1.2.2 的进度记忆失效）。
    page.dataset['anchored'] = '1';
    // 交出进度条控制权：此后按真实滚动位置画百分比
    page.dispatchEvent(new CustomEvent('mdlego:anchor-settled'));
  }

  /**
   * sticky 顶栏的布局高度（不含 transform：顶栏收起时 rect 会变负）。
   *
   * 阅读进度的「基准线」是**几何常量**，不随顶栏收放变化 —— 否则
   * 保存时顶栏收起、恢复时顶栏显示，同一个 bid 会差一整条顶栏高度。
   */
  function appbarHeight(): number {
    return header.offsetHeight;
  }

  /**
   * 转场期间关掉浏览器原生滚动锚定。
   *
   * 锚点定位是「我们手动算好再写 scrollTop」的，原生锚定会在这个基础上
   * 再按自己的启发式调一次，两次叠加就出现「重开偏出两屏」的漂移。
   * 转场收尾（mdlego:transition-end）后恢复，正文自身的追加/前插
   * 仍由 prependHeadBatch 的参考元素补偿负责。
   */
  function disableNativeScrollAnchor(): void {
    const scroller = scrollContainer();
    if (scroller instanceof HTMLElement) scroller.style.setProperty('overflow-anchor', 'none');
    document.documentElement.style.setProperty('overflow-anchor', 'none');
  }

  function enableNativeScrollAnchor(): void {
    const scroller = scrollContainer();
    if (scroller instanceof HTMLElement && scroller !== document.documentElement) {
      scroller.style.removeProperty('overflow-anchor');
    }
    document.documentElement.style.removeProperty('overflow-anchor');
  }

  /** 挂完检查：全挂上了就派发 article-complete（每代正文只派发一次）。 */
  function settleIfComplete(): void {
    if (!isArticleComplete()) return;
    if (page.getAttribute('data-article') === 'complete') return;
    repaintArticleState();
    notifyArticleComplete();
  }

  /** 正文分片全部挂完（批注/标注在这之后才需要块文本索引）。 */
  function notifyArticleComplete(): void {
    page.setAttribute('data-article', 'complete');
    page.dispatchEvent(new CustomEvent('mdlego:article-complete'));
  }

  /**
   * 向下（文档后段）追加一批分片。
   * @returns 是否真的有新分片被挂上
   */
  function appendTailBatch(maxChunks: number): boolean {
    if (article === null || builtRender === null) return false;
    let mounted = 0;
    while (tailChunk < chunkTotal && mounted < maxChunks) {
      const html = chunkHtml(tailChunk);
      if (html === null) break;
      article.insertAdjacentHTML('beforeend', html);
      tailChunk += 1;
      mounted += 1;
    }
    if (mounted === 0) return false;
    invalidateDocHeight();
    return true;
  }

  /**
   * 向上（文档前段）逆序前插一批分片，并做零跳动滚动补偿。
   *
   * 补偿用**参考元素视口偏移法**，而不是 scrollHeight 差值：
   *   scrollTop += (参考元素插入后 rect.top − 插入前 rect.top)
   * 这个公式与滚动容器无关（window 或 fixed 遮罩层都成立），
   * 而 scrollHeight 差值法在 fixed 容器里会读到不含内容的布局高度，
   * 累积起来就是「重开时正文越滑越偏」（实测偏出 4700px）。
   *
   * 另外仍要关掉浏览器原生滚动锚定（`overflow-anchor: none`），
   * 否则原生锚定会与手动补偿双重叠加。
   *
   * @returns 是否真的有新分片被挂上
   */
  function prependHeadBatch(maxChunks: number): boolean {
    if (article === null || builtRender === null) return false;
    const scroller = scrollContainer();
    const isRoot = scroller === document.documentElement;
    let mounted = 0;
    // 先把这一批的 HTML 取齐（懒渲染的分片在这里才真正生成），
    // 保证「取 HTML」与「测量/插入/补偿」不在同一段里互相打断。
    const batch: string[] = [];
    while (headChunk > 0 && batch.length < maxChunks) {
      headChunk -= 1;
      const html = chunkHtml(headChunk);
      if (html === null) {
        headChunk += 1;
        break;
      }
      batch.push(html);
    }
    if (batch.length === 0) return false;

    const prevAnchor = article.style.getPropertyValue('overflow-anchor');
    article.style.setProperty('overflow-anchor', 'none');

    // 选一个「插入前后都存在的」参考块：当前第一个块（抬头会插在它前面）
    const reference = article.firstElementChild;
    const beforeTop = reference === null ? null : reference.getBoundingClientRect().top;
    const prevScrollTop = isRoot ? window.scrollY : scroller.scrollTop;

    const fragment = document.createDocumentFragment();
    for (const html of batch) {
      const holder = document.createElement('div');
      holder.innerHTML = html;
      while (holder.firstChild !== null) fragment.append(holder.firstChild);
    }
    article.insertBefore(fragment, article.firstChild);

    // 同一同步帧内测参考块的新位置，把差值补回 scrollTop —— 视觉位置不动
    if (reference !== null && beforeTop !== null) {
      const afterTop = reference.getBoundingClientRect().top;
      const delta = afterTop - beforeTop;
      if (delta !== 0) {
        const nextTop = Math.max(0, prevScrollTop + delta);
        if (isRoot) window.scrollTo(0, nextTop);
        else scroller.scrollTop = nextTop;
      }
    }
    if (prevAnchor.length > 0) article.style.setProperty('overflow-anchor', prevAnchor);
    else article.style.removeProperty('overflow-anchor');

    mounted = batch.length;
    invalidateDocHeight();
    return mounted > 0;
  }

  /** 一次性同步补齐全部剩余分片：目录跳转/搜索定位/导出/全量批注扫描。 */
  function flushRemainder(): void {
    if (article === null || builtRender === null) return;
    if (isArticleComplete()) return;
    cancelRemainder();
    prependHeadBatch(chunkTotal);
    appendTailBatch(chunkTotal);
    settleIfComplete();
  }

  /**
   * 空出一个分片（兼容旧 `mdlego:mount-next` 契约）：按「先尾后头」补一片。
   * @returns 是否还有剩余分片
   */
  function mountOneChunk(): boolean {
    if (article === null || builtRender === null) return false;
    if (tailChunk < chunkTotal) appendTailBatch(1);
    else if (headChunk > 0) prependHeadBatch(1);
    settleIfComplete();
    return !isArticleComplete();
  }

  /** 空闲补齐的启动闸：转场结束（mdlego:transition-end）后才开始。 */
  let remainderArmed = false;
  let remainderTimer: number | null = null;

  function armRemainder(): void {
    if (isArticleComplete()) return;
    remainderArmed = true;
    if (remainderTimer !== null) window.clearTimeout(remainderTimer);
    // 兜底：不是从书架遮罩转场进来的（例如编辑保存后重建）没有 transition-end 事件
    remainderTimer = window.setTimeout(() => {
      remainderTimer = null;
      scheduleRemainder();
    }, 700);
  }

  function releaseRemainder(): void {
    if (!remainderArmed) return;
    remainderArmed = false;
    if (remainderTimer !== null) {
      window.clearTimeout(remainderTimer);
      remainderTimer = null;
    }
    scheduleRemainder();
  }

  /** 空闲分批：每批若干片，不阻塞转场与滚动。 */
  function scheduleRemainder(): void {
    if (article === null || isArticleComplete() || idleHandle !== null) return;
    const pump = (): void => {
      idleHandle = null;
      if (article === null || isArticleComplete()) return;
      // 正在滚动（data-scrolling=1）时先不补：成批插入会在真机上占 30-70ms，
      // 和滚动抢主线程。停手 150ms 后 data-scrolling 移除，下一轮 idle 再继续。
      if (page.getAttribute('data-scrolling') === '1') {
        idleHandle = window.setTimeout(pump, 200);
        return;
      }
      // 优先向后补齐（用户最可能继续往下读）；尾部补完再向前补，
      // 且向上前插要等滚离顶部足够远，避免插入时把用户顶到窗口上缘。
      if (tailChunk < chunkTotal) {
        appendTailBatch(CHUNK_BATCH);
      } else if (headChunk > 0) {
        if (scrollTopNow() < HEAD_IDLE_PX) {
          idleHandle = window.setTimeout(pump, 200);
          return;
        }
        prependHeadBatch(CHUNK_BATCH);
      }
      settleIfComplete();
      scheduleRemainder();
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
    if (typeof w.requestIdleCallback === 'function') idleHandle = w.requestIdleCallback(pump, { timeout: 120 });
    else idleHandle = window.setTimeout(pump, 16);
  }

  // 进度恢复/TOC 跳转发现目标块还没挂载时，main 会发这个事件让正文同步补齐。
  page.addEventListener('mdlego:flush-article', () => {
    remainderArmed = false;
    flushRemainder();
  });
  // 转场结束才开始空闲补齐：动画期间不能偷挂正文（否则首屏块数/帧率都不达标）。
  page.addEventListener('mdlego:transition-end', () => {
    // 转场收尾：交还原生滚动锚定（此后正文追加由参考元素补偿自己负责）
    enableNativeScrollAnchor();
    releaseRemainder();
  });
  // 首帧同步定位完成（main 已在同一同步栈内滚到锚点）→ 交出进度条控制权。
  page.addEventListener('mdlego:anchor-settled', () => releasePercentSeed());
  // 进度恢复兜底：main 每帧要一片，目标块出现就停；cancelable=false 表示「没有更多分片了」。
  page.addEventListener('mdlego:mount-next', (event) => {
    const more = mountOneChunk();
    if (more) event.preventDefault();
  });

  /** 开始/停止朗读（工具菜单里切换）。 */
  function toggleTts(): void {
    if (ttsPlayer !== null) {
      ttsPlayer.destroy();
      ttsPlayer = null;
      return;
    }
    const state = deps.getState();
    if (article === null || state.render === null) {
      deps.toast('请先打开一篇文档');
      return;
    }
    if (!speechSupported()) {
      deps.toast('当前系统不支持朗读');
      return;
    }
    const chunks = buildTtsChunks(state.render.blockTexts);
    if (chunks.length === 0) {
      deps.toast('这篇文档没有可朗读的文字');
      return;
    }
    ttsPlayer = createTtsPlayer({
      article,
      chunks,
      onToast: (message) => deps.toast(message),
      onFinished: () => {
        ttsPlayer?.destroy();
        ttsPlayer = null;
      },
    });
    page.append(ttsPlayer.el);
    ttsPlayer.start();
  }

  function freshArticle(lookup: boolean): HTMLElement {
    selectionBinding?.destroy();
    selectionBinding = null;
    const node = el('article', { class: 'article', 'data-testid': 'article' });
    generation += 1;
    node.setAttribute('data-gen', String(generation));
    bindTaskToggles(node, deps);
    // 选区/标注手势与查词开关无关：查词只是工具条上的一个按钮
    selectionBinding = bindTextSelection(node, {
      blockTexts: () => deps.getState().render?.blockTexts ?? null,
      onMark: (parts, type, color) => deps.addSelectionMark(parts, type, color),
      onNote: (parts) => deps.openNoteForSelection(parts),
      onLookup: (word, rect) => deps.lookupWord(word, rect),
      onCopy: (text) => deps.copyText(text),
      onMarkTap: (markId, rect) => {
        const mark = deps.getState().marks.find((m) => m.id === markId);
        if (mark === undefined) return;
        showMarkActions(rect, {
          quote: mark.anchor.quote,
          onDelete: () => deps.removeMark(markId),
          onEditNote: () => deps.openNoteForMark(markId),
          onCopy: (text) => deps.copyText(text),
        });
      },
      isReanchorPending: () => deps.isReanchorPending(),
      onReanchor: (parts) => deps.reanchorSelection(parts),
      lookupEnabled: () => deps.getState().settings.lookupEnabled,
    });
    article = node;
    builtLookup = lookup;
    lastMarksKey = null;
    main.replaceChildren(node);
    return node;
  }

  // ── 正文交互：代码复制 / 图片放大 / 空白处切沉浸 ──
  main.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const copyBtn = target.closest('.code-copy');
    if (copyBtn instanceof HTMLElement) {
      const wrap = copyBtn.closest('.code-wrap');
      const text = wrap?.querySelector('pre code')?.textContent ?? '';
      void copyText(text).then((ok) => {
        deps.toast(ok ? '已复制代码' : '复制失败');
        if (ok) {
          copyBtn.textContent = '已复制';
          window.setTimeout(() => { copyBtn.textContent = '复制'; }, 1400);
        }
      });
      return;
    }

    const tableBtn = target.closest('.table-expand');
    if (tableBtn instanceof HTMLElement) {
      hideSelectionToolbar();
      const table = tableBtn.closest('.table-box')?.querySelector('table');
      if (table instanceof HTMLTableElement) deps.openTable(table);
      return;
    }

    const img = target.closest('img');
    if (img instanceof HTMLImageElement) {
      deps.openImage(img.currentSrc || img.src);
      return;
    }

    // 空白处：链接、按钮、输入控件都不算空白
    if (target.closest('a, button, input, label')) return;

    // 这一下按在工具条外、且按下时工具条还开着 → 只负责关工具条，不切沉浸
    // （pointerdown 已经把它收掉了，这里只是不再叠加一次切换）
    if (consumeToolbarOnPointerDown()) return;

    // 残留选区（长按/取消工具条后 WebView 常留一个 Range）不能吞掉点击：
    // 先清掉选区，再继续切换沉浸。
    const selection = window.getSelection();
    if (selection !== null && selection.toString().length > 0) {
      selection.removeAllRanges();
    }
    toggleImmersive();
  });

  // ── 进度与顶栏收放 ──
  let progressQueued = false;
  let barsQueued = false;
  let lastBarY = window.scrollY;

  function scheduleProgress(): void {
    if (progressQueued) return;
    progressQueued = true;
    requestAnimationFrame(() => {
      progressQueued = false;
      paintProgress();
    });
  }

  let lastPaintedPercent = -1;
  let cachedDocHeight = 0;
  let cachedDocHeightAt = 0;
  /**
   * 首帧进度占位值（转场改造 Step 1）。
   *
   * 打开有阅读进度的书时，转场第 1 帧正文已经呈现上次读到的位置，
   * 但 `window.scrollY` 此刻还没被定位（阅读页还在 fixed 遮罩层里，滚动会被夹零）。
   * 若此时按 scrollY 算，底栏会先闪一下「已读 0%」再跳变 —— 计划书明确禁止。
   * 所以先用已保存的百分比占位，等真实滚动落定后清掉。
   */
  let percentSeed: number | null = null;

  /** 是否还处于「首帧占位」状态（main 完成同步定位后调用 releasePercentSeed）。 */
  function releasePercentSeed(): void {
    percentSeed = null;
    paintProgress();
  }

  function paintProgress(): void {
    if (percentSeed !== null) {
      if (percentSeed !== lastPaintedPercent) {
        lastPaintedPercent = percentSeed;
        percentText.textContent = `已读 ${percentSeed}%`;
        percentFill.style.width = `${percentSeed}%`;
      }
      return;
    }
    // 正文还没有任何内容（渲染未到 / 空文档）：不画百分比。
    // 以前这里会算出 max <= 0 → 显示「已读 100%」，打开瞬间闪一下满进度，
    // 是真机上肉眼可见的错帧。
    if (article === null || article.childElementCount === 0) return;
    const scroller = scrollContainer();
    const isRoot = scroller === document.documentElement;
    const now = performance.now();
    // 滚动时每帧读 scrollHeight 会强制一次 3 万节点的布局；
    // 高度缓存 800ms，分片追加时由 invalidateDocHeight() 立刻失效。
    if (cachedDocHeight === 0 || now - cachedDocHeightAt > 800) {
      cachedDocHeight = isRoot ? document.documentElement.scrollHeight : scroller.scrollHeight;
      cachedDocHeightAt = now;
    }
    const viewport = isRoot ? window.innerHeight : scroller.clientHeight;
    const scrollTop = isRoot ? window.scrollY : scroller.scrollTop;
    const max = cachedDocHeight - viewport;
    const percent = max <= 0 ? 100 : Math.round(Math.min(1, Math.max(0, scrollTop / max)) * 100);
    // 滚动时每帧都写 textContent 会持续触发顶栏重排；只有百分比变了才写
    if (percent === lastPaintedPercent) return;
    lastPaintedPercent = percent;
    percentText.textContent = `已读 ${percent}%`;
    percentFill.style.width = `${percent}%`;
  }

  function setBars(mode: 'shown' | 'hidden'): void {
    if (page.getAttribute('data-bars') === mode) return;
    page.setAttribute('data-bars', mode);
  }

  function scheduleBars(): void {
    if (barsQueued) return;
    barsQueued = true;
    requestAnimationFrame(() => {
      barsQueued = false;
      updateBars();
    });
  }

  function updateBars(): void {
    if (page.getAttribute('data-immersive') === '1') return;
    const y = window.scrollY;
    if (y <= 8) {
      setBars('shown');
      lastBarY = y;
      return;
    }
    // 累积方向：lastBarY 只在越过阈值时更新，微小的滚动不会被吞掉
    if (y > lastBarY + 6) {
      setBars('hidden');
      lastBarY = y;
    } else if (y < lastBarY - 6) {
      setBars('shown');
      lastBarY = y;
    }
  }

  /**
   * 点空白处切换沉浸模式。
   *
   * 必须按「顶栏实际是否可见」来切，不能按 data-immersive 取反：
   * 用户向下滚动后顶栏已被滚动逻辑自动收起（data-bars=hidden，但 immersive 仍是 0），
   * 此时取反会先把 immersive 变成 1 再 setBars('hidden')，屏幕毫无变化，
   * 要点第二下才看得到反应。
   *
   * 两套状态合并为一个语义：
   *   - data-bars       = 顶栏/底栏此刻是否可见（唯一可见性来源）
   *   - data-immersive  = 是否暂停「滚动自动收放」（用户手动切到隐藏时才暂停）
   */
  function toggleImmersive(): void {
    const hidden = page.getAttribute('data-bars') === 'hidden';
    setBars(hidden ? 'shown' : 'hidden');
    page.setAttribute('data-immersive', hidden ? '0' : '1');
    lastBarY = window.scrollY;
  }

  let scrollIdleTimer: number | null = null;

  const onScroll = (): void => {
    scheduleProgress();
    scheduleBars();
    // 滚动期间关掉顶栏/底栏的 backdrop-filter（每帧重算模糊很贵），停手 150ms 再恢复
    if (page.getAttribute('data-scrolling') !== '1') page.setAttribute('data-scrolling', '1');
    if (scrollIdleTimer !== null) window.clearTimeout(scrollIdleTimer);
    scrollIdleTimer = window.setTimeout(() => {
      scrollIdleTimer = null;
      page.removeAttribute('data-scrolling');
    }, 150);
    // 停在页首时顶栏完全透明（品牌色背景上的正文不该被一条色带切断）；
    // 滚动后才让玻璃底浮现。同值不重复写属性，避免每帧 style 失效。
    const scrolled = window.scrollY > 8 ? '1' : '0';
    if (header.getAttribute('data-scrolled') !== scrolled) header.setAttribute('data-scrolled', scrolled);
    // 逼近正文顶部且上方还有没挂的分片：立刻补一批（带高度补偿），
    // 不能让用户滑到半截撞墙后停住。滚动中补一批是可接受的代价。
    if (headChunk > 0 && !isArticleComplete() && scrollTopNow() < HEAD_URGENT_PX) {
      if (prependHeadBatch(CHUNK_BATCH)) settleIfComplete();
    }
  };
  window.addEventListener('scroll', onScroll, { passive: true });

  // ── 主题切换 / 下一章 ──
  function toggleTheme(): void {
    const scheme = document.documentElement.getAttribute('data-scheme');
    deps.dispatch({ type: 'settings/changed', patch: { theme: scheme === 'dark' ? 'warm-paper' : 'warm-night' } });
  }

  function goNextChapter(): void {
    // 下一章要扫全量块：先把空闲分片补齐（用户主动动作，可接受一次同步补齐）
    flushRemainder();
    const render = deps.getState().render;
    if (render === null) return;
    const chapters = render.toc.filter((entry) => entry.level <= 2);
    if (chapters.length === 0) {
      deps.toast('这篇文档没有章节');
      return;
    }
    const offset = header.offsetHeight;
    let current = -1;
    chapters.forEach((entry, index) => {
      const node = page.querySelector<HTMLElement>(`[data-bid="${CSS.escape(entry.bid)}"]`);
      if (node === null) return;
      if (node.getBoundingClientRect().top < offset + 1) current = index;
    });
    const target = chapters[current + 1];
    if (target === undefined) {
      deps.toast('已经是最后一章');
      return;
    }
    const node = page.querySelector<HTMLElement>(`[data-bid="${CSS.escape(target.bid)}"]`);
    if (node === null) return;
    const top = node.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    node.classList.add('flash');
    window.setTimeout(() => node.classList.remove('flash'), 1200);
  }

  // ── 更多菜单：目录 / 明暗 / 设置 ──
  function openMoreMenu(): void {
    const rect = moreBtn.getBoundingClientRect();
    const spec: MenuSpec = {
      variant: 'popover',
      anchor: { top: rect.top, bottom: rect.bottom, right: rect.right },
      items: [
        { id: 'open-toc', testId: 'open-toc', label: '目录', icon: 'list', onSelect: () => deps.openToc() },
        { id: 'open-marks', testId: 'open-marks', label: '批注', icon: 'note', onSelect: () => deps.openMarks() },
        {
          id: 'open-editor',
          testId: 'open-editor',
          label: '编辑原文',
          icon: 'edit',
          onSelect: () => {
            const docId = deps.getState().currentDocId;
            if (docId !== null) deps.openEditor(docId);
          },
        },
        {
          id: 'more-edit-cover',
          testId: 'more-edit-cover',
          label: '编辑封面',
          icon: 'palette',
          onSelect: () => {
            const docId = deps.getState().currentDocId;
            if (docId !== null) deps.openCoverEditor(docId);
          },
        },
        { id: 'reader-tts', testId: 'reader-tts', label: '朗读', icon: 'speaker', onSelect: () => toggleTts() },
        { id: 'reader-export-html', testId: 'reader-export-html', label: '导出 HTML', icon: 'share', onSelect: () => deps.exportHtml() },
        { id: 'reader-print', testId: 'reader-print', label: '打印 / 导出 PDF', icon: 'print', onSelect: () => deps.printDocument() },
        { id: 'reader-typeset', label: '排版', icon: 'type', onSelect: () => deps.openTypeset() },
        { id: 'reader-theme', label: '切换明暗', icon: 'moon', onSelect: () => toggleTheme() },
        {
          id: 'reader-settings',
          label: '设置',
          icon: 'settings',
          onSelect: () => deps.dispatch({ type: 'nav/push', page: { kind: 'tab', tab: 'settings' } }),
        },
      ],
    };
    deps.openMenu(spec);
  }

  // ── 状态 → DOM ──
  function update(state: State): void {
    const docId = state.currentDocId;
    if (docId !== lastDocId) {
      lastDocId = docId;
      // 换文档时滚动位置由 main.ts 负责恢复，这里只需要把百分比重置
      lastPaintedPercent = -1;
      invalidateDocHeight();
      percentText.textContent = '已读 0%';
      percentFill.style.width = '0%';
    }

    const doc = state.docs.find((d) => d.id === docId) ?? null;
    const nextTitle = doc?.title ?? '墨读';
    if (title.textContent !== nextTitle) title.textContent = nextTitle;

    const bookmarked = docId !== null && state.bookmarks.includes(docId);
    if (bookmarked !== lastBookmarked) {
      lastBookmarked = bookmarked;
      bookmarkBtn.setAttribute('aria-pressed', bookmarked ? 'true' : 'false');
      bookmarkBtn.setAttribute('aria-label', bookmarked ? '取消收藏' : '收藏这篇文档');
    }

    // 明暗快捷按钮的图标跟随当前生效的明暗
    const scheme = document.documentElement.getAttribute('data-scheme');
    const wantedThemeIcon = scheme === 'dark' ? 'sun' : 'moon';
    const use = themeBtn.querySelector('use');
    if (use !== null && use.getAttribute('href') !== `#i-${wantedThemeIcon}`) {
      themeBtn.replaceChildren(icon(wantedThemeIcon));
    }

    if (state.readerStatus === 'error') {
      const message = `无法显示这篇文档：${state.readerError ?? '未知原因'}`;
      if (errorShown !== message) {
        errorShown = message;
        article = null;
        builtRender = null;
        main.replaceChildren(el('div', { class: 'shelf-empty', 'data-testid': 'render-error', text: message }));
      }
      return;
    }
    errorShown = null;

    const lookup = state.settings.lookupEnabled;
    const needNode = article === null || builtLookup !== lookup || builtRender !== state.render;
    if (needNode) {
      cancelRemainder();
      const node = freshArticle(lookup);
      if (state.render !== null) {
        // 首屏按「阅读进度锚点」取窗口，而不是永远从文档开头挂第一片：
        // 打开一本读到 30%–80% 的书时，第 1 帧就要呈现上次读到的位置。
        const anchor = readAnchor();
        mountInitialWindow(state.render, anchor);
      }
      builtRender = state.render === null ? null : state.render;
      page.removeAttribute('data-article');
      lastTasks = null; // 新节点必须套一遍勾选状态
      paintProgress();
      armRemainder();
    }

    // 标注高亮：渲染结果或标注变化时重画（CSS Highlight API，不改正文 DOM）
    if (article !== null && state.render !== null) {
      const marksKey = `${generation}|${state.marks
        .map((m) => `${m.id}:${m.anchor.bid}:${m.anchor.start}:${m.anchor.end}:${m.note ?? ''}`)
        .join('|')}`;
      if (marksKey !== lastMarksKey) {
        lastMarksKey = marksKey;
        // blockTexts 是懒解析的（一万条 JSON）：没有标注时先别碰它
        if (state.marks.length === 0) clearMarkHighlights();
        else applyMarkHighlights(article, state.render.blockTexts, state.marks);
      }
    }

    const tasks = tasksFor(state);
    if (article !== null && (lastTasks === null || !sameTasks(lastTasks, tasks))) {
      applyTaskStates(article, tasks);
      lastTasks = tasks;
    }
  }

  update(initial);
  paintProgress();

  return {
    el: page,
    update,
    destroy() {
      cancelRemainder();
      if (scrollIdleTimer !== null) window.clearTimeout(scrollIdleTimer);
      page.removeAttribute('data-scrolling');
      window.removeEventListener('scroll', onScroll);
      selectionBinding?.destroy();
      selectionBinding = null;
      hideSelectionToolbar();
      clearMarkHighlights();
      ttsPlayer?.destroy();
      ttsPlayer = null;
    },
  };
}
