/**
 * 书架 ⇄ 阅读页的 FLIP 形变几何（转场改造 Step 3）—— 纯函数，无 DOM 依赖。
 *
 * 设计参考小米澎湃 OS 的系统应用收放动效：
 *   - 用「位移 + 等比缩放 + 双层交叉溶解 + 背景呼吸」替代原来的纯 clip-path；
 *   - 缩放严格按**宽度**等比（`scale = cardWidth / vw`），
 *     绝不让正文横向拉伸或纵向压扁；
 *   - 手机屏幕比书封更修长，等比缩放后形变壳的等效未缩放高度
 *     `cardUnscaledH = cardHeight / scale` 通常大于卡片高度，
 *     所以卡片态要对超出部分做裁剪，并动态补偿圆角（`radius / scale`）。
 *
 * 这里只算数值。谁去写 CSS、用哪种动画由调用方决定，
 * 因此本模块可以完全在 node 环境里单测。
 */

/** 视口尺寸。 */
export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** 卡片矩形（视口坐标）。 */
export interface CardRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** 卡片圆角半径（px）。 */
  readonly radius: number;
}

/** 形变壳在某一时刻的几何状态。 */
export interface MorphState {
  /** translate3d 的 X（px）。 */
  readonly tx: number;
  /** translate3d 的 Y（px）。 */
  readonly ty: number;
  /** 等比缩放系数。 */
  readonly scale: number;
  /** 形变壳圆角（px，已按 scale 反向补偿）。 */
  readonly radius: number;
}

/** 形变壳在卡片态下的等效「未缩放」尺寸与裁剪信息。 */
export interface CardFit {
  /** 卡片态缩放系数（= cardWidth / viewportWidth）。 */
  readonly scale: number;
  /** 等比缩放后形变壳的等效未缩放高度（= cardHeight / scale）。 */
  readonly cardUnscaledH: number;
  /** 卡片态等效未缩放宽度（= viewportWidth）。 */
  readonly cardUnscaledW: number;
  /** 卡片态需要裁掉的底部高度（px，未缩放坐标系）；0 表示不需要裁。 */
  readonly clipBottom: number;
  /** 卡片态圆角（px，未缩放坐标系；= cardRadius / scale）。 */
  readonly cardRadius: number;
}

/** 全屏态：形变壳铺满视口、无位移、无缩放。 */
export const FULL_STATE: MorphState = { tx: 0, ty: 0, scale: 1, radius: 0 };

const finite = (n: number, fallback = 0): number => (Number.isFinite(n) ? n : fallback);

/**
 * 计算卡片态（收拢终点 / 展开起点）的形变参数。
 *
 * @param card 书架里目标卡片的矩形
 * @param viewport 视口尺寸
 * @param fullHeight 形变壳在全屏态的高度（通常 = viewport.height）
 */
export function fitToCard(card: CardRect, viewport: Viewport, fullHeight = viewport.height): CardFit {
  const vw = Math.max(1, finite(viewport.width, 1));
  const vh = Math.max(1, finite(fullHeight, 1));
  const cardW = Math.max(1, finite(card.width, 1));
  const cardH = Math.max(1, finite(card.height, 1));
  const cardR = Math.max(0, finite(card.radius, 0));

  // 严格按宽度等比：正文既不会被横向拉伸，也不会被纵向压扁
  const scale = cardW / vw;
  // 等比缩放后，形变壳「未缩放」状态下要占的高度
  const cardUnscaledH = cardH / scale;
  // 手机屏幕比书封修长 → 形变壳比卡片高，底部多出来的部分要裁掉
  const clipBottom = Math.max(0, vh - cardUnscaledH);
  // 圆角同样要反向补偿：屏幕上看到的圆角 = radius * scale = cardR
  const cardRadius = cardR / scale;

  return {
    scale,
    cardUnscaledH,
    cardUnscaledW: vw,
    clipBottom,
    cardRadius,
  };
}

/** 卡片态 → 形变状态（位移取卡片左上角）。 */
export function stateForCard(card: CardRect, viewport: Viewport): MorphState {
  const fit = fitToCard(card, viewport);
  return {
    tx: finite(card.left, 0),
    ty: finite(card.top, 0),
    scale: fit.scale,
    radius: fit.cardRadius,
  };
}

/** 两个状态之间按进度插值（0 = from，1 = to）。 */
export function lerpState(from: MorphState, to: MorphState, progress: number): MorphState {
  const p = Math.max(0, Math.min(1, finite(progress, 0)));
  return {
    tx: from.tx + (to.tx - from.tx) * p,
    ty: from.ty + (to.ty - from.ty) * p,
    scale: from.scale + (to.scale - from.scale) * p,
    radius: from.radius + (to.radius - from.radius) * p,
  };
}

/** 形变状态 → CSS transform 字符串（只写合成属性）。 */
export function transformOf(state: MorphState): string {
  const tx = Math.round(finite(state.tx, 0) * 100) / 100;
  const ty = Math.round(finite(state.ty, 0) * 100) / 100;
  const scale = Math.round(Math.max(0.0001, finite(state.scale, 1)) * 10000) / 10000;
  return `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
}

/**
 * 跟手阻尼曲线：`damped = 1 - (1 - progress)^2`。
 *
 * 手指刚拉动时形变要「跟得上」，越接近满程越钝 —— 平方缓出正好如此，
 * 且 progress=0 → 0、progress=1 → 1，端点精确。
 */
export function dampedProgress(progress: number): number {
  const p = Math.max(0, Math.min(1, finite(progress, 0)));
  return 1 - Math.pow(1 - p, 2);
}

/** 跟手时形变壳的最大缩放缩小量（拉满时缩到 0.85）。 */
export const FOLLOW_SCALE_DROP = 0.15;
/** 跟手时形变壳的最大圆角（px）。 */
export const FOLLOW_RADIUS_MAX = 24;
/** 跟手时的最大水平阻尼偏移（px）。 */
export const FOLLOW_SHIFT_MAX = 32;
/** 纵向手指跟随的衰减系数。 */
export const FOLLOW_Y_RATIO = 0.15;

/**
 * 跟手态形变参数（Android 预测式返回 / 边缘手势实时驱动）。
 *
 * @param progress 系统给的原始进度 0..1
 * @param swipeEdge 0 = 左边缘向右拉，1 = 右边缘向左拉，其余视为无方向
 * @param touchY 当前手指 Y（视口坐标）
 * @param startY 手势起点 Y（视口坐标）
 * @param viewport 视口尺寸（用于围绕视口中心做缩放居中补偿）
 */
export function followState(
  progress: number,
  swipeEdge: number,
  touchY: number,
  startY: number,
  viewport: Viewport,
): MorphState {
  const d = dampedProgress(progress);
  const scale = 1 - FOLLOW_SCALE_DROP * d;
  const radius = FOLLOW_RADIUS_MAX * d;

  // 水平方向：左边缘向右拉 → 正向偏移；右边缘向左拉 → 负向偏移
  const dir = swipeEdge === 0 ? 1 : swipeEdge === 1 ? -1 : 0;
  const shiftX = dir * FOLLOW_SHIFT_MAX * d;

  // 缩放围绕视口中心：形变壳以左上角为 transform-origin，
  // 缩放后要保持视觉居中，需要补 (1 - scale) 的一半视口尺寸
  const centerX = (1 - scale) * (finite(viewport.width, 0) / 2);
  const centerY = (1 - scale) * (finite(viewport.height, 0) / 2);

  // 纵向轻微跟手
  const dy = (finite(touchY, 0) - finite(startY, 0)) * FOLLOW_Y_RATIO;

  return {
    tx: centerX + shiftX,
    ty: centerY + dy,
    scale,
    radius,
  };
}

/** 交叉溶解的透明度（打开方向）。 */
export interface OpenFade {
  readonly coverOpacity: number;
  readonly readerOpacity: number;
}

/**
 * 打开方向的双层交叉溶解。
 *
 * 计划书时间轴：
 *   封面层  opacity 在进度 0 → 0.36 从 1 降至 0
 *   阅读层  opacity 在进度 0 → 0.42 从 0.15 升至 1
 */
export function openFade(progress: number): OpenFade {
  const p = Math.max(0, Math.min(1, finite(progress, 0)));
  const coverT = Math.max(0, Math.min(1, p / 0.36));
  const readerT = Math.max(0, Math.min(1, p / 0.42));
  return {
    coverOpacity: 1 - coverT,
    readerOpacity: 0.15 + (1 - 0.15) * readerT,
  };
}

/**
 * 关闭方向的双层交叉溶解。
 *
 * 计划书时间轴：
 *   阅读层 opacity 在进度 0 → 0.38 快速淡出至 0
 *   封面层 opacity 在进度 0.10 → 0.48 升至 1
 */
export function closeFade(progress: number): OpenFade {
  const p = Math.max(0, Math.min(1, finite(progress, 0)));
  const readerT = Math.max(0, Math.min(1, p / 0.38));
  const coverT = Math.max(0, Math.min(1, (p - 0.1) / (0.48 - 0.1)));
  return {
    coverOpacity: coverT,
    readerOpacity: 1 - readerT,
  };
}

/** 底层书架的景深缩放：打开时 1 → 0.95，关闭时 0.95 → 1。 */
export const BEHIND_SCALE_FROM = 1;
export const BEHIND_SCALE_TO = 0.95;

/** 底层书架缩放（按转场进度）。 */
export function behindScale(progress: number, opening: boolean): number {
  const p = Math.max(0, Math.min(1, finite(progress, 0)));
  return opening
    ? BEHIND_SCALE_FROM + (BEHIND_SCALE_TO - BEHIND_SCALE_FROM) * p
    : BEHIND_SCALE_TO + (BEHIND_SCALE_FROM - BEHIND_SCALE_TO) * p;
}

/** 背景压暗层透明度（按转场进度，两端都是 1↔0）。 */
export function scrimOpacity(progress: number, opening: boolean): number {
  const p = Math.max(0, Math.min(1, finite(progress, 0)));
  return opening ? p : 1 - p;
}

/** 转场时长常量（与计划书时间轴一致）。 */
export const MORPH = {
  /** 打开：380–420ms，弹簧减速曲线。 */
  openMs: 400,
  /** 关闭：420–450ms，长尾柔和减速。 */
  closeMs: 440,
  /** 跟手取消后的回弹时长。 */
  cancelMs: 200,
} as const;

/** 打开/关闭使用的缓动（弹簧减速）。 */
export const MORPH_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
