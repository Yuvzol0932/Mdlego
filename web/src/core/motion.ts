/**
 * 动效策略（阶段 D）—— 全应用**唯一**判定「该不该动、能动多久」的地方。
 *
 * 为什么要有这一层：
 *   任务书 §4 要求「统一写入 motion.ts + 令牌，禁止各处自写」。如果每个视图
 *   各自读 settings.motion、各自判断 reduced-motion，很快会出现「关掉动效
 *   还有两处在滑」的漏网。这里只做纯函数：输入设置与系统偏好，输出强度
 *   与时长；DOM 相关的转场封装在 views/motion.ts。
 *
 * 三个强度（与 Settings.motion 同值）：
 *   full   任务书 §4.2 的完整动效
 *   simple 只保留淡入淡出：transform 位移/缩放时长为 0
 *   off    全部时长归零，保留终态
 *
 * 系统 `prefers-reduced-motion: reduce` 一律升级为 off（无论设置选了什么）。
 */

/** 动效强度（与 `Settings.motion` 同值）。 */
export type MotionLevel = 'off' | 'simple' | 'full';

/** 时长常量（毫秒）。CSS 令牌与这里必须一致，由 motion.test.ts 交叉校验。 */
export const MOTION_DURATIONS = {
  fast: 120,
  base: 220,
  slow: 360,
  page: 420,
  /** 跳转目标块的高亮渐隐时长（任务书 §4.2：1.2s 渐隐）。 */
  highlight: 1200,
} as const;

/** 页面降级动画的位移量（任务书：不支持 View Transitions 时淡入 + 上移 12px）。 */
export const PAGE_ENTER_SHIFT_PX = 12;

/** 书架卡片错峰间隔（任务书：40ms，最多 12 张）。 */
export const CARD_STAGGER_MS = 40;
export const CARD_STAGGER_MAX = 12;

/** 计算「实际生效」的强度：系统减少动效偏好优先。 */
export function effectiveMotion(choice: MotionLevel, reduceMotion: boolean): MotionLevel {
  if (reduceMotion) return 'off';
  return choice;
}

/** full 才允许 transform 位移/缩放动画。 */
export function allowsTransform(level: MotionLevel): boolean {
  return level === 'full';
}

/** 非 off 才允许淡入淡出（含颜色过渡）。 */
export function allowsFade(level: MotionLevel): boolean {
  return level !== 'off';
}

/** 是否允许使用 View Transitions（需要浏览器支持 + full）。 */
export function allowsViewTransition(level: MotionLevel, supported: boolean): boolean {
  return level === 'full' && supported;
}

/** transform 类过渡时长（ms）。 */
export function transformDuration(level: MotionLevel): number {
  return allowsTransform(level) ? MOTION_DURATIONS.base : 0;
}

/** 淡入淡出类过渡时长（ms）。 */
export function fadeDuration(level: MotionLevel): number {
  return allowsFade(level) ? MOTION_DURATIONS.base : 0;
}

/** 整页转场时长（ms）。 */
export function pageDuration(level: MotionLevel): number {
  if (level === 'off') return 0;
  return level === 'simple' ? MOTION_DURATIONS.base : MOTION_DURATIONS.page;
}

/** Bottom sheet 滑入 / 下拉关闭时长（ms）。 */
export function sheetDuration(level: MotionLevel): number {
  if (level === 'off') return 0;
  return level === 'simple' ? MOTION_DURATIONS.base : MOTION_DURATIONS.slow;
}

/** 错峰步长（ms）；simple/off 不错峰。 */
export function staggerStep(level: MotionLevel): number {
  return level === 'full' ? CARD_STAGGER_MS : 0;
}

/** 高亮渐隐时长（ms）；off 直接不闪。 */
export function highlightDuration(level: MotionLevel): number {
  return level === 'off' ? 0 : MOTION_DURATIONS.highlight;
}

/** 页面降级进入动画的类名；off 返回 null（不加类）。 */
export function pageEnterClass(direction: 'forward' | 'back', level: MotionLevel): string | null {
  if (level === 'off') return null;
  // simple 用同一类名，具体表现（是否位移）由 CSS 的强度覆盖决定
  return direction === 'forward' ? 'page-enter--forward' : 'page-enter--back';
}
