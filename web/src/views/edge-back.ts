/**
 * 左缘右滑返回（阶段 D4）。
 *
 * 任务书 §4.2 最后一项：手势统一走路由栈（`nav/back`），不另开一套导航。
 *
 * 规则：
 *   - 只在「动效：完整」且当前可返回（页面栈 > 1 或有浮层）时启用；
 *   - 起点必须在屏幕左缘 24px 内；横向位移 > 纵向 1.5 倍才算手势，
 *     避免和正文纵向滚动抢；
 *   - 跟手：页根节点 translateX(dx × 0.55)，上限 120px（只动 transform）；
 *   - 松手：dx > 96px 或 vx > 0.5px/ms → 页面淡出滑走，然后调用 onBack；
 *           否则 spring 回弹；
 *   - 起点在横向滚动区（书架横幅、代码块、表格）里不启动。
 *
 * 已知限制：Android 10+ 手势导航会在系统层拦截边缘滑动，WebView 不一定收到事件；
 * 这里只做「应用内左缘滑动」的增强，不声称能替代系统返回。
 */

export interface EdgeBackOptions {
  /** 当前挂载的页面根节点（没有页面时返回 null）。 */
  readonly getPageElement: () => HTMLElement | null;
  /** 现在能不能返回（页面栈 >1 或有浮层）。 */
  readonly canGoBack: () => boolean;
  /** 是否启用（由动效强度决定）。 */
  readonly enabled: () => boolean;
  /** 提交后滑出动画时长（ms），由 core/motion 提供。 */
  readonly durationMs: () => number;
  /** 提交时执行返回（不要自己 dispatch，main 负责抑制重复转场）。 */
  readonly onBack: () => void;
}

export interface EdgeBackControl {
  destroy(): void;
}

/** 触发区宽度（px）。 */
export const EDGE_ZONE = 24;
/** 提交阈值（px）。 */
export const COMMIT_DISTANCE = 96;
/** 提交速度阈值（px/ms）。 */
export const COMMIT_VELOCITY = 0.5;
/** 跟手阻尼系数与最大位移。 */
const FOLLOW_RATIO = 0.55;
const MAX_FOLLOW = 120;

/** 手势起点落在这些容器里时不启动（它们自己要横向滚动）。 */
const SCROLL_EXCLUSIONS = '.hero__track, pre, .table-wrap, .code-wrap';
/** 表单控件上不启动，避免抢输入。 */
const CONTROL_EXCLUSIONS = 'input, textarea, select, [contenteditable="true"]';

export function enableEdgeBack(options: EdgeBackOptions): EdgeBackControl {
  const noop: EdgeBackControl = { destroy: () => undefined };
  if (typeof document === 'undefined') return noop;

  let active = false;
  let decided = false;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startAt = 0;
  let dx = 0;
  let page: HTMLElement | null = null;

  const clear = (): void => {
    if (page !== null) {
      page.style.removeProperty('transform');
      page.style.removeProperty('transition');
      page.style.removeProperty('opacity');
    }
    page = null;
    active = false;
    decided = false;
    dragging = false;
    dx = 0;
  };

  const onDown = (event: PointerEvent): void => {
    if (!options.enabled() || !options.canGoBack()) return;
    if (event.clientX > EDGE_ZONE) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target !== null && target.closest(SCROLL_EXCLUSIONS) !== null) return;
    if (target !== null && target.closest(CONTROL_EXCLUSIONS) !== null) return;
    page = options.getPageElement();
    if (page === null) return;
    active = true;
    decided = false;
    dragging = false;
    startX = event.clientX;
    startY = event.clientY;
    startAt = Date.now();
    dx = 0;
  };

  const onMove = (event: PointerEvent): void => {
    if (!active || page === null) return;
    const moveX = event.clientX - startX;
    const moveY = event.clientY - startY;
    if (!decided) {
      // 先判断方向：纵向为主就放弃这次手势，交还给滚动
      if (Math.abs(moveY) > Math.abs(moveX) && Math.abs(moveY) > 8) {
        clear();
        return;
      }
      if (moveX > 8 && moveX > Math.abs(moveY) * 1.5) decided = true;
      else return;
    }
    dragging = true;
    dx = Math.max(0, Math.min(MAX_FOLLOW, moveX * FOLLOW_RATIO));
    page.style.setProperty('transform', `translateX(${dx}px)`);
  };

  const onUp = (): void => {
    if (!active || page === null) {
      clear();
      return;
    }
    if (!dragging) {
      clear();
      return;
    }
    const current = page;
    const elapsed = Math.max(1, Date.now() - startAt);
    const velocity = dx / elapsed;
    const commit = dx > COMMIT_DISTANCE || velocity > COMMIT_VELOCITY;
    if (!commit) {
      // 回弹
      current.style.setProperty('transition', 'transform var(--motion-transform-dur) var(--ease-spring)');
      current.style.setProperty('transform', 'translateX(0px)');
      window.setTimeout(() => clear(), 260);
      active = false;
      return;
    }
    // 提交：页面淡出滑走 → 再真正返回（返回后新页面由 main 加进入动画）
    const ms = Math.max(0, options.durationMs());
    current.style.setProperty(
      'transition',
      `transform ${ms}ms var(--ease-accel), opacity ${ms}ms var(--ease-accel)`,
    );
    current.style.setProperty('transform', `translateX(${Math.round(window.innerWidth * 0.4)}px)`);
    current.style.setProperty('opacity', '0');
    const target = current;
    window.setTimeout(() => {
      // 先清样式再返回：页面即将被卸载，不清会在缓存节点上留下残影
      target.style.removeProperty('transform');
      target.style.removeProperty('opacity');
      target.style.removeProperty('transition');
      options.onBack();
    }, ms + 20);
    page = null;
    active = false;
    dragging = false;
  };

  const onCancel = (): void => {
    if (!active) return;
    clear();
  };

  document.addEventListener('pointerdown', onDown, { capture: true, passive: true });
  document.addEventListener('pointermove', onMove, { capture: true, passive: true });
  document.addEventListener('pointerup', onUp, { capture: true, passive: true });
  document.addEventListener('pointercancel', onCancel, { capture: true, passive: true });

  return {
    destroy() {
      document.removeEventListener('pointerdown', onDown, { capture: true });
      document.removeEventListener('pointermove', onMove, { capture: true });
      document.removeEventListener('pointerup', onUp, { capture: true });
      document.removeEventListener('pointercancel', onCancel, { capture: true });
      clear();
    },
  };
}
