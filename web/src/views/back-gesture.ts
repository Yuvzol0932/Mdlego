/**
 * 预测式返回跟手缩窗控制器（转场改造 Step 4，Web 侧）。
 *
 * 原生层（MdlegoNative）在 Android 14+ 逐帧调用
 * `window.__mdlegoBackGesture(kind, progress, touchX, touchY, swipeEdge)`，
 * 这里把它翻译成对 FLIP 形变壳的实时矩阵更新。
 *
 * 三层职责边界：
 *   core/back-gesture.ts   纯决策（关哪一层、要不要拦截）—— 可单测
 *   本文件                 手势 → 形变矩阵（跟手阻尼、回弹、落地）
 *   views/page-mask.ts     实际的 FLIP 动画（复用 Step 3 的双层形变壳）
 *
 * 硬约束：
 *   - `commit` **严禁**先弹回全屏再重播关闭动画：以松手瞬间的实时矩阵
 *     作为关闭动画的起始关键帧（见 CloseMaskOptions.startMorph）。
 *   - 与 edge-back.ts 互斥：原生桥接可用时自动禁用 Web 侧左缘拦截，避免双重触发。
 */

import {
  normalizePhase,
  normalizeProgress,
  shouldInterceptBack,
  type BackStack,
} from '../core/back-gesture';
import { followState, FULL_STATE, MORPH, type MorphState } from '../core/morph';

export { isNativeBackActive, setNativeBackBridge } from '../core/back-gesture';

export interface BackGestureController {
  /** 当前是否处于跟手状态。 */
  readonly active: boolean;
  /** 松手时要交给关闭转场的实时矩阵（commit 后读取一次）。 */
  takePendingMorph(): MorphState | null;
  /** 卸载（移除全局接收器）。 */
  destroy(): void;
}

export interface BackGestureOptions {
  /** 读取当前退栈状态。 */
  readonly getStack: () => BackStack;
  /** 开始跟手：准备形变层（单帧原子准备，复用 Step 2）。 */
  readonly onStart: () => void;
  /** 跟手推进：把实时矩阵写到形变壳上。 */
  readonly onMove: (state: MorphState) => void;
  /** 取消：从当前矩阵回弹到全屏。 */
  readonly onCancel: (from: MorphState) => void;
  /** 提交：走正常退栈（main 的 deps.dispatch）。 */
  readonly onCommit: () => void;
  /** 视图尺寸（每次手势开始时读一次）。 */
  readonly viewport: () => { readonly width: number; readonly height: number };
}

/**
 * 挂载全局接收器 `window.__mdlegoBackGesture`。
 *
 * 原生层用 `bridge.eval` 逐帧调用它（不走 Capacitor 事件，避免每帧序列化
 * JSONObject 造成 GC 抖动）。函数必须对参数极其宽容：原生与 Web 可能版本
 * 不一致，任何非法输入都应该被忽略而不是抛错。
 */
export function mountBackGesture(options: BackGestureOptions): BackGestureController {
  let current: MorphState | null = null;
  let startY = 0;
  let pendingMorph: MorphState | null = null;
  let following = false;

  const reset = (): void => {
    current = null;
    following = false;
    startY = 0;
  };

  const handle = (rawKind: unknown, rawProgress: unknown, rawX: unknown, rawY: unknown, rawEdge: unknown): void => {
    const phase = normalizePhase(rawKind);
    if (phase === null) return;
    const progress = normalizeProgress(rawProgress);
    const touchY = typeof rawY === 'number' && Number.isFinite(rawY) ? rawY : 0;
    const edge = typeof rawEdge === 'number' && Number.isFinite(rawEdge) ? rawEdge : 2;

    if (phase === 'start') {
      // 只有在「可以整页缩窗」的状态才接管；有浮层时系统手势直接用于关浮层
      const stack = options.getStack();
      if (!shouldInterceptBack(stack)) {
        reset();
        return;
      }
      // 有子浮层：不缩整页，commit 时由 onCommit 关浮层
      if (stack.layerDepth > 0) {
        reset();
        return;
      }
      startY = touchY;
      following = true;
      options.onStart();
      const vp = options.viewport();
      current = followState(progress, edge, touchY, startY, vp);
      options.onMove(current);
      return;
    }

    if (!following) {
      // commit / cancel 但没 start（例如 SDK 33 只有一帧 commit）：直接走退栈
      if (phase === 'commit') {
        pendingMorph = null;
        options.onCommit();
      }
      return;
    }

    if (phase === 'move') {
      const vp = options.viewport();
      current = followState(progress, edge, touchY, startY, vp);
      options.onMove(current);
      return;
    }

    if (phase === 'cancel') {
      const from = current ?? FULL_STATE;
      following = false;
      current = null;
      options.onCancel(from);
      return;
    }

    // commit：把松手瞬间的实时矩阵交给关闭转场，严禁先弹回全屏再重播
    const from = current ?? FULL_STATE;
    following = false;
    current = null;
    pendingMorph = from;
    options.onCommit();
  };

  // 原生层通过 bridge.eval 调用这个全局函数
  const w = window as Window & {
    __mdlegoBackGesture?: (
      kind: unknown,
      progress: unknown,
      x: unknown,
      y: unknown,
      edge: unknown,
    ) => void;
  };
  const previous = w.__mdlegoBackGesture;
  w.__mdlegoBackGesture = handle;

  return {
    get active() {
      return following;
    },
    takePendingMorph(): MorphState | null {
      const value = pendingMorph;
      pendingMorph = null;
      return value;
    },
    destroy(): void {
      reset();
      pendingMorph = null;
      if (previous !== undefined) w.__mdlegoBackGesture = previous;
      else delete w.__mdlegoBackGesture;
    },
  };
}

/** 跟手取消时的回弹时长（与 core/back-gesture 的契约一致）。 */
export const MOVE_CANCEL_MS = MORPH.cancelMs;
