// @vitest-environment jsdom
/**
 * 长按选词的坐标换算（1.2.1 #D）。
 *
 * ## 真机现象
 *
 * 「刚打开软件后第一次进文档，长按英文词没有任何反应；退出再进就好了。」
 *
 * ## 真机根因（两条叠加）
 *
 * 1. **转场层吃掉了命中**：`.page-mask` 是不透明全屏层且没声明
 *    `pointer-events`，转场期间 `caretRangeFromPoint()` 返回形变壳自身
 *    （`DIV`）而不是文本节点。修法见 `styles/motion.css`（声明
 *    `pointer-events: none`，内部三层本来就有）。
 *
 * 2. **视觉坐标 vs 布局坐标**：形变壳带 `transform: scale()` 时，
 *    `pointerdown` 的 clientX/Y 是视觉坐标，而 `caretRangeFromPoint()`
 *    要的是布局坐标，两者差 `1/scale` 倍。不换算就会落在错误位置。
 *
 * 本文件守第 2 条的纯函数部分。第 1 条由真机验收
 * `tools/verify-longpress-firstopen.mjs` 覆盖。
 */

import { describe, expect, it } from 'vitest';
import { toLayoutPoint } from './selection';

describe('toLayoutPoint：视觉坐标 → 布局坐标', () => {
  it('scale = 1 时原样返回', () => {
    const p = toLayoutPoint(120, 400, { scale: 1, originX: 0, originY: 0 });
    expect(p).toEqual({ x: 120, y: 400 });
  });

  it('scale = 0.5 时把视觉坐标放大一倍', () => {
    const p = toLayoutPoint(100, 200, { scale: 0.5, originX: 0, originY: 0 });
    expect(p).toEqual({ x: 200, y: 400 });
  });

  it('transform-origin 非零时按 origin + (x − origin)/scale 换算', () => {
    // origin (30,60)、scale 0.5：视觉 80 → 30 + (80−30)/0.5 = 130
    const p = toLayoutPoint(80, 160, { scale: 0.5, originX: 30, originY: 60 });
    expect(p.x).toBe(130);
    expect(p.y).toBe(260);
  });

  it('page-mask 的实际取值（origin 0 0）退化为纯缩放倒数', () => {
    // scale 0.25 → 布局坐标 = 视觉坐标 × 4
    const cases: ReadonlyArray<readonly [number, number]> = [[50, 200], [200, 800]];
    for (const [visual, expected] of cases) {
      const p = toLayoutPoint(visual, 0, { scale: 0.25, originX: 0, originY: 0 });
      expect(p.x).toBe(expected);
    }
  });

  it('scale 为 0 / 负数 / NaN 时退回原坐标（避免除零与翻转）', () => {
    for (const scale of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const p = toLayoutPoint(120, 400, { scale, originX: 0, originY: 0 });
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('极小 scale（0.01）时正常换算，不产生 Infinity', () => {
    const p = toLayoutPoint(120, 400, { scale: 0.01, originX: 0, originY: 0 });
    expect(p.x).toBe(12000);
    expect(Number.isFinite(p.y)).toBe(true);
  });
});
