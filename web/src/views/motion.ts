/**
 * View Transitions 只剩「主题切换的圆形扩散」一条用途（rc.3 A 项）。
 *
 * 书架 ⇄ 阅读页已改为遮罩展开（views/page-mask.ts），
 * 整条页面转场链路不再出现 view-transition-name / startViewTransition。
 */

import { allowsViewTransition, type MotionLevel } from '../core/motion';

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
    // 降级：无扩散；非「关」档只做一次很短的整页淡入（off 由总闸归零）
    update();
    if (level !== 'off') {
      document.body.classList.remove('theme-crossfade');
      void document.body.offsetWidth;
      document.body.classList.add('theme-crossfade');
      window.setTimeout(() => document.body.classList.remove('theme-crossfade'), 260);
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
