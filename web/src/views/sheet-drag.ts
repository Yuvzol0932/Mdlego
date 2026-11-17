/**
 * Bottom sheet 下拉关闭（阶段 D3）。
 *
 * 任务书 §4.2：Bottom sheet 底部滑入，支持下拉手势关闭，松手按速度吸附。
 * 只动画 transform / opacity：
 *   - 跟手：面板 translateY(dy)，遮罩 opacity 随 dy 衰减
 *   - 松手：dy > 96px 或速度 > 0.55px/ms → 继续滑出并调用 onDismiss
 *           否则 spring 回位
 *
 * 只在「动效：完整」档挂手势；simple/off 仍可用遮罩/关闭按钮关闭。
 * 抓取区域是面板把手（或面板头部），内容滚动区不拦截。
 */

export interface SheetDragOptions {
  readonly panel: HTMLElement;
  readonly scrim: HTMLElement | null;
  /** 抓取区域（把手/标题栏）；null 表示不启用。 */
  readonly handle: HTMLElement | null;
  /** 是否启用（由 main 根据动效强度决定）。 */
  readonly enabled: boolean;
  /** 松手吸附动画时长（ms），由 core/motion 的 sheetDuration 提供。 */
  readonly durationMs: number;
  readonly onDismiss: () => void;
}

export interface SheetDragControl {
  destroy(): void;
}

/** 触发关闭的位移阈值（px）。 */
export const DISMISS_DISTANCE = 96;
/** 触发关闭的速度阈值（px/ms，向下为正）。 */
export const DISMISS_VELOCITY = 0.55;
/** 跟手位移上限（px），超过后加阻尼，避免把面板拖出屏幕太多。 */
const MAX_DRAG = 320;

export function enableSheetDrag(options: SheetDragOptions): SheetDragControl {
  const noop: SheetDragControl = { destroy: () => undefined };
  if (!options.enabled || options.handle === null) return noop;

  const { panel, scrim, handle, durationMs, onDismiss } = options;
  let startY = 0;
  let startAt = 0;
  let dy = 0;
  let active = false;
  let finished = false;

  const clearInline = (): void => {
    panel.style.removeProperty('transform');
    panel.style.removeProperty('transition');
    panel.removeAttribute('data-dragging');
    if (scrim !== null) scrim.style.removeProperty('opacity');
  };

  const onDown = (event: PointerEvent): void => {
    if (event.button !== undefined && event.button !== 0) return;
    active = true;
    startY = event.clientY;
    // 用 Date.now() 而不是 performance.now()：便于单测用假时钟精确控制手势时长
    startAt = Date.now();
    dy = 0;
    handle.setPointerCapture?.(event.pointerId);
  };

  const onMove = (event: PointerEvent): void => {
    if (!active) return;
    const raw = event.clientY - startY;
    // 只允许向下拖；向上给一点阻尼但不真的把面板顶上去
    dy = raw <= 0 ? Math.max(-16, raw * 0.25) : Math.min(MAX_DRAG, raw);
    if (dy > 4) panel.setAttribute('data-dragging', '1');
    panel.style.setProperty('transform', `translateY(${Math.max(0, dy)}px)`);
    if (scrim !== null) {
      scrim.style.setProperty('opacity', String(Math.max(0, 1 - Math.max(0, dy) / 320)));
    }
  };

  const finish = (dismiss: boolean): void => {
    if (finished) return;
    finished = true;
    active = false;
    const ms = Math.max(0, durationMs);
    if (dismiss) {
      panel.style.setProperty(
        'transition',
        `transform ${ms}ms var(--ease-accel), opacity ${ms}ms var(--ease-accel)`,
      );
      panel.style.setProperty('transform', 'translateY(110%)');
      panel.style.setProperty('opacity', '0');
      if (scrim !== null) {
        scrim.style.setProperty('transition', `opacity ${ms}ms var(--ease-accel)`);
        scrim.style.setProperty('opacity', '0');
      }
      window.setTimeout(() => {
        onDismiss();
        clearInline();
        finished = false;
      }, ms + 20);
      return;
    }
    // 回弹：spring 回到原位，动画结束后清掉 inline，避免下次打开带着旧值
    panel.style.setProperty('transition', `transform ${ms}ms var(--ease-spring)`);
    panel.style.setProperty('transform', 'translateY(0px)');
    if (scrim !== null) {
      scrim.style.setProperty('transition', `opacity ${ms}ms var(--ease-standard)`);
      scrim.style.setProperty('opacity', '1');
    }
    window.setTimeout(() => {
      clearInline();
      finished = false;
    }, ms + 20);
  };

  const onUp = (): void => {
    if (!active) return;
    const elapsed = Math.max(1, Date.now() - startAt);
    const velocity = dy / elapsed;
    finish(dy > DISMISS_DISTANCE || velocity > DISMISS_VELOCITY);
  };

  const onCancel = (): void => {
    if (!active) return;
    finish(false);
  };

  handle.addEventListener('pointerdown', onDown);
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onCancel);

  return {
    destroy() {
      handle.removeEventListener('pointerdown', onDown);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onCancel);
      clearInline();
    },
  };
}
