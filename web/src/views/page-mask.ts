/**
 * 书架 ⇄ 阅读页的「遮罩展开」转场（rc.3 A 项）。
 *
 * 设计（docs/MOTION.md 记时长与降级）：
 *   打开：阅读页挂在书架之上（不透明），clip-path 从被点卡片矩形扩到全屏，300ms decel；
 *   关闭：阅读页可见窗口从全屏缩回「当前书架里这本书的卡片矩形」，240ms；
 *        找不到卡片/不在可视区 → 屏幕中心 scale 0.94 + 淡出 200ms。
 *
 * 关键约束：
 *   - 不再使用 View Transitions（整条链路不出现 view-transition-name）；
 *   - 动画只做 clip-path / opacity / transform，不缩放内容尺寸；
 *   - 动画期间锁滚动、忽略重复点击；被打断时直接定位终态，不闪烁；
 *   - 低端机：连续 3 帧 > 32ms → 本次直接降级为 opacity 淡入。
 */

import { type MotionLevel } from '../core/motion';
import {
  BEHIND_SCALE_FROM,
  BEHIND_SCALE_TO,
  FULL_STATE,
  MORPH,
  MORPH_EASING,
  clipPathForScale,
  fitToCard,
  followState,
  openFade,
  scrimOpacity,
  stateForCard,
  transformOf,
  type MorphState,
} from '../core/morph';
import {
  buildSnapshotLayer,
  canSnapshot,
  snapshotViewport,
  type ViewportSnapshot,
} from './snapshot';

/** 视口坐标矩形。 */
export interface Rect {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** 带圆角的矩形（卡片圆角参与遮罩形状）。 */
export interface MaskRect extends Rect {
  readonly radius: number;
}

const OPEN_MS = 300;
const CLOSE_MS = 240;
const SIMPLE_FADE_MS = 160;
const FALLBACK_MS = 200;
const LOW_END_FRAME_MS = 32;
const LOW_END_STREAK = 3;
/** 低端机判定的时间窗口（ms）：只在开场的这几帧里判定，之后不再中途切模式。 */
const WATCH_WINDOW_MS = 120;

interface ActiveTransition {
  /** 立即定位到终态并清理（被打断/重复触发时用）。 */
  finish(): void;
}

let active: ActiveTransition | null = null;

/** 是否有遮罩转场正在跑。 */
export function isPageTransitionRunning(): boolean {
  return active !== null;
}

/**
 * 把正在跑的转场直接定位到终态（不播放剩余动画）。
 *
 * 这是**所有**转场收尾路径的唯一出口：正常结束、被新转场打断、
 * 用户按返回键、动画回调抛错，最终都会走到这里。
 *
 * 因此这里除了让动画落定，还必须**无条件**把书架卡片槽位的隐身摘掉。
 * 只依赖各转场自己的 `finish()` 是不够的：`finish` 可能因为异常没跑到，
 * 或者 `active` 为空（例如跟手层已被外部清掉但类名还挂在卡上），
 * 那时书架会永久少一张封面 —— 这类残留比动画卡顿严重得多。
 */
export function settlePageTransition(): void {
  const running = active;
  active = null;
  try {
    running?.finish();
  } finally {
    // 兜底：绝不允许任何异常把卡片永久留在隐身态
    clearMorphSlot();
  }
}

/** 元素视口矩形（含小数，断言时允许 ≤2px 误差）。 */
export function rectOfElement(el: Element): MaskRect {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const radius = Number.parseFloat(cs.borderTopLeftRadius) || 0;
  return { top: r.top, right: r.right, bottom: r.bottom, left: r.left, radius };
}

/** 视口坐标矩形转 clip-path: inset(... round R)。 */
export function maskOfRect(rect: MaskRect, vw: number, vh: number): string {
  const top = Math.max(0, Math.min(vh, rect.top));
  const left = Math.max(0, Math.min(vw, rect.left));
  const right = Math.max(0, Math.min(vw, rect.right));
  const bottom = Math.max(0, Math.min(vh, rect.bottom));
  const radius = Math.max(0, Math.min(rect.radius, (right - left) / 2, (bottom - top) / 2));
  return `inset(${round(top)}px ${round(vw - right)}px ${round(vh - bottom)}px ${round(left)}px round ${round(radius)}px)`;
}

const round = (n: number): number => Math.round(n * 10) / 10;

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

/** 屏幕中心 70% 的兜底矩形（没有可靠卡片时用）。 */
function centerRect(vw: number, vh: number): MaskRect {
  const w = vw * 0.7;
  const h = vh * 0.7;
  return { top: (vh - h) / 2, right: (vw + w) / 2, bottom: (vh + h) / 2, left: (vw - w) / 2, radius: 16 };
}

/** 读取动效令牌里的缓动（WAAPI 不认 CSS 变量，必须取计算值）。 */
function easing(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw.length > 0 ? raw : fallback;
}

function announceScroll(): void {
  // 页面挪回文档流后补一次 scroll 事件：顶栏两态/阅读进度都靠它刷新
  window.dispatchEvent(new Event('scroll'));
}

/** 低端机保护：连续 3 帧 > 32ms 就把本次动画降级为淡入。 */
/**
 * 低端机自检：**只在动画开场的一小段时间里**判定，命中后本次动画整体降级。
 *
 * #C 第 7 条要求「模式在动画开始前决定，动画进行中不得中途切换」——
 * 原来这个探针整段动画都在跑，一旦中途连续三帧超时就当场把几何动画
 * cancel 掉改成淡入，用户看到的是「卡一帧然后画面跳变」，比全程掉帧更难受。
 *
 * 现在判定窗口限制在开场 `WATCH_WINDOW_MS` 内：这几帧本来就该是最卡的
 * （首屏挂载刚结束），能反映设备有没有余量；过了窗口就只看不判，
 * 让本次动画跑完。降级结果通过 `onSlow` 的返回值记录到下一次打开。
 *
 * @param onSlow 判定为低端机时的回调（本次动画立刻整体降级）
 * @param windowMs 判定窗口（默认 120ms，约 7 帧@60Hz）
 */
function watchFrames(onSlow: () => void, windowMs = WATCH_WINDOW_MS): () => void {
  let stop = false;
  let last = performance.now();
  const startedAt = last;
  let streak = 0;
  const tick = (): void => {
    if (stop) return;
    const now = performance.now();
    const delta = now - last;
    last = now;
    streak = delta > LOW_END_FRAME_MS ? streak + 1 : 0;
    if (streak >= LOW_END_STREAK && now - startedAt <= windowMs) {
      stop = true;
      onSlow();
      return;
    }
    // 判定窗口已过：不再判，本次动画完整跑完
    if (now - startedAt > windowMs) return;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return () => {
    stop = true;
  };
}

/**
 * 等动画结束，但**不接受「永远不结束」**。
 *
 * 为什么必须有超时兜底：Web Animations 的 `Animation.finished` 只在
 * 时间线推进时才 resolve。Android WebView 在 `document.hidden`（息屏、
 * 切后台、锁屏、被系统挂起）期间会**冻结时间线**，此时：
 *   - `finished` 永远 pending，`fill: 'both'` 让视觉停在最后一帧；
 *   - 但所有收尾逻辑（拆临时层、恢复卡片隐身、提交导航）都挂在 then 上，
 *     于是一次转场就能把整个应用卡死 —— 用户回来看到的是「点了返回没反应」。
 *
 * 实测（小米 11 Ultra / Android 14 / HyperOS）：息屏状态下
 * `a.finished` 500ms 后仍是 `running`，永不 resolve。
 *
 * 所以这里用「动画结束」与「超时」赛跑，谁先到谁收尾。超时取
 * `durationMs + 一帧余量`：正常环境永远不会走到超时分支，时间线冻结时
 * 也能保证导航一定完成。
 */
function settleAnimation(anim: Animation, durationMs: number, done: () => void): void {
  let settled = false;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    done();
  };
  const timer = window.setTimeout(finish, Math.max(0, durationMs) + 120);
  anim.finished.then(finish, finish);
}

interface CommonOptions {
  readonly level: MotionLevel;
  /** 真正改状态（宿主会在 store 订阅里同步挂载新页面）。 */
  readonly update: () => void;
  /** 更新后的新页面根节点。 */
  readonly getMounted: () => HTMLElement | null;
  /** 更新前调用，拿到旧页面根节点（含被宿主摘掉后的复用）。 */
  readonly getPrevious: () => HTMLElement | null;
  /** 全部收尾后回调（挂载剩余正文、刷新状态等）。 */
  readonly onSettled?: () => void;
  /**
   * 书架上的目标卡片元素（原卡槽防重影用）。
   * 转场期间给它加 `.is-morph-slot-hidden`（visibility: hidden 保留占位），
   * 避免屏幕上同时出现「书架上那张卡」与「转场里的书封」两个相同封面。
   */
  readonly slotElement?: HTMLElement | null;
  /**
   * 解析「当前实际在文档里的」目标卡片元素。
   *
   * `update()` 会触发书架重渲染，之前抓到的节点可能已被替换成脱离文档的旧节点。
   * 提供此函数时，转场会在 update() 之后调用它取实时节点（优先于 slotElement）。
   */
  readonly resolveSlot?: () => HTMLElement | null;
  /** 卡槽被设为隐身时回调（宿主可用于记录，便于异常自愈）。 */
  readonly onSlotHidden?: (el: HTMLElement | null) => void;
}

export interface OpenMaskOptions extends CommonOptions {
  /** 被点卡片矩形（视口坐标）；null → 屏幕中心兜底。 */
  readonly startRect: MaskRect | null;
}

export interface CloseMaskOptions extends CommonOptions {
  /** 更新后重新测量目标卡片矩形；null → 中心缩放淡出兜底。 */
  readonly findTarget: () => MaskRect | null;
  /** 左缘手势提交时的当前位移（px），动画从该位置接着播。 */
  readonly startOffsetX?: number;
  /**
   * 跟手松手时的实时形变状态（Android 预测式返回 / 边缘手势）。
   * 提供时**不再弹回全屏再重播关闭动画**：直接以这一帧作为关闭动画的
   * 起始关键帧，视觉上没有第二段起手。
   */
  readonly startMorph?: MorphState | null;
  /** 关闭时目标卡片的元素（原卡槽防重影 + 测量圆角）。 */
  readonly findTargetElement?: () => HTMLElement | null;
}

// ── 卡片槽位防重影 ─────────────────────────────────────
//
// 转场期间把书架目标卡隐身，避免出现两个相同封面。
// 必须在 try/finally、动画 finish/cancel 以及超时保护里**百分之百**移除，
// 绝不允许任何异常导致卡片永久隐身或页面锁死。

/** 当前被隐身的卡片（用于异常自愈）。 */
let hiddenSlot: HTMLElement | null = null;

const MORPH_SLOT_CLASS = 'is-morph-slot-hidden';

/**
 * 把书架上的一张卡设为隐身（原卡槽防重影）。
 *
 * 幂等：重复对同一元素调用不会反复增删类名。
 * 先恢复上一张（如果有），再加新的 —— 顺序不能反，否则会把刚加的立刻清掉。
 */
function hideMorphSlot(el: HTMLElement | null | undefined, onHidden?: (el: HTMLElement | null) => void): void {
  if (el === null || el === undefined) {
    clearMorphSlot();
    return;
  }
  // 已经是同一个元素：什么都不做（避免无谓的类名抖动）
  if (hiddenSlot === el && el.classList.contains(MORPH_SLOT_CLASS)) {
    onHidden?.(el);
    return;
  }
  clearMorphSlot();
  el.classList.add(MORPH_SLOT_CLASS);
  hiddenSlot = el;
  onHidden?.(el);
}

/** 无条件恢复卡片可见性。可重复调用。 */
export function clearMorphSlot(): void {
  const el = hiddenSlot;
  hiddenSlot = null;
  if (el === null) return;
  try {
    el.classList.remove(MORPH_SLOT_CLASS);
  } catch {
    /* 元素可能已被书架重绘淘汰，无需处理 */
  }
}

/**
 * 测试与诊断入口：把一张卡设为隐身。
 *
 * 生产代码走内部 `hideMorphSlot`（还带 `onHidden` 回调）；
 * 这里只暴露「登记 + 加类名」这一步，让单测能验证账本语义，
 * 而不必去碰 FLIP 动画的时序。**不要在视图代码里调用它**。
 */
export function markMorphSlotHidden(el: HTMLElement): void {
  hideMorphSlot(el);
}

/** 当前是否有卡片被隐身（诊断与测试用）。 */
export function hasHiddenMorphSlot(): boolean {
  return hiddenSlot !== null;
}

/**
 * 构造书籍封面克隆层。
 *
 * 从被点卡片的矩形与服务端无关的封面视觉（`--cover-art` / 首字）复制出
 * 一层「书封」，让退书收尾由它精准落入卡槽 —— 彻底消灭
 * 「白底黑字正文硬切成深色书封」的突变。
 *
 * 拿不到封面视觉信息时（例如从搜索/深链进入），退回纯色底，
 * 交叉溶解仍然成立，只是没有首字角标。
 */
function buildCoverLayer(card: MaskRect): HTMLElement {
  const cover = document.createElement('div');
  cover.className = 'page-mask__cover';
  // 封面底色用书架同款色板：`--cover-1..8` 由卡片上的 data-cover 选择，
  // 这里通过 CSS 变量把「当前这本书的色板」带过来（色值仍在 tokens.css）。
  const dataset = coverArtOf(card);
  if (dataset !== null) {
    cover.setAttribute('data-cover', dataset.index);
    const initial = document.createElement('span');
    initial.className = 'page-mask__cover-initial';
    initial.textContent = dataset.initial;
    cover.append(initial);
  }
  return cover;
}

/** 被点卡片的封面视觉（色板序号 + 首字）；拿不到返回 null。 */
function coverArtOf(card: MaskRect): { readonly index: string; readonly initial: string } | null {
  void card;
  const el = lastClickedCard;
  if (el === null) return null;
  const coverEl = el.matches('[data-cover]') ? el : el.querySelector<HTMLElement>('[data-cover]');
  if (coverEl === null) return null;
  const index = coverEl.getAttribute('data-cover');
  if (index === null) return null;
  const initialEl = coverEl.querySelector<HTMLElement>('.cover__initial');
  return { index, initial: initialEl?.textContent ?? '' };
}

/** 最近一次被点击的目标元素（由 main 在 dispatch 前设置）。 */
let lastClickedCard: HTMLElement | null = null;

/** 记录被点击的卡片元素，供封面克隆使用。 */
export function setLastClickedCard(el: HTMLElement | null): void {
  lastClickedCard = el;
}

/** 简单档/兜底：只淡入淡出，不动几何。 */
function fadeElement(el: HTMLElement, from: number, to: number, ms: number): Promise<void> {
  const anim = el.animate([{ opacity: String(from) }, { opacity: String(to) }], {
    duration: ms,
    easing: easing('--ease-standard', 'ease-out'),
    fill: 'both',
  });
  // 同样不能只等 finished：时间线被冻结时它永不 resolve（见 settleAnimation）
  return new Promise((resolve) => settleAnimation(anim, ms, resolve));
}

/** 遮罩打开。 */
export function runOpenMask(options: OpenMaskOptions): void {
  settlePageTransition();

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const prev = options.getPrevious();
  const prevScroll = window.scrollY;

  options.update();
  const next = options.getMounted();
  if (next === null) {
    prev?.remove();
    options.onSettled?.();
    return;
  }
  if (options.level === 'off') {
    prev?.remove();
    options.onSettled?.();
    return;
  }

  const settled = (): void => {
    active = null;
    options.onSettled?.();
  };

  if (options.level === 'simple') {
    prev?.remove();
    fadeElement(next, 0, 1, SIMPLE_FADE_MS).then(settled, settled);
    return;
  }

      const start = options.startRect ?? centerRect(vw, vh);
  const root = next.parentElement ?? document.body;

  // 旧页冻结成同尺寸滚动容器：保持滚动位置与 sticky 顶栏，作为遮罩背后的底图。
  // 同时给它加上景深微缩（打开时 1 → 0.95），让底层书架有「沉下去」的层次感。
  const behind = prev;
  const behindStyle = behind?.getAttribute('style') ?? null;
  if (behind !== null) {
    behind.classList.add('page-mask-behind');
    root.prepend(behind);
    behind.scrollTop = prevScroll;
  }

  // ── FLIP 双层形变结构（转场改造 Step 3）──────────────
  //
  //   .page-mask-scrim    背景压暗层（固定全屏，只动 opacity）
  //   .page-mask          几何形变壳（transform-origin: 0 0，动 transform + border-radius）
  //     .page-mask__reader  阅读视口层（100vw × 100vh，唯一的滚动容器，承载正文）
  //     .page-mask__cover   书籍封面克隆层（交叉溶解，收尾时精准落入卡槽）
  //
  // 为什么不把 transform 直接打在原来的滚动容器上：滚动容器一旦被缩放，
  // 内部的 scrollTop 语义会被乘上 scale，锚点定位随之错位。
  // 所以形变壳与滚动层必须分开。
  const stage = document.createElement('div');
  stage.className = 'page-mask';
  stage.setAttribute('data-testid', 'page-mask');
  stage.dataset['phase'] = 'open';
  stage.dataset['maskFrom'] = maskOfRect(start, vw, vh);
  stage.dataset['maskTo'] = 'inset(0px round 0px)';
  stage.dataset['morph'] = 'flip';

  const readerLayer = document.createElement('div');
  // #D：打开方向这一层装的是**真实阅读页**，必须可交互 ——
  // 否则转场期间 article 的 pointer-events 继承到 none，长按选词收不到事件。
  // 关闭方向的同名层装快照，保持不可交互（默认态）。
  readerLayer.className = 'page-mask__reader page-mask__reader--live';
  readerLayer.setAttribute('data-testid', 'page-mask-reader');
  readerLayer.append(next);

  const coverLayer = buildCoverLayer(start);
  stage.append(readerLayer, coverLayer);
  root.append(stage);

  // 背景压暗层：打开时 0 → 1
  const scrim = document.createElement('div');
  scrim.className = 'page-mask-scrim';
  scrim.setAttribute('data-testid', 'page-mask-scrim');
  root.insertBefore(scrim, stage);

  // 打开转场期间：阅读页在 fixed 形变壳里，`window` 滚动被夹到 0，
  // 阅读视口层的 `scrollTop` 才是唯一真实的滚动位置（首帧同步锚定会写它）。
  // 以前这里每帧用 `window.scrollY` 反向覆盖滚动位置，
  // 结果锚点定位被逐帧打回 0 —— 这就是「先露第一屏再瞬移」的根因。
  // #C：这里原来挂了一个**空转**的 requestAnimationFrame 循环
  // （syncScroll 每帧醒来只判断 syncing 然后就排下一帧，什么都不做）。
  // 它在整个 400ms 转场里持续占一个 rAF 槽，纯属浪费，已删除。
  // 真实的滚动同步由 reader.ts 的锚定 + cleanup 里的交还逻辑负责。

  let anim: Animation | null = null;
  let stopWatch: (() => void) | null = null;
  let done = false;

  const cleanup = (restore: boolean): void => {
    if (done) return;
    done = true;
    stopWatch?.();
    try { anim?.cancel(); } catch { /* 已结束 */ }
    // 先取真实的滚动位置：解绑 fixed 之后它就没了
    const maskScroll = readerLayer.scrollTop;
    // 收尾必须无条件清掉卡片槽位隐身与景深缩放，绝不允许异常导致书架永久隐身
    clearMorphSlot();
    behind?.classList.remove('page-mask-behind');
    if (behind !== null) {
      if (behindStyle === null) behind.removeAttribute('style');
      else behind.setAttribute('style', behindStyle);
    }
    behind?.remove();
    scrim.remove();
    // 阅读页放回文档流
    readerLayer.removeChild(next);
    root.prepend(next);
    stage.remove();
    if (restore) {
      // 同一同步帧内把形变壳里的滚动偏移交给 window：视觉上零跳变。
      // 注意：readerLayer 的 scrollTop 是**内层**滚动容器的值，
      // 它与文档级 scrollY 是同一个坐标系（都从内容顶部算），所以可直接赋值。
      window.scrollTo(0, maskScroll);
      announceScroll();
    }
    active = null;
    options.onSettled?.();
  };

  active = { finish: () => cleanup(true) };

  const from = stateForCard(
    { left: start.left, top: start.top, width: start.right - start.left, height: start.bottom - start.top, radius: start.radius },
    { width: vw, height: vh },
  );
  const fit = fitToCard(
    { left: start.left, top: start.top, width: start.right - start.left, height: start.bottom - start.top, radius: start.radius },
    { width: vw, height: vh },
  );
  // stateForCard 走的是纯函数默认圆角（卡片自身半径 / scale）；
  // 但真实起点可能来自 card 容器（border-radius 在最外层）。
  // 这里若测得圆角为 0，退回用形变壳自身的初始圆角，避免「一上来就是直角」。
  const fromStart = fit.cardRadius > 0 && from.radius <= 0 ? { ...from, radius: fit.cardRadius } : from;

  // #B：封面克隆层高度 = 形变壳未缩放坐标系里的封面高度（cardUnscaledH），
  // 而不是 `inset: 0` 被拉成屏幕比例。这里复用**已算出的** fit，
  // 不再调用第二次 fitToCard（#C：首帧里每一次多余计算都在红线预算内）。
  coverLayer.style.height = `${Math.max(0, fit.cardUnscaledH)}px`;
  coverLayer.style.top = '0';

  // 原卡槽防重影：转场期间把书架上那张卡隐身（保留占位，不触发重排）。
  //
  // 必须在 update() **之后**再取一次 DOM 节点：update() 会触发书架重渲染，
  // 之前抓到的节点可能已经被替换成一个脱离文档的旧节点 —— 给旧节点加隐身类
  // 用户完全看不到，屏幕上仍会同时出现两个相同封面。
  // resolveSlot 在 update 之后返回**当前实际在文档里**的那个元素。
  hideMorphSlot(options.resolveSlot?.() ?? options.slotElement, options.onSlotHidden);

  // 形变壳初始状态 = 卡片态。
  //
  // #B：几何必须裁成**封面的宽高比**。形变壳是全屏尺寸，卡片态只是等比缩到
  // 卡片宽度；手机屏幕比 3:4 书封修长得多，不裁的话卡片态是一个「又高又窄的
  // 矩形」压在书架上，盖住标题和邻居（v1.2.0 只把 clipBottom 当布尔用，
  // 写了一个零裁剪的 inset(0 0 0 0)）。
  //
  // 圆角也交给 clip-path 的 round 承担，不再动画 border-radius：
  //   - 圆角裁剪本来就要做，两处写会出现两套半径对不上；
  //   - border-radius 变化每帧要在主线程重绘圆角裁剪，是掉帧来源之一。
  stage.style.transform = transformOf(fromStart);
  stage.style.transformOrigin = '0 0';
  stage.style.clipPath = clipPathForScale(fit, fromStart.scale, vh, true);

  // #C：阅读层**不做** opacity 动画。
  //
  // 阅读层是个装着几千像素 DOM 的滚动容器，对它做 opacity 会让浏览器
  // 生成一个整屏大小的离屏渲染面并每帧重新合成 —— 打开动画的主要掉帧来源之一
  // （实测比去掉后多 6–10ms/帧）。
  //
  // 「从书封展开」的观感由封面层在上方淡出 + 形变壳缩放负责，视觉上足够；
  // 阅读层保持 opacity 1，形变壳收缩时它只是被 clip-path 与 scale 裁小。
  const fade = openFade(1);
  coverLayer.style.opacity = String(fade.coverOpacity);
  readerLayer.style.opacity = '1';

  anim = stage.animate(
    [
      // 端点：卡片态裁成封面矩形 / 全屏态不裁剪。
      // 中途由浏览器插值，宽高比从封面比过渡到屏幕比 —— 这是展开本该有的样子。
      {
        transform: transformOf(fromStart),
        clipPath: clipPathForScale(fit, fromStart.scale, vh, true),
        offset: 0,
      },
      {
        transform: transformOf(FULL_STATE),
        clipPath: clipPathForScale(fit, FULL_STATE.scale, vh, false),
        offset: 1,
      },
    ],
    { duration: MORPH.openMs, easing: MORPH_EASING, fill: 'both' },
  );

  // 封面淡出 / 阅读层淡入 / 书架景深 / 压暗层：独立动画，各自跑在自己的时间轴上
  coverLayer.animate(
    [{ opacity: '1' }, { opacity: '0' }],
    { duration: MORPH.openMs * 0.36, easing: MORPH_EASING, fill: 'both' },
  );
  // （阅读层 opacity 动画已按 #C 移除，见上方说明）
  scrim.animate([{ opacity: '0' }, { opacity: '1' }], {
    duration: MORPH.openMs,
    easing: MORPH_EASING,
    fill: 'both',
  });
  if (behind !== null) {
    behind.animate(
      [{ transform: `scale(${BEHIND_SCALE_FROM})` }, { transform: `scale(${BEHIND_SCALE_TO})` }],
      { duration: MORPH.openMs, easing: MORPH_EASING, fill: 'both' },
    );
  }

  stopWatch = watchFrames(() => {
    // 低端机：放弃形变，直接全屏淡入（保住功能可用性）
    try { anim?.cancel(); } catch { /* ignore */ }
    stage.style.transform = 'none';
    stage.style.clipPath = 'none';
    coverLayer.style.opacity = '0';
    readerLayer.style.opacity = '1';
    fadeElement(stage, 0, 1, SIMPLE_FADE_MS).then(() => cleanup(true), () => cleanup(true));
  });

  settleAnimation(anim, MORPH.openMs, () => cleanup(true));
}

/** 遮罩关闭（阅读页收回卡片矩形）。 */
export function runCloseMask(options: CloseMaskOptions): void {
  settlePageTransition();

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const prev = options.getPrevious();
  const prevScroll = window.scrollY;

  const settled = (): void => {
    active = null;
    options.onSettled?.();
  };

  if (options.level === 'off' || prev === null) {
    options.update();
    options.getPrevious()?.remove();
    settled();
    return;
  }

  // ── 严格单帧原子准备（转场改造 Step 2）────────────────────────
  //
  // 旧实现在这里先 update()（把阅读页摘掉、换成书架），再连等 3 帧才测目标卡片，
  // 于是中间有约 166ms「底层书架已经露出来、顶层转场层还没盖上去」的空窗 ——
  // 用户看到的就是退书瞬间闪一下书架。
  //
  // 新顺序（全部在同一个同步调用栈里完成，中间没有任何 await / rAF）：
  //   1. 先从**还在屏上的**阅读页提取视口轻量快照；
  //   2. 立刻把关闭转场层压在最上层（视觉零跳变）；
  //   3. 再把底层切成书架（这一步在转场层之下，用户看不见）；
  //   4. 同一帧内强制一次布局，量出目标卡片矩形作为收拢终点。
  //
  // 第 1 步必须在 update() 之前，因为 update() 会把阅读页从 DOM 里摘掉。

  // ── 1. 视口快照 ──
  // 只克隆视口内可见的十来个块，而不是整篇（900KB 文档 3751 块 / 三万多节点）。
  // 这是把退出转场从约 6fps 拉回满帧的关键。
  let snapshot: ViewportSnapshot | null = null;
  const article = prev.querySelector<HTMLElement>('[data-testid="article"]');
  if (article !== null) {
    snapshot = snapshotViewport(article, vh);
  }

  const layer = document.createElement('div');
  layer.className = 'page-mask page-mask--closing';
  layer.setAttribute('data-testid', 'page-mask');
  layer.dataset['phase'] = 'close';
  layer.dataset['maskFrom'] = 'inset(0px round 0px)';
  layer.dataset['snapshot'] = snapshot !== null && canSnapshot(snapshot) ? '1' : '0';

  // ── 2. 先挂转场层（此时 prev 还在 DOM 上、画面没变）──
  const root = prev.parentElement ?? document.body;
  root.append(layer);

  // 快照层替代整树：内容与原件逐像素对齐地铺在一屏里。
  // 外面再包一层 .page-mask__reader，让它与打开方向的形变壳结构同构 ——
  // 关闭时阅读层整体淡出，封面层独立升起，两层交叉溶解。
  let snapshotLayer: HTMLElement | null = null;
  const readerInner = document.createElement('div');
  readerInner.className = 'page-mask__reader';
  readerInner.setAttribute('data-testid', 'page-mask-reader');
  if (snapshot !== null && canSnapshot(snapshot)) {
    snapshotLayer = buildSnapshotLayer(snapshot, 'page-mask__snapshot');
    readerInner.append(snapshotLayer);
  } else {
    // 兜底（抓不到正文块，例如渲染失败页）：退回整页克隆，行为与旧实现一致
    readerInner.append(prev.cloneNode(true) as HTMLElement);
  }
  // 关闭方向的形变壳内部两层：阅读层在下载，封面层在上
  const coverLayer = buildCoverLayer(
    options.findTarget() !== null ? (options.findTarget() as MaskRect) : centerRect(vw, vh),
  );
  // #B：与打开方向一致 —— 封面层高度按封面比例，不被拉成屏幕比例
  if (options.findTarget() !== null) {
    const t = options.findTarget() as MaskRect;
    const cfit = fitToCard(
      { left: t.left, top: t.top, width: t.right - t.left, height: t.bottom - t.top, radius: t.radius },
      { width: vw, height: vh },
    );
    coverLayer.style.height = `${Math.max(0, cfit.cardUnscaledH)}px`;
    coverLayer.style.top = '0';
  }
  coverLayer.style.opacity = '0';
  layer.append(readerInner, coverLayer);
  const readerLayer: HTMLElement = readerInner;

  // ── 2b. 目标卡片槽位防重影 ──
  //
  // 关闭方向有个时序陷阱：进入本函数时 DOM 上还挂着**阅读页**，书架尚未渲染，
  // 此刻按 docId 查卡片一定查不到（返回 null）。
  // 所以这里不做预置隐身，统一放到 update() 之后由 resolveSlot 取实时节点，
  // 那时书架已经在 DOM 上、卡片位置也已确定。
  void options.findTargetElement;

  // ── 3. 底层切成书架（在转场层之下，视觉无感）──
  options.update();

  // update() 之后重渲染可能替换卡片节点：用 resolveSlot 重新取一次实时节点，
  // 确保隐身类挂在**当前在文档里**的那个元素上（否则会出现两个相同封面）。
  // 注意：解析不到（null）时**不要**调用 hideMorphSlot(null) ——
  // 那会走 clearMorphSlot 分支，把上面刚加上的隐身清掉。
  if (options.resolveSlot !== undefined) {
    const live = options.resolveSlot();
    if (live !== null) hideMorphSlot(live, options.onSlotHidden);
  }

  let anim: Animation | null = null;
  let stopWatch: (() => void) | null = null;
  let done = false;

  /** 关掉所有子动画（cleanup 与被低端机降级时调用）。 */
  const extraAnims: Animation[] = [];

  const cleanup = (): void => {
    if (done) return;
    done = true;
    stopWatch?.();
    try { anim?.cancel(); } catch { /* 已结束 */ }
    for (const a of extraAnims) {
      try { a.cancel(); } catch { /* 已结束 */ }
    }
    // 无条件恢复卡片可见性：绝不允许异常导致书架永久隐身
    clearMorphSlot();
    snapshotLayer?.remove();
    scrim.remove();
    layer.remove();
    announceScroll();
    active = null;
    settled();
  };

  active = { finish: cleanup };

  // ── 4. 同一帧内量目标卡片（强制一次同步布局即可，不再等 3 帧）──
  // 前面的 update() 已经让书架挂到 DOM 上；这里立刻读 offsetHeight 把布局
  // 结算掉，然后量卡片矩形。等待 3 帧反而会露出空窗，正是要消除的缺陷。
  void document.body.offsetHeight;
  const target = options.findTarget();
  const closeTo = target === null ? '' : maskOfRect(target, vw, vh);
  if (closeTo.length > 0) layer.dataset['maskTo'] = closeTo;
  layer.dataset['morph'] = 'flip';

  // 背景压暗层（关闭：1 → 0）
  const scrim = document.createElement('div');
  scrim.className = 'page-mask-scrim';
  scrim.setAttribute('data-testid', 'page-mask-scrim');
  root.insertBefore(scrim, layer);

  if (options.level === 'simple') {
    layer.style.clipPath = 'inset(0px round 0px)';
    fadeElement(layer, 1, 0, SIMPLE_FADE_MS).then(cleanup, cleanup);
    return;
  }

  if (target === null) {
    // 兜底：以屏幕中心为原点 scale 0.94 + 淡出
    anim = layer.animate(
      [{ opacity: '1', transform: 'scale(1)' }, { opacity: '0', transform: 'scale(0.94)' }],
      { duration: FALLBACK_MS, easing: easing('--ease-standard', 'ease-out'), fill: 'both' },
    );
    settleAnimation(anim, FALLBACK_MS, cleanup);
    return;
  }

  // ── FLIP 收拢：形变壳从全屏（或跟手松手的实时矩阵）落进卡片槽位 ──
  //
  // 终点几何：位移 + 等比缩放 + 圆角补偿（与打开方向共用 core/morph.ts 的纯函数）。
  const card = {
    left: target.left,
    top: target.top,
    width: target.right - target.left,
    height: target.bottom - target.top,
    radius: target.radius,
  };
  const viewport = { width: vw, height: vh };
  const to = stateForCard(card, viewport);
  const fit = fitToCard(card, viewport);

  // 起点：跟手松手时的实时矩阵（有则接着播，严禁先弹回全屏再重播）
  const startState: MorphState =
    options.startMorph !== null && options.startMorph !== undefined
      ? options.startMorph
      : FULL_STATE;

  // #B：关闭方向同样用 clip-path 裁成封面的宽高比。
  // 起止两端都按**各自的 scale** 算，圆角只由 clip-path 的 round 承担。
  // 跟手松手时可能停在中间态：按 scale 反推该用哪个端点（>=95% 视为全屏）
  const startCollapsed = startState.scale < 0.95;
  const clipFrom = clipPathForScale(fit, startState.scale, vh, startCollapsed);
  const clipTo = clipPathForScale(fit, to.scale, vh, true);
  layer.style.transform = transformOf(startState);
  layer.style.transformOrigin = '0 0';
  layer.style.clipPath = clipFrom;

  // 交叉溶解的初始透明度（关闭方向：阅读层满、封面透明）
  if (readerLayer !== null) readerLayer.style.opacity = '1';
  if (coverLayer !== null) coverLayer.style.opacity = '0';

  anim = layer.animate(
    [
      { transform: transformOf(startState), clipPath: clipFrom, offset: 0 },
      { transform: transformOf(to), clipPath: clipTo, offset: 1 },
    ],
    { duration: MORPH.closeMs, easing: MORPH_EASING, fill: 'both' },
  );

  // 阅读层 0→0.38 快速淡出；封面 0.10→0.48 升起，后半程由清晰书封精准落位。
  // 这样收尾不再出现「白底黑字正文硬切成深色书封」的突变。
  // #C：关闭方向也不动阅读层 opacity（同一原因：整屏离屏合成面）。
  // 收拢过程里形变壳在缩小，阅读内容由封面层盖住，视觉上没有信息损失。
  if (coverLayer !== null) {
    extraAnims.push(
      coverLayer.animate(
        [
          { opacity: '0', offset: 0 },
          { opacity: '0', offset: 0.1 },
          { opacity: '1', offset: 0.48 },
          { opacity: '1', offset: 1 },
        ],
        { duration: MORPH.closeMs, easing: MORPH_EASING, fill: 'both' },
      ),
    );
  }
  // 背景压暗淡出；底层书架从 0.95 浮起恢复 1
  extraAnims.push(
    scrim.animate([{ opacity: '1' }, { opacity: '0' }], {
      duration: MORPH.closeMs,
      easing: MORPH_EASING,
      fill: 'both',
    }),
  );
  // 底层书架同步浮起（景深）。
  //
  // DOM 结构（update 之后）：[书架页, .page-mask-scrim, .page-mask--closing]
  // 所以书架 = 转场层之前、跳过 scrim 的那个兄弟节点。
  const shelfEl = (() => {
    let node: Element | null = layer.previousElementSibling;
    while (node !== null) {
      if (node.matches('.page-mask-scrim') || node.matches('[data-testid="page-mask"]')) {
        node = node.previousElementSibling;
        continue;
      }
      return node instanceof HTMLElement && node.isConnected ? node : null;
    }
    return null;
  })();
  // 记录到 dataset 供验收脚本断言（不影响渲染）
  layer.dataset['behind'] = shelfEl === null ? 'none' : '1';
  if (shelfEl !== null) {
    extraAnims.push(
      shelfEl.animate(
        [{ transform: `scale(${BEHIND_SCALE_TO})` }, { transform: `scale(${BEHIND_SCALE_FROM})` }],
        { duration: MORPH.closeMs, easing: MORPH_EASING, fill: 'both' },
      ),
    );
  } else {
    // 拿不到书架节点时，把景深叠在压暗层上（视觉上等价：底图会「浮起」）
    extraAnims.push(
      scrim.animate(
        [
          { opacity: '1', transform: `scale(${BEHIND_SCALE_TO})` },
          { opacity: '0', transform: `scale(${BEHIND_SCALE_FROM})` },
        ],
        { duration: MORPH.closeMs, easing: MORPH_EASING, fill: 'both' },
      ),
    );
  }

  // 卡片态需要裁掉等比缩放后超出卡片高度的部分
  void fit;

  stopWatch = watchFrames(() => {
    // 低端机：直接落到终态，别让动画掉帧反而更难看
    try { anim?.cancel(); } catch { /* ignore */ }
    layer.style.transform = transformOf(to);
    layer.style.borderRadius = `${to.radius}px`;
    layer.style.opacity = '0';
    cleanup();
  });

  settleAnimation(anim, MORPH.closeMs, cleanup);
}

/** 非书架⇄阅读页的换页（设置/搜索/统计）：只做一次短淡入。 */
export function runPageFade(level: MotionLevel, update: () => void): void {
  settlePageTransition();
  update();
  if (level === 'off') return;
  const el = document.querySelector<HTMLElement>('#app > .shell');
  if (el === null) return;
  if (level === 'simple' || !supportsFull(level)) {
    void fadeElement(el, 0, 1, SIMPLE_FADE_MS);
    return;
  }
  const anim = el.animate(
    [{ opacity: '0', transform: 'translateY(12px)' }, { opacity: '1', transform: 'none' }],
    { duration: 200, easing: easing('--ease-decel', 'cubic-bezier(0, 0, 0, 1)') },
  );
  anim.finished.catch(() => undefined);
}

function supportsFull(level: MotionLevel): boolean {
  return level === 'full';
}

export const PAGE_MASK = {
  openMs: OPEN_MS,
  closeMs: CLOSE_MS,
  simpleFadeMs: SIMPLE_FADE_MS,
  fallbackMs: FALLBACK_MS,
  lowEndFrameMs: LOW_END_FRAME_MS,
  lowEndStreak: LOW_END_STREAK,
} as const;

export { clamp };
