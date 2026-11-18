// @vitest-environment jsdom
/**
 * 转场形变槽位（`.is-morph-slot-hidden`）的生命周期测试。
 *
 * 背景：FLIP 转场期间，书架上「正在飞的那张卡」必须临时隐身，否则屏幕上
 * 会出现两个一模一样的封面（形变壳里一个、原卡槽一个）。这个隐身类名一旦
 * 漏摘，书架会**永久**少一本书的封面 —— 是这一整块最容易出事的地方，
 * 所以 DoD 明确要求「转场结束与 cancel 异常时标必恢复」有单测兜底。
 *
 * 这里测的是 page-mask 的槽位账本（纯 DOM 类名，不涉及动画时序）：
 *   1. 隐身 / 恢复基本语义；
 *   2. 幂等：重复隐身同一元素不做无谓抖动；
 *   3. 换卡片：旧卡必先恢复，新卡才隐身（顺序反了会把刚加的立刻清掉）；
 *   4. 异常自愈：`settlePageTransition()` 无条件清账 —— 这是动画被打断、
 *      抛错、用户按返回键等所有异常路径共用的收尾口；
 *   5. `null` 参数会走 clear 分支（历史踩点，行为要固定住）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearMorphSlot,
  hasHiddenMorphSlot,
  isPageTransitionRunning,
  markMorphSlotHidden,
  settlePageTransition,
} from './page-mask';

/** 造一张「书架封面」，只关心类名账本，不关心真实卡片结构。 */
function makeCover(): HTMLElement {
  const cover = document.createElement('div');
  cover.className = 'cover';
  cover.setAttribute('data-cover', '1');
  document.body.append(cover);
  return cover;
}

const HIDDEN = 'is-morph-slot-hidden';

describe('形变槽位隐身：基本语义', () => {
  beforeEach(() => {
    clearMorphSlot();
  });
  afterEach(() => {
    clearMorphSlot();
    document.body.replaceChildren();
  });

  it('初始状态没有任何槽位被隐身', () => {
    expect(hasHiddenMorphSlot()).toBe(false);
    expect(document.querySelectorAll(`.${HIDDEN}`)).toHaveLength(0);
  });

  it('设为隐身 → 类名挂上、账本记下', () => {
    const cover = makeCover();
    markMorphSlotHidden(cover);
    expect(cover.classList.contains(HIDDEN)).toBe(true);
    expect(hasHiddenMorphSlot()).toBe(true);
  });

  it('恢复后类名摘掉、账本清空', () => {
    const cover = makeCover();
    markMorphSlotHidden(cover);
    clearMorphSlot();
    expect(cover.classList.contains(HIDDEN)).toBe(false);
    expect(hasHiddenMorphSlot()).toBe(false);
  });

  it('clearMorphSlot 可以重复调用，不会抛错', () => {
    makeCover();
    expect(() => {
      clearMorphSlot();
      clearMorphSlot();
      clearMorphSlot();
    }).not.toThrow();
    expect(hasHiddenMorphSlot()).toBe(false);
  });

  it('重复隐身同一张卡是幂等的（类名不会抖动）', () => {
    const cover = makeCover();
    markMorphSlotHidden(cover);
    markMorphSlotHidden(cover);
    markMorphSlotHidden(cover);
    expect(cover.classList.contains(HIDDEN)).toBe(true);
    expect(document.querySelectorAll(`.${HIDDEN}`)).toHaveLength(1);
    expect(hasHiddenMorphSlot()).toBe(true);
  });

  it('换一张卡：旧卡先恢复，新卡才隐身（不能同时隐身两张）', () => {
    const first = makeCover();
    const second = makeCover();
    markMorphSlotHidden(first);
    markMorphSlotHidden(second);
    expect(first.classList.contains(HIDDEN)).toBe(false);
    expect(second.classList.contains(HIDDEN)).toBe(true);
    expect(document.querySelectorAll(`.${HIDDEN}`)).toHaveLength(1);
  });
});

describe('形变槽位隐身：异常路径必须恢复（DoD ③）', () => {
  afterEach(() => {
    clearMorphSlot();
    document.body.replaceChildren();
  });

  it('settlePageTransition 在没有任何转场时是无害的空转', () => {
    expect(isPageTransitionRunning()).toBe(false);
    expect(() => settlePageTransition()).not.toThrow();
    expect(hasHiddenMorphSlot()).toBe(false);
  });

  it('cancle/打断后调用 settlePageTransition：隐身必被摘掉', () => {
    const cover = makeCover();
    markMorphSlotHidden(cover);
    expect(cover.classList.contains(HIDDEN)).toBe(true);

    // 模拟「动画中途被异常打断，收尾口统一下场」
    settlePageTransition();

    expect(hasHiddenMorphSlot()).toBe(false);
    expect(document.querySelectorAll(`.${HIDDEN}`)).toHaveLength(0);
  });

  it('连续多次 settle 也不会累积残留', () => {
    for (let i = 0; i < 5; i++) {
      const cover = makeCover();
      markMorphSlotHidden(cover);
      settlePageTransition();
      expect(cover.classList.contains(HIDDEN)).toBe(false);
      cover.remove();
    }
    expect(document.querySelectorAll(`.${HIDDEN}`)).toHaveLength(0);
  });
});

describe('形变槽位隐身：账本健壮性', () => {
  afterEach(() => {
    clearMorphSlot();
    document.body.replaceChildren();
  });

  it('被书架重绘淘汰的旧节点不会让 clearMorphSlot 抛错', () => {
    const cover = makeCover();
    markMorphSlotHidden(cover);
    // 模拟书架重渲染：旧节点被整棵摘掉
    cover.remove();
    expect(() => clearMorphSlot()).not.toThrow();
    expect(hasHiddenMorphSlot()).toBe(false);
  });

  it('恢复后对同一元素再隐身一次，行为与首次一致', () => {
    const cover = makeCover();
    markMorphSlotHidden(cover);
    clearMorphSlot();
    expect(cover.classList.contains(HIDDEN)).toBe(false);

    markMorphSlotHidden(cover);
    expect(cover.classList.contains(HIDDEN)).toBe(true);
    clearMorphSlot();
    expect(cover.classList.contains(HIDDEN)).toBe(false);
  });
});
