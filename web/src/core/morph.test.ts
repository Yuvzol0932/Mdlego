/**
 * FLIP 形变几何单测（转场改造 Step 3）。
 *
 * 覆盖计划书点名的几何约束：
 *   ① 缩放严格按宽度等比（正文绝不横向拉伸 / 纵向压扁）
 *   ② 卡片态等效未缩放高度与底部裁剪量
 *   ③ 圆角反向补偿（屏幕上看到的圆角 = 卡片圆角）
 *   ④ 跟手阻尼曲线与缩窗/圆角/位移
 *   ⑤ 双层交叉溶解的关键帧
 *   ⑥ 书架景深与背景压暗
 */

import { describe, expect, it } from 'vitest';
import {
  BEHIND_SCALE_TO,
  FOLLOW_RADIUS_MAX,
  FOLLOW_SCALE_DROP,
  FOLLOW_SHIFT_MAX,
  FULL_STATE,
  MORPH,
  behindScale,
  closeFade,
  dampedProgress,
  fitToCard,
  followState,
  lerpState,
  openFade,
  scrimOpacity,
  stateForCard,
  transformOf,
  type CardRect,
  type Viewport,
} from './morph';

/** 393×873 手机视口（与真机验收一致）。 */
const VIEWPORT: Viewport = { width: 393, height: 873 };

/** 书架网格里的 3:4 封面卡片（宽度约占视口 1/3）。 */
const CARD: CardRect = { left: 24, top: 300, width: 110, height: 146.67, radius: 18 };

describe('fitToCard：等比缩放与高度收口', () => {
  it('缩放严格按宽度等比，不看高度', () => {
    const fit = fitToCard(CARD, VIEWPORT);
    expect(fit.scale).toBeCloseTo(110 / 393, 10);
  });

  it('卡片态等效未缩放宽度 = 视口宽度', () => {
    const fit = fitToCard(CARD, VIEWPORT);
    expect(fit.cardUnscaledW).toBe(VIEWPORT.width);
  });

  it('等效未缩放高度 = 卡片高 / 缩放', () => {
    const fit = fitToCard(CARD, VIEWPORT);
    expect(fit.cardUnscaledH).toBeCloseTo(CARD.height / fit.scale, 6);
    // 等比后形变壳比卡片高很多（屏幕比书封修长），底部要裁
    expect(fit.cardUnscaledH).toBeGreaterThan(CARD.height);
    expect(fit.clipBottom).toBeGreaterThan(0);
  });

  it('底部裁剪量 = 视口高 - 等效未缩放高', () => {
    const fit = fitToCard(CARD, VIEWPORT);
    expect(fit.clipBottom).toBeCloseTo(Math.max(0, VIEWPORT.height - fit.cardUnscaledH), 6);
  });

  it('圆角反向补偿：屏幕上的可见圆角等于卡片圆角', () => {
    const fit = fitToCard(CARD, VIEWPORT);
    // 可见圆角 = radius × scale
    expect(fit.cardRadius * fit.scale).toBeCloseTo(CARD.radius, 6);
  });

  it('正方形视口 + 正方形卡片：无需裁剪', () => {
    const fit = fitToCard({ left: 0, top: 0, width: 200, height: 200, radius: 10 }, { width: 400, height: 400 });
    expect(fit.scale).toBe(0.5);
    expect(fit.cardUnscaledH).toBe(400);
    expect(fit.clipBottom).toBe(0);
  });

  it('退化输入（0 宽/0 高/NaN）不产生 NaN 或 Infinity', () => {
    const fit = fitToCard(
      { left: 0, top: 0, width: 0, height: 0, radius: Number.NaN },
      { width: 0, height: 0 },
    );
    expect(Number.isFinite(fit.scale)).toBe(true);
    expect(Number.isFinite(fit.cardUnscaledH)).toBe(true);
    expect(Number.isFinite(fit.clipBottom)).toBe(true);
    expect(Number.isFinite(fit.cardRadius)).toBe(true);
    expect(fit.scale).toBeGreaterThan(0);
  });
});

describe('stateForCard / lerpState / transformOf', () => {
  it('卡片态位移取卡片左上角，缩放取宽度比', () => {
    const state = stateForCard(CARD, VIEWPORT);
    expect(state.tx).toBe(CARD.left);
    expect(state.ty).toBe(CARD.top);
    expect(state.scale).toBeCloseTo(110 / 393, 10);
    expect(state.radius).toBeGreaterThan(0);
  });

  it('全屏态是恒等变换', () => {
    expect(FULL_STATE).toEqual({ tx: 0, ty: 0, scale: 1, radius: 0 });
    expect(transformOf(FULL_STATE)).toBe('translate3d(0px, 0px, 0) scale(1)');
  });

  it('插值端点精确，中点取平均', () => {
    const from = stateForCard(CARD, VIEWPORT);
    expect(lerpState(from, FULL_STATE, 0)).toEqual(from);
    expect(lerpState(from, FULL_STATE, 1)).toEqual(FULL_STATE);
    const mid = lerpState(from, FULL_STATE, 0.5);
    expect(mid.scale).toBeCloseTo((from.scale + 1) / 2, 10);
    expect(mid.tx).toBeCloseTo(from.tx / 2, 10);
  });

  it('插值进度被夹在 0..1', () => {
    const from = stateForCard(CARD, VIEWPORT);
    expect(lerpState(from, FULL_STATE, -5)).toEqual(from);
    expect(lerpState(from, FULL_STATE, 9)).toEqual(FULL_STATE);
  });

  it('transformOf 只输出 translate3d + scale（合成属性）', () => {
    const s = transformOf({ tx: 10.456, ty: -3.2, scale: 0.2798982, radius: 0 });
    expect(s).toBe('translate3d(10.46px, -3.2px, 0) scale(0.2799)');
    // 不得出现 width/height/top/left 之类触发布局的属性
    expect(s).not.toMatch(/width|height|margin|padding/);
  });

  it('transformOf 对 0 缩放兜底，避免出现 scale(0) 丢失可见性', () => {
    expect(transformOf({ tx: 0, ty: 0, scale: 0, radius: 0 })).toContain('scale(0.0001)');
  });
});

describe('dampedProgress：跟手阻尼曲线', () => {
  it('端点精确：0→0，1→1', () => {
    expect(dampedProgress(0)).toBe(0);
    expect(dampedProgress(1)).toBe(1);
  });

  it('平方缓出：中途大于线性（起步跟手更贴）', () => {
    expect(dampedProgress(0.5)).toBeCloseTo(0.75, 10);
    expect(dampedProgress(0.5)).toBeGreaterThan(0.5);
  });

  it('单调递增且被夹在 0..1', () => {
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const v = dampedProgress(i / 20);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
    expect(dampedProgress(-3)).toBe(0);
    expect(dampedProgress(3)).toBe(1);
  });
});

describe('followState：预测式返回跟手缩窗', () => {
  it('progress=0：完全全屏（无缩放、无圆角、无位移）', () => {
    const s = followState(0, 0, 500, 500, VIEWPORT);
    expect(s.scale).toBe(1);
    expect(s.radius).toBe(0);
    // 缩放补偿与位移在 d=0 时都应为 0
    expect(s.tx).toBe(0);
    expect(s.ty).toBe(0);
  });

  it('progress=1：缩到 1-0.15，圆角 24，横向偏移 32（左缘向右拉）', () => {
    const s = followState(1, 0, 500, 500, VIEWPORT);
    expect(s.scale).toBeCloseTo(1 - FOLLOW_SCALE_DROP, 10);
    expect(s.radius).toBeCloseTo(FOLLOW_RADIUS_MAX, 10);
    const centerX = (1 - s.scale) * (VIEWPORT.width / 2);
    expect(s.tx).toBeCloseTo(centerX + FOLLOW_SHIFT_MAX, 6);
  });

  it('右边缘向左拉 → 横向偏移反向', () => {
    const left = followState(1, 0, 500, 500, VIEWPORT);
    const right = followState(1, 1, 500, 500, VIEWPORT);
    const centerX = (1 - left.scale) * (VIEWPORT.width / 2);
    expect(right.tx).toBeCloseTo(centerX - FOLLOW_SHIFT_MAX, 6);
    expect(right.tx).toBeLessThan(left.tx);
  });

  it('无方向（edge 非 0/1）→ 只保留缩放居中补偿', () => {
    const s = followState(1, 2, 500, 500, VIEWPORT);
    expect(s.tx).toBeCloseTo((1 - s.scale) * (VIEWPORT.width / 2), 6);
  });

  it('纵向跟随手指，衰减为 0.15', () => {
    const s = followState(1, 0, 600, 500, VIEWPORT);
    const centerY = (1 - s.scale) * (VIEWPORT.height / 2);
    expect(s.ty).toBeCloseTo(centerY + 100 * 0.15, 6);
  });

  it('缩放恒在 0.85..1 区间（不会缩没）', () => {
    for (let i = 0; i <= 20; i++) {
      const s = followState(i / 20, 0, 500, 500, VIEWPORT);
      expect(s.scale).toBeGreaterThanOrEqual(1 - FOLLOW_SCALE_DROP - 1e-9);
      expect(s.scale).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});

describe('双层交叉溶解', () => {
  it('打开：封面 0→0.36 淡出，阅读层 0→0.42 从 0.15 升起', () => {
    const at0 = openFade(0);
    expect(at0.coverOpacity).toBe(1);
    expect(at0.readerOpacity).toBeCloseTo(0.15, 10);

    const atEnd = openFade(1);
    expect(atEnd.coverOpacity).toBe(0);
    expect(atEnd.readerOpacity).toBe(1);

    // 封面在 0.36 处已经彻底消失
    expect(openFade(0.36).coverOpacity).toBeCloseTo(0, 10);
    // 阅读层在 0.42 处已完全不透明
    expect(openFade(0.42).readerOpacity).toBeCloseTo(1, 10);
  });

  it('关闭：阅读层 0→0.38 淡出，封面 0.10→0.48 升起', () => {
    expect(closeFade(0).readerOpacity).toBe(1);
    // 关闭起始时封面还是透明的（不能一上来就是书封）
    expect(closeFade(0).coverOpacity).toBe(0);
    expect(closeFade(0.38).readerOpacity).toBeCloseTo(0, 10);
    expect(closeFade(0.48).coverOpacity).toBeCloseTo(1, 10);
    expect(closeFade(1).coverOpacity).toBe(1);
    expect(closeFade(1).readerOpacity).toBe(0);
  });

  it('两个方向的透明度都恒在 0..1', () => {
    for (let i = 0; i <= 20; i++) {
      const p = i / 20;
      for (const f of [openFade(p), closeFade(p)]) {
        expect(f.coverOpacity).toBeGreaterThanOrEqual(0);
        expect(f.coverOpacity).toBeLessThanOrEqual(1);
        expect(f.readerOpacity).toBeGreaterThanOrEqual(0);
        expect(f.readerOpacity).toBeLessThanOrEqual(1);
      }
    }
  });

  it('关闭时封面晚于阅读层启动（消灭结尾白底黑字硬切）', () => {
    // 进度 0.05 时阅读层已开始淡出，封面还完全没开始
    expect(closeFade(0.05).readerOpacity).toBeLessThan(1);
    expect(closeFade(0.05).coverOpacity).toBe(0);
  });
});

describe('书架景深与背景压暗', () => {
  it('打开：书架 1 → 0.95 微缩下沉', () => {
    expect(behindScale(0, true)).toBe(1);
    expect(behindScale(1, true)).toBeCloseTo(BEHIND_SCALE_TO, 10);
    expect(behindScale(0.5, true)).toBeCloseTo((1 + BEHIND_SCALE_TO) / 2, 10);
  });

  it('关闭：书架 0.95 → 1 浮起恢复', () => {
    expect(behindScale(0, false)).toBeCloseTo(BEHIND_SCALE_TO, 10);
    expect(behindScale(1, false)).toBe(1);
  });

  it('背景压暗层：打开 0→1，关闭 1→0', () => {
    expect(scrimOpacity(0, true)).toBe(0);
    expect(scrimOpacity(1, true)).toBe(1);
    expect(scrimOpacity(0, false)).toBe(1);
    expect(scrimOpacity(1, false)).toBe(0);
  });
});

describe('时长常量与计划书一致', () => {
  it('打开 380–420ms，关闭 420–450ms', () => {
    expect(MORPH.openMs).toBeGreaterThanOrEqual(380);
    expect(MORPH.openMs).toBeLessThanOrEqual(420);
    expect(MORPH.closeMs).toBeGreaterThanOrEqual(420);
    expect(MORPH.closeMs).toBeLessThanOrEqual(450);
  });
});
