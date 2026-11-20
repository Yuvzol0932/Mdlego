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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearMorphSlot,
  hasHiddenMorphSlot,
  isPageTransitionRunning,
  markMorphSlotHidden,
  runCloseMask,
  runOpenMask,
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

interface RecordedAnim {
  readonly target: Element;
  readonly keyframes: Keyframe[];
  readonly options: KeyframeAnimationOptions | undefined;
  readonly resolve: () => void;
}

/** jsdom 未实现 WAAPI：用可控假 Animation 记录每一层的动画关键帧。 */
function mockWaapi(): { readonly recorded: RecordedAnim[]; restore(): void } {
  const recorded: RecordedAnim[] = [];
  const proto = Element.prototype as Element & { animate?: typeof Element.prototype.animate };
  const orig = proto.animate;
  proto.animate = function (
    this: Element,
    keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    options?: number | KeyframeAnimationOptions,
  ): Animation {
    let resolveFinished!: () => void;
    const finished = new Promise<Animation>((res) => {
      resolveFinished = () => res(anim);
    });
    const anim = {
      finished,
      cancel: vi.fn(),
      finish: vi.fn(),
      pause: vi.fn(),
      play: vi.fn(),
    } as unknown as Animation;
    recorded.push({
      target: this,
      keyframes: Array.isArray(keyframes) ? keyframes : [],
      options: typeof options === 'object' ? options : undefined,
      resolve: resolveFinished,
    });
    return anim;
  };
  return {
    recorded,
    restore(): void {
      if (orig === undefined) Reflect.deleteProperty(proto, 'animate');
      else proto.animate = orig;
    },
  };
}

describe('关闭与打开转场：封面克隆层与无缝交叉渐变', () => {
  let waapi: ReturnType<typeof mockWaapi> | null = null;
  let origInnerWidth: number;
  let origInnerHeight: number;

  beforeEach(() => {
    origInnerWidth = window.innerWidth;
    origInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { value: 393, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 873, configurable: true });
    window.scrollTo = vi.fn();
    waapi = mockWaapi();
    clearMorphSlot();
  });

  afterEach(() => {
    settlePageTransition();
    waapi?.restore();
    waapi = null;
    Object.defineProperty(window, 'innerWidth', { value: origInnerWidth, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: origInnerHeight, configurable: true });
    document.body.replaceChildren();
  });

  it('runCloseMask 在 update() 后才测量目标卡片并按 1:1 比例克隆实时封面（修复高度 0px 硬切）', () => {
    const root = document.createElement('div');
    const reader = document.createElement('div');
    reader.className = 'shell reader-page';
    const shelf = document.createElement('div');
    shelf.className = 'shell shelf-page';
    const liveCover = document.createElement('span');
    liveCover.className = 'cover cover--card';
    liveCover.setAttribute('data-cover', '2');
    liveCover.setAttribute('data-cover-doc', 'doc-1');
    const initial = document.createElement('span');
    initial.className = 'cover__initial';
    initial.textContent = '四';
    liveCover.append(initial);
    shelf.append(liveCover);

    root.append(reader);
    document.body.append(root);

    let shelfMounted = false;
    runCloseMask({
      level: 'full',
      getPrevious: () => (shelfMounted ? shelf : reader),
      getMounted: () => (shelfMounted ? shelf : reader),
      update: () => {
        reader.remove();
        root.prepend(shelf);
        shelfMounted = true;
      },
      // 模拟真实场景：update() 之前书架不在 DOM，findTarget 必为 null
      findTarget: () => (shelfMounted ? { left: 16, top: 420, right: 130, bottom: 572, radius: 18 } : null),
      resolveSlot: () => (shelfMounted ? liveCover : null),
    });

    const mask = document.querySelector<HTMLElement>('[data-testid="page-mask"]');
    expect(mask).not.toBeNull();
    const coverLayer = mask?.querySelector<HTMLElement>('.page-mask__cover') ?? null;
    expect(coverLayer).not.toBeNull();
    // 真实卡片宽 114、高 152，内层槽位按 1:1 尺寸 + 1/scale 铺满，绝不再是 0px
    const coverSlot = coverLayer?.querySelector<HTMLElement>('.page-mask__cover-slot') ?? null;
    expect(coverSlot).not.toBeNull();
    expect(coverSlot?.style.width).toBe('114px');
    expect(coverSlot?.style.height).toBe('152px');
    expect(coverSlot?.style.transform).toContain('scale(');

    // 克隆的是实时书架封面，且已剥离隐身类与 doc 标识
    const clonedCover = coverSlot?.querySelector<HTMLElement>('.cover') ?? null;
    expect(clonedCover).not.toBeNull();
    expect(clonedCover?.getAttribute('data-cover')).toBe('2');
    expect(clonedCover?.hasAttribute('data-cover-doc')).toBe(false);
    expect(clonedCover?.classList.contains(HIDDEN)).toBe(false);
    expect(clonedCover?.textContent).toBe('四');

    // 原卡槽已隐身防重影，书架已抑制 card-in 重播
    expect(liveCover.classList.contains(HIDDEN)).toBe(true);
    expect(shelf.classList.contains('is-morph-returning')).toBe(true);

    // 封面层拥有平滑淡入到 1 的交叉渐变动画
    const coverAnim = waapi?.recorded.find((r) => r.target === coverLayer);
    expect(coverAnim).toBeDefined();
    expect(coverAnim?.keyframes[0]?.opacity).toBe('0');
    expect(coverAnim?.keyframes[coverAnim.keyframes.length - 1]?.opacity).toBe('1');

    // 收尾清理干净、原卡槽恢复可见
    settlePageTransition();
    expect(document.querySelector('[data-testid="page-mask"]')).toBeNull();
    expect(liveCover.classList.contains(HIDDEN)).toBe(false);
  });

  it('runOpenMask 同样按真实卡片 1:1 比例克隆封面并淡出', () => {
    const root = document.createElement('div');
    const shelf = document.createElement('div');
    shelf.className = 'shell shelf-page';
    const liveCover = document.createElement('span');
    liveCover.className = 'cover cover--card';
    liveCover.setAttribute('data-cover', '3');
    liveCover.setAttribute('data-cover-doc', 'doc-2');
    liveCover.append(Object.assign(document.createElement('span'), { className: 'cover__initial', textContent: '墨' }));
    shelf.append(liveCover);

    const reader = document.createElement('div');
    reader.className = 'shell reader-page';

    root.append(shelf);
    document.body.append(root);

    let opened = false;
    runOpenMask({
      level: 'full',
      startRect: { left: 16, top: 420, right: 130, bottom: 572, radius: 18 },
      slotElement: liveCover,
      getPrevious: () => (opened ? reader : shelf),
      getMounted: () => (opened ? reader : shelf),
      update: () => {
        shelf.remove();
        root.append(reader);
        opened = true;
      },
    });

    const coverLayer = document.querySelector<HTMLElement>('.page-mask__cover');
    const coverSlot = coverLayer?.querySelector<HTMLElement>('.page-mask__cover-slot');
    expect(coverSlot?.style.width).toBe('114px');
    expect(coverSlot?.style.height).toBe('152px');
    expect(coverSlot?.querySelector('.cover')?.textContent).toBe('墨');
    expect(coverSlot?.querySelector('.cover')?.classList.contains(HIDDEN)).toBe(false);

    const coverAnim = waapi?.recorded.find((r) => r.target === coverLayer);
    expect(coverAnim?.keyframes[0]?.opacity).toBe('1');
    expect(coverAnim?.keyframes[coverAnim.keyframes.length - 1]?.opacity).toBe('0');

    settlePageTransition();
    expect(document.querySelector('[data-testid="page-mask"]')).toBeNull();
  });
});
