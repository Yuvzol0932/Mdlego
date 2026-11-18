/**
 * 预测式返回（predictive back）的状态决策 —— 纯函数，无 DOM 依赖。
 *
 * Android 14+ 的系统侧滑手势由原生层通过 `window.__mdlegoBackGesture` 逐帧送来：
 *   ("start" | "move" | "commit" | "cancel", progress, touchX, touchY, swipeEdge)
 *
 * 这里只回答两个问题（可单测）：
 *   1. 这一次手势提交（commit）时，应该关闭**哪一层**？
 *      优先级：最顶层浮层（查词卡 / 目录抽屉 / 图片查看器 / 弹窗）
 *              → 阅读页本身（退回书架） → 再往下交给系统（退回桌面）。
 *   2. 当前路由栈深度下，原生侧是否应该开启拦截？
 *      书架根页面且没有任何浮层时**必须关闭拦截**，否则会废掉系统
 *      「缩回桌面图标」的原生动画。
 */

/** 当前可退的层级快照（由 main 从 store 里读出来）。 */
export interface BackStack {
  /** 当前页面栈深度（1 = 只有根页面）。 */
  readonly pageDepth: number;
  /** 已打开的子浮层数量（查词卡 / 抽屉 / 菜单 / 弹窗）。 */
  readonly layerDepth: number;
  /** 栈顶页面是不是阅读页。 */
  readonly topIsReader: boolean;
}

/** 一次 commit 该做什么。 */
export type BackAction =
  /** 关闭最顶层子浮层（阅读页保持原样）。 */
  | { readonly kind: 'close-layer' }
  /** 退回书架（从阅读页出发，播放 FLIP close 转场）。 */
  | { readonly kind: 'close-reader' }
  /** 还有其他页面可退（设置页/搜索页等），走普通页面返回。 */
  | { readonly kind: 'pop-page' }
  /** 栈已到底：交给系统处理（退回桌面）。 */
  | { readonly kind: 'system' };

/**
 * 决定一次 commit 的动作。
 *
 * `progress` 只用于跟手动画，不参与层级决策 —— 层级只看栈，不看手指拉了多少，
 * 否则会出现「拉一半松手关掉了不该关的层」。
 */
export function decideBackAction(stack: BackStack): BackAction {
  if (stack.layerDepth > 0) return { kind: 'close-layer' };
  if (stack.topIsReader) return { kind: 'close-reader' };
  if (stack.pageDepth > 1) return { kind: 'pop-page' };
  return { kind: 'system' };
}

/**
 * 是否需要开启原生返回拦截。
 *
 * 铁律（计划书 §Step 4-2）：书架根页面且没有任何浮层时**绝不能**注册回调，
 * 否则系统会认为应用要自己消费返回，从而废掉「缩回桌面图标」的原生动画。
 */
export function shouldInterceptBack(stack: BackStack): boolean {
  // 注意：不能用 `decideBackAction(stack) !== { kind: 'system' }` 比较 ——
  // 对象字面量每次都是新引用，那样写会永远为 true，直接废掉系统返回动画。
  return decideBackAction(stack).kind !== 'system';
}

/**
 * 是否处于「纯净阅读页态」（可以跟手缩放整张阅读页）。
 *
 * 只有在阅读页且**没有任何子浮层**时才允许缩窗；
 * 有查词卡 / 目录抽屉时只能关浮层，不能把整张阅读页一起缩。
 */
export function canFollowMorph(stack: BackStack): boolean {
  return stack.layerDepth === 0 && stack.topIsReader;
}

/**
 * 原生预测式返回桥接是否可用（由 data/native.ts 在探测后写入）。
 *
 * 放在 core 层是因为两边都要读它：data/native.ts 负责探测与写入，
 * views/back-gesture.ts 与 views/edge-back.ts 负责据此让位。
 * data 不得反向依赖 views（check:boundaries 守着），所以状态必须落在 core。
 */
let nativeBridgeAvailable = false;

/** 声明原生桥接是否可用。 */
export function setNativeBackBridge(available: boolean): void {
  nativeBridgeAvailable = available;
}

/** 原生预测式返回是否已激活（Web 侧边缘手势据此自行禁用）。 */
export function isNativeBackActive(): boolean {
  return nativeBridgeAvailable;
}

/** 测试用：重置桥接状态。 */
export function resetNativeBackBridge(): void {
  nativeBridgeAvailable = false;
}

/** 一次手势的生命周期阶段。 */
export type BackPhase = 'start' | 'move' | 'commit' | 'cancel';

/** 把原生送来的字符串规整成已知阶段；未知值返回 null（忽略，不抛错）。 */
export function normalizePhase(raw: unknown): BackPhase | null {
  if (raw === 'start' || raw === 'move' || raw === 'commit' || raw === 'cancel') return raw;
  return null;
}

/** 把原生送来的进度规整到 0..1；非法值归零。 */
export function normalizeProgress(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * 跟手松手后的回弹/落地判定。
 *
 * 系统已经把「是否提交」判好了（commit / cancel 两个阶段），
 * 这里只给出回弹时长：取消时短回弹，提交时走完整关闭动画。
 */
export function settleDurationMs(phase: BackPhase): number {
  return phase === 'cancel' ? 200 : 0;
}
