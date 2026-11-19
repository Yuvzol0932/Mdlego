/**
 * FLIP 几何：卡片态必须裁成**封面的宽高比**（1.2.1 #B）。
 *
 * ## 问题
 *
 * 形变壳是全屏尺寸（vw × vh），卡片态只是把它等比缩小到卡片宽度：
 * `scale = cardWidth / viewportWidth`。
 *
 * 但手机屏幕比书封（3:4）修长得多，等比缩小之后形变壳的视觉高度是
 * `cardWidth × (viewportHeight / viewportWidth)`，大约 2.2 倍封面高。
 *
 * v1.2.0 虽然算出了 `clipBottom`（该裁掉多少），却只把它当**布尔**用：
 *
 * ```ts
 * stage.style.clipPath = fit.clipBottom > 0 ? 'inset(0px 0px 0px 0px)' : 'none';
 * //                                        ↑ 这是零裁剪
 * ```
 *
 * 结果卡片态是一个「又高又窄的紫色圆角矩形」，比封面高出一倍多，
 * 压在书架上盖住卡片标题和邻居卡片 —— 作者截图里的「屏幕比例大矩形」。
 *
 * ## 断言的两件事
 *
 * 1. **卡片态端点**的可见区域严格等于封面矩形（宽、高、宽高比）；
 * 2. **全屏态端点**不裁剪、无圆角。
 *
 * 中间帧由浏览器在两端之间线性插值，宽高比从封面比过渡到屏幕比 ——
 * 那是「窗口从书封展开」应有的形变过程，不是缺陷，所以这里不断言中间帧。
 */

import { describe, expect, it } from 'vitest';
import { clipPathForScale, fitToCard, type CardRect, type Viewport } from './morph';

/** 书架里一张 3:4 的封面（典型值：宽 118、高 157、圆角 18）。 */
const CARD: CardRect = { left: 32, top: 526, width: 118, height: 157, radius: 18 };
/** 手机视口（高宽比约 2.22，比 3:4 修长得多）。 */
const VIEWPORT: Viewport = { width: 393, height: 873 };

/** 从 `inset(t r b l round R)` 里取出底部裁剪量与圆角。 */
function parse(clip: string): { bottom: number; radius: number } {
  const m = /inset\(0px 0px ([-\d.]+)px 0px round ([-\d.]+)px\)/.exec(clip);
  return { bottom: Number(m?.[1] ?? NaN), radius: Number(m?.[2] ?? NaN) };
}

/** 卡片态端点（collapsed）的可见区域（视觉坐标）。 */
function visibleAtCard(fit: ReturnType<typeof fitToCard>, vh: number) {
  const { bottom } = parse(clipPathForScale(fit, fit.scale, vh, true));
  return {
    width: VIEWPORT.width * fit.scale,
    height: (vh - bottom) * fit.scale,
    ratio: (VIEWPORT.width * fit.scale) / ((vh - bottom) * fit.scale),
    bottom,
  };
}

describe('fitToCard：卡片态的裁剪量', () => {
  it('形变壳等比缩小后比封面高，必须裁掉底部', () => {
    const fit = fitToCard(CARD, VIEWPORT);
    expect(fit.scale).toBeCloseTo(118 / 393, 10);
    expect(fit.cardUnscaledH).toBeCloseTo(157 / (118 / 393), 6);
    expect(fit.clipBottom).toBeGreaterThan(0);
    expect(fit.clipBottom).toBeCloseTo(873 - 157 / (118 / 393), 6);
  });

  it('裁剪量确实等于「屏幕高 − 未缩放封面高」', () => {
    const fit = fitToCard(CARD, VIEWPORT);
    expect(fit.clipBottom).toBeCloseTo(VIEWPORT.height - fit.cardUnscaledH, 6);
  });
});

describe('clipPathForScale：卡片态端点 = 封面矩形', () => {
  const fit = fitToCard(CARD, VIEWPORT);

  it('卡片态可见宽 = 封面宽', () => {
    const v = visibleAtCard(fit, VIEWPORT.height);
    expect(v.width).toBeCloseTo(CARD.width, 4);
  });

  it('卡片态可见高 = 封面高', () => {
    const v = visibleAtCard(fit, VIEWPORT.height);
    expect(Math.abs(v.height - CARD.height)).toBeLessThan(0.01);
  });

  it('卡片态宽高比 = 封面宽高比（≤0.1%）', () => {
    const v = visibleAtCard(fit, VIEWPORT.height);
    const err = Math.abs(v.ratio - CARD.width / CARD.height) / (CARD.width / CARD.height);
    expect(err).toBeLessThanOrEqual(0.001);
  });

  it('卡片态真的裁了底部（不是 v1.2.0 的零裁剪）', () => {
    const clip = clipPathForScale(fit, fit.scale, VIEWPORT.height, true);
    expect(clip).not.toBe('inset(0px 0px 0px 0px round 0px)');
    expect(parse(clip).bottom).toBeGreaterThan(1);
  });

  it('卡片态圆角做反向补偿：视觉圆角 = 卡片圆角', () => {
    const { radius } = parse(clipPathForScale(fit, fit.scale, VIEWPORT.height, true));
    // 布局半径 × scale = 视觉半径，应恒等于 cardR
    expect(Math.abs(radius * fit.scale - CARD.radius)).toBeLessThan(0.01);
  });
});

describe('clipPathForScale：全屏态端点 = 整屏', () => {
  const fit = fitToCard(CARD, VIEWPORT);

  it('全屏态不裁剪、无圆角', () => {
    expect(clipPathForScale(fit, 1, VIEWPORT.height, false)).toBe('inset(0px 0px 0px 0px round 0px)');
  });
});

describe('clipPathForScale：健壮性', () => {
  const fit = fitToCard(CARD, VIEWPORT);

  it('非法/越界 scale 不产生 NaN 或负裁剪', () => {
    for (const s of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0]) {
      const clip = clipPathForScale(fit, s, VIEWPORT.height, true);
      expect(clip).not.toContain('NaN');
      expect(parse(clip).bottom).toBeGreaterThanOrEqual(0);
      expect(parse(clip).radius).toBeGreaterThanOrEqual(0);
    }
  });

  it('卡片比屏幕还高时（超长卡片）不产生负裁剪', () => {
    const tall: CardRect = { left: 0, top: 0, width: 200, height: 2000, radius: 10 };
    const tfit = fitToCard(tall, VIEWPORT);
    expect(tfit.clipBottom).toBe(0);
    expect(parse(clipPathForScale(tfit, tfit.scale, VIEWPORT.height, true)).bottom).toBe(0);
  });

  it('圆角为 0 的卡片（border-radius:0 容器）不产生负数半径', () => {
    const square: CardRect = { left: 0, top: 0, width: 120, height: 160, radius: 0 };
    const sfit = fitToCard(square, VIEWPORT);
    expect(parse(clipPathForScale(sfit, sfit.scale, VIEWPORT.height, true)).radius).toBe(0);
  });
});
