/**
 * 页面转场的 DOM 封装（阶段 D2）。
 *
 * core/motion.ts 只判断「该不该动、动多久」；这里负责真正驱动 DOM：
 *   - 支持 View Transitions 且强度为 full → 用平台转场
 *   - 否则 → 新页面挂载后加降级进入动画（full：淡入+上移 12px；simple：只淡入）
 *
 * 共享矩形（书架封面 ↔ 阅读页）不是真正的共享元素动画：
 * 旧快照给封面、新快照给阅读页根节点都命名 `page-surface`，由浏览器做
 * 「矩形形变 + 交叉淡入」。阅读页里没有与封面一一对应的元素，所以不声称
 * 是共享元素；细节见 docs/DECISION-phase-D.md §3。
 */

import { allowsViewTransition, pageEnterClass, pageDuration, type MotionLevel } from '../core/motion';

/** 动态 view-transition-name：转场前后加/删，避免污染后续快照。 */
const SURFACE_NAME = 'page-surface';

interface ViewTransitionLike {
  readonly finished: Promise<void>;
  readonly ready: Promise<void>;
}

type ViewTransitionCapableDocument = Document & {
  startViewTransition?: (callback: () => void) => ViewTransitionLike;
};

/** 浏览器是否支持 View Transitions（Chrome / Android WebView 支持）。 */
export function supportsViewTransitions(): boolean {
  if (typeof document === 'undefined') return false;
  return typeof (document as ViewTransitionCapableDocument).startViewTransition === 'function';
}

/** 给元素临时加 view-transition-name（inline style，转场后清掉）。 */
function nameSurface(el: HTMLElement | null): void {
  if (el === null) return;
  el.style.setProperty('view-transition-name', SURFACE_NAME);
}

/** 清掉临时命名；同时清掉降级类，避免影响下一次。 */
function clearSurface(el: HTMLElement | null): void {
  if (el === null) return;
  el.style.removeProperty('view-transition-name');
}

export interface PageTransitionOptions {
  /** 生效强度（已含系统 reduce 降级）。 */
  readonly level: MotionLevel;
  readonly direction: 'forward' | 'back';
  /** 旧快照里要参与共享矩形的元素（来源封面 / 阅读页根）。 */
  readonly oldSurface?: HTMLElement | null;
  /** 更新完成后返回新快照里要参与共享矩形的元素。 */
  readonly newSurface?: () => HTMLElement | null;
  /** 更新完成后返回新挂载的页面根节点（降级动画用）。 */
  readonly mountedElement?: () => HTMLElement | null;
  /** 真正改状态（dispatch），宿主会在 store 订阅里同步挂载新页面。 */
  readonly update: () => void;
}

/** 正在跑 View Transition 时不再叠加（直接更新，避免转场互相打断）。 */
let transitioning = false;

/** 在整页转场里执行一次状态更新。 */
export function runPageTransition(options: PageTransitionOptions): void {
  const vt = supportsViewTransitions() && allowsViewTransition(options.level, true) && !transitioning;

  if (!vt) {
    options.update();
    const el = options.mountedElement?.() ?? null;
    const cls = pageEnterClass(options.direction, options.level);
    if (el !== null && cls !== null) {
      // 重启动画：先移除再加回（同一次会话里可能连续转场）
      el.classList.remove('page-enter--forward', 'page-enter--back');
      // 读一次布局强制回流，确保动画从头开始
      void el.offsetWidth;
      el.classList.add(cls);
      const ms = pageDuration(options.level);
      window.setTimeout(() => {
        el.classList.remove(cls);
      }, ms + 60);
    }
    return;
  }

  const doc = document as ViewTransitionCapableDocument;
  const root = document.documentElement;
  const oldSurface = options.oldSurface ?? null;
  let newSurfaceEl: HTMLElement | null = null;

  nameSurface(oldSurface);
  root.setAttribute('data-vt-dir', options.direction);
  transitioning = true;

  const transition = doc.startViewTransition?.(() => {
    options.update();
    // 回调里 DOM 已经换成新页面，这时给新快照里的元素命名才会被捕获
    newSurfaceEl = options.newSurface?.() ?? null;
    nameSurface(newSurfaceEl);
  });

  const finish = (): void => {
    transitioning = false;
    root.removeAttribute('data-vt-dir');
    clearSurface(oldSurface);
    clearSurface(newSurfaceEl);
  };

  if (transition === undefined) {
    finish();
    return;
  }
  void transition.finished.then(finish, finish);
}

/** 一次不带共享矩形的整页交叉淡入（切 tab / 主题切换兜底用）。 */
export function runCrossfade(level: MotionLevel, update: () => void): void {
  const canVt = supportsViewTransitions() && allowsViewTransition(level, true) && !transitioning;
  if (!canVt) {
    update();
    return;
  }
  const doc = document as ViewTransitionCapableDocument;
  transitioning = true;
  const transition = doc.startViewTransition?.(update);
  const finish = (): void => {
    transitioning = false;
  };
  if (transition === undefined) {
    finish();
    return;
  }
  void transition.finished.then(finish, finish);
}

/**
 * 主题切换：从点击位置圆形扩散（任务书 §4.2）。
 * 只对 `::view-transition-new(root)` 做 clip-path 动画（motion.css），
 * 原点与半径通过 CSS 变量传入。
 */
export function runThemeReveal(
  level: MotionLevel,
  origin: { x: number; y: number } | null,
  update: () => void,
): void {
  const root = document.documentElement;
  if (!supportsViewTransitions() || !allowsViewTransition(level, true) || origin === null) {
    // 降级：无扩散；full/simple 都只做一次很短的整页淡入（off 由总闸归零）
    update();
    if (pageEnterClass('forward', level) !== null) {
      document.body.classList.remove('theme-crossfade');
      void document.body.offsetWidth;
      document.body.classList.add('theme-crossfade');
      window.setTimeout(() => document.body.classList.remove('theme-crossfade'), pageDuration(level) + 60);
    }
    return;
  }

  const x = Math.round(origin.x);
  const y = Math.round(origin.y);
  const radius = Math.ceil(
    Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y)),
  );
  root.style.setProperty('--vt-x', `${x}px`);
  root.style.setProperty('--vt-y', `${y}px`);
  root.style.setProperty('--vt-r', `${radius}px`);
  root.setAttribute('data-theme-reveal', '1');

  const doc = document as ViewTransitionCapableDocument;
  const transition = doc.startViewTransition?.(update);
  const finish = (): void => {
    root.removeAttribute('data-theme-reveal');
    root.style.removeProperty('--vt-x');
    root.style.removeProperty('--vt-y');
    root.style.removeProperty('--vt-r');
  };
  if (transition === undefined) {
    finish();
    return;
  }
  void transition.finished.then(finish, finish);
}
