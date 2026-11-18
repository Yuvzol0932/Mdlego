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

interface ActiveTransition {
  /** 立即定位到终态并清理（被打断/重复触发时用）。 */
  finish(): void;
}

let active: ActiveTransition | null = null;

/** 是否有遮罩转场正在跑。 */
export function isPageTransitionRunning(): boolean {
  return active !== null;
}

/** 把正在跑的转场直接定位到终态（不播放剩余动画）。 */
export function settlePageTransition(): void {
  const running = active;
  active = null;
  running?.finish();
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
function watchFrames(onSlow: () => void): () => void {
  let stop = false;
  let last = performance.now();
  let streak = 0;
  const tick = (): void => {
    if (stop) return;
    const now = performance.now();
    const delta = now - last;
    last = now;
    streak = delta > LOW_END_FRAME_MS ? streak + 1 : 0;
    if (streak >= LOW_END_STREAK) {
      stop = true;
      onSlow();
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return () => {
    stop = true;
  };
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
}

/** 简单档/兜底：只淡入淡出，不动几何。 */
function fadeElement(el: HTMLElement, from: number, to: number, ms: number): Promise<void> {
  const anim = el.animate([{ opacity: String(from) }, { opacity: String(to) }], {
    duration: ms,
    easing: easing('--ease-standard', 'ease-out'),
    fill: 'both',
  });
  return anim.finished.then(() => undefined, () => undefined);
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

  // 旧页冻结成同尺寸滚动容器：保持滚动位置与 sticky 顶栏，作为遮罩背后的底图
  const behind = prev;
  const behindStyle = behind?.getAttribute('style') ?? null;
  if (behind !== null) {
    behind.classList.add('page-mask-behind');
    root.prepend(behind);
    behind.scrollTop = prevScroll;
  }

  const layer = document.createElement('div');
  layer.className = 'page-mask';
  layer.setAttribute('data-testid', 'page-mask');
  layer.dataset['phase'] = 'open';
  layer.dataset['maskFrom'] = maskOfRect(start, vw, vh);
  layer.dataset['maskTo'] = 'inset(0px round 0px)';
  root.append(layer);
  layer.append(next);

  // 阅读进度恢复发生在 openDoc 的 rAF 里：每帧把窗口滚动同步成遮罩层的滚动
  let syncing = true;
  let savedWindowScroll = window.scrollY;
  const syncScroll = (): void => {
    if (!syncing) return;
    savedWindowScroll = window.scrollY;
    layer.scrollTop = window.scrollY;
    requestAnimationFrame(syncScroll);
  };
  requestAnimationFrame(syncScroll);

  let anim: Animation | null = null;
  let stopWatch: (() => void) | null = null;
  let done = false;

  const cleanup = (restore: boolean): void => {
    if (done) return;
    done = true;
    syncing = false;
    stopWatch?.();
    try { anim?.cancel(); } catch { /* 已结束 */ }
    behind?.classList.remove('page-mask-behind');
    if (behind !== null) {
      if (behindStyle === null) behind.removeAttribute('style');
      else behind.setAttribute('style', behindStyle);
    }
    behind?.remove();
    // 阅读页放回文档流
    root.prepend(next);
    layer.remove();
    if (restore) {
      window.scrollTo(0, savedWindowScroll);
      announceScroll();
    }
    active = null;
    options.onSettled?.();
  };

  active = { finish: () => cleanup(true) };

  const from = maskOfRect(start, vw, vh);
  anim = layer.animate(
    [{ clipPath: from }, { clipPath: 'inset(0px round 0px)' }],
    { duration: OPEN_MS, easing: easing('--ease-decel', 'cubic-bezier(0, 0, 0, 1)'), fill: 'both' },
  );

  stopWatch = watchFrames(() => {
    // 低端机：放弃遮罩，直接全屏淡入
    try { anim?.cancel(); } catch { /* ignore */ }
    layer.style.clipPath = 'inset(0px round 0px)';
    fadeElement(layer as unknown as HTMLElement, 0, 1, SIMPLE_FADE_MS).then(() => cleanup(true), () => cleanup(true));
  });

  anim.finished.then(() => cleanup(true), () => cleanup(true));
}

/** 遮罩关闭（阅读页收回卡片矩形）。 */
export function runCloseMask(options: CloseMaskOptions): void {
  settlePageTransition();

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const prev = options.getPrevious();
  const prevScroll = window.scrollY;

  options.update();
  const next = options.getMounted();

  const settled = (): void => {
    active = null;
    options.onSettled?.();
  };

  if (options.level === 'off' || prev === null) {
    prev?.remove();
    settled();
    return;
  }

  const root = next?.parentElement ?? document.body;

  let anim: Animation | null = null;
  let stopWatch: (() => void) | null = null;
  let done = false;
  let layer: HTMLDivElement | null = null;

  const cleanup = (): void => {
    if (done) return;
    done = true;
    stopWatch?.();
    try { anim?.cancel(); } catch { /* 已结束 */ }
    layer?.remove();
    announceScroll();
    active = null;
    settled();
  };

  // 先占位，避免这 2 帧的空窗期被重复返回点击穿透
  active = { finish: cleanup };

  const startWith = (target: MaskRect | null): void => {
    if (done) return;
    layer = document.createElement('div');
    layer.className = 'page-mask page-mask--closing';
    layer.setAttribute('data-testid', 'page-mask');
    layer.dataset['phase'] = 'close';
    layer.dataset['maskFrom'] = 'inset(0px round 0px)';
    const closeTo = target === null ? '' : maskOfRect(target, vw, vh);
    if (closeTo.length > 0) layer.dataset['maskTo'] = closeTo;
    const layerEl = layer;
    root.append(layerEl);
    layerEl.append(prev);
    layerEl.scrollTop = prevScroll;

    if (options.level === 'simple') {
      layerEl.style.clipPath = 'inset(0px round 0px)';
      fadeElement(layerEl, 1, 0, SIMPLE_FADE_MS).then(cleanup, cleanup);
      return;
    }

    if (target === null) {
      // 兜底：以屏幕中心为原点 scale 0.94 + 淡出
      const fallbackLayer = layerEl;
      anim = fallbackLayer.animate(
        [{ opacity: '1', transform: 'scale(1)' }, { opacity: '0', transform: 'scale(0.94)' }],
        { duration: FALLBACK_MS, easing: easing('--ease-standard', 'ease-out'), fill: 'both' },
      );
      anim.finished.then(cleanup, cleanup);
      return;
    }

    const offset = options.startOffsetX ?? 0;
    const frames: Keyframe[] = [];
    if (offset > 0) {
      frames.push({ clipPath: 'inset(0px round 0px)', transform: `translateX(${Math.round(offset)}px)` });
    } else {
      frames.push({ clipPath: 'inset(0px round 0px)', transform: 'none' });
    }
    frames.push({ clipPath: closeTo, transform: 'none' });

    anim = layerEl.animate(frames, {
      duration: CLOSE_MS,
      easing: easing('--ease-accel', 'cubic-bezier(0.3, 0, 1, 1)'),
      fill: 'both',
    });

    stopWatch = watchFrames(() => {
      try { anim?.cancel(); } catch { /* ignore */ }
      layerEl.style.clipPath = closeTo;
      layerEl.style.opacity = '0';
      cleanup();
    });

    anim.finished.then(cleanup, cleanup);
  };

  // 等三帧再测目标：宿主挂载时 scrollTo、视图 update 与首屏布局要跨几帧才稳定，
  // 太早量会量到「挂载中途」的位置（实测偏 10px）。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (done) return;
        void document.body.offsetHeight;
        startWith(options.findTarget());
      });
    });
  });
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
