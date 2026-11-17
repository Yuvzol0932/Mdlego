/**
 * 动效策略单测（阶段 D1）。
 *
 * 除了矩阵本身，还用 `tokens.css?raw` 交叉校验「JS 时长常量 == CSS 令牌值」：
 * 这两处天然容易漂移（改了一处忘了另一处），锁死成测试比写注释可靠。
 */

import { describe, expect, it } from 'vitest';
import tokensCss from '../styles/tokens.css?raw';
import {
  CARD_STAGGER_MAX,
  CARD_STAGGER_MS,
  MOTION_DURATIONS,
  PAGE_ENTER_SHIFT_PX,
  allowsFade,
  allowsTransform,
  allowsViewTransition,
  effectiveMotion,
  fadeDuration,
  highlightDuration,
  pageDuration,
  pageEnterClass,
  sheetDuration,
  staggerStep,
  transformDuration,
} from './motion';

describe('强度判定', () => {
  it('系统减少动效时一律降为 off（无论设置选了什么）', () => {
    expect(effectiveMotion('full', true)).toBe('off');
    expect(effectiveMotion('simple', true)).toBe('off');
    expect(effectiveMotion('off', true)).toBe('off');
  });

  it('不减少动效时沿用设置值', () => {
    expect(effectiveMotion('full', false)).toBe('full');
    expect(effectiveMotion('simple', false)).toBe('simple');
    expect(effectiveMotion('off', false)).toBe('off');
  });

  it('能力开关', () => {
    expect(allowsTransform('full')).toBe(true);
    expect(allowsTransform('simple')).toBe(false);
    expect(allowsTransform('off')).toBe(false);
    expect(allowsFade('full')).toBe(true);
    expect(allowsFade('simple')).toBe(true);
    expect(allowsFade('off')).toBe(false);
    expect(allowsViewTransition('full', true)).toBe(true);
    expect(allowsViewTransition('full', false)).toBe(false);
    expect(allowsViewTransition('simple', true)).toBe(false);
  });
});

describe('时长矩阵', () => {
  it('transform：只有 full 有位移时长', () => {
    expect(transformDuration('full')).toBe(MOTION_DURATIONS.base);
    expect(transformDuration('simple')).toBe(0);
    expect(transformDuration('off')).toBe(0);
  });

  it('淡入淡出：off 归零，simple 保留', () => {
    expect(fadeDuration('full')).toBe(MOTION_DURATIONS.base);
    expect(fadeDuration('simple')).toBe(MOTION_DURATIONS.base);
    expect(fadeDuration('off')).toBe(0);
  });

  it('整页 / sheet / 高亮 / 错峰', () => {
    expect(pageDuration('full')).toBe(MOTION_DURATIONS.page);
    expect(pageDuration('simple')).toBe(MOTION_DURATIONS.base);
    expect(pageDuration('off')).toBe(0);
    expect(sheetDuration('full')).toBe(MOTION_DURATIONS.slow);
    expect(sheetDuration('simple')).toBe(MOTION_DURATIONS.base);
    expect(sheetDuration('off')).toBe(0);
    expect(highlightDuration('full')).toBe(MOTION_DURATIONS.highlight);
    expect(highlightDuration('simple')).toBe(MOTION_DURATIONS.highlight);
    expect(highlightDuration('off')).toBe(0);
    expect(staggerStep('full')).toBe(CARD_STAGGER_MS);
    expect(staggerStep('simple')).toBe(0);
    expect(staggerStep('off')).toBe(0);
  });

  it('降级类名', () => {
    expect(pageEnterClass('forward', 'full')).toBe('page-enter--forward');
    expect(pageEnterClass('back', 'full')).toBe('page-enter--back');
    expect(pageEnterClass('forward', 'simple')).toBe('page-enter--forward');
    expect(pageEnterClass('forward', 'off')).toBeNull();
  });

  it('页面位移量与任务书一致（12px）', () => {
    expect(PAGE_ENTER_SHIFT_PX).toBe(12);
    expect(CARD_STAGGER_MAX).toBe(12);
  });
});

describe('CSS 令牌与 JS 常量一致', () => {
  const token = (name: string): number => {
    const match = new RegExp(`--${name}:\\s*(\\d+)ms`).exec(tokensCss);
    if (match === null) throw new Error(`tokens.css 缺少 --${name}`);
    return Number(match[1]);
  };

  it('--dur-* 与 MOTION_DURATIONS 对齐', () => {
    expect(token('dur-fast')).toBe(MOTION_DURATIONS.fast);
    expect(token('dur-base')).toBe(MOTION_DURATIONS.base);
    expect(token('dur-slow')).toBe(MOTION_DURATIONS.slow);
    expect(token('dur-page')).toBe(MOTION_DURATIONS.page);
  });

  it('语义令牌在 tokens.css 里存在（组件只准用它）', () => {
    for (const name of [
      'motion-transform-dur',
      'motion-fade-dur',
      'motion-page-dur',
      'motion-sheet-dur',
      'motion-stagger',
      'motion-highlight-dur',
    ]) {
      expect(tokensCss).toContain(`--${name}:`);
    }
  });
});
