// @vitest-environment jsdom
/**
 * 左缘右滑返回单测（阶段 D4）。
 *
 * jsdom 没有 PointerEvent：用 MouseEvent 冒充（处理器只读 clientX/clientY），
 * 时间用 Date.now()（假时钟可控），覆盖：非边缘不启动、纵向不抢、
 * 跟手位移、慢速回弹、快速/远距提交、禁用与 destroy。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMIT_DISTANCE, COMMIT_VELOCITY, EDGE_ZONE, enableEdgeBack } from './edge-back';

function pointer(target: EventTarget, type: string, x: number, y: number): void {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  target.dispatchEvent(event);
}

function setup(overrides: { enabled?: boolean; canGoBack?: boolean } = {}) {
  document.body.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'shell';
  document.body.append(page);
  const onBack = vi.fn();
  const control = enableEdgeBack({
    getPageElement: () => page,
    canGoBack: () => overrides.canGoBack ?? true,
    enabled: () => overrides.enabled ?? true,
    durationMs: () => 220,
    onBack,
  });
  return { page, control, onBack };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('右滑返回', () => {
  it('起点不在左缘时不启动', () => {
    const { page, control, onBack } = setup();
    pointer(document, 'pointerdown', EDGE_ZONE + 40, 400);
    pointer(document, 'pointermove', EDGE_ZONE + 120, 400);
    pointer(document, 'pointerup', EDGE_ZONE + 120, 400);
    vi.advanceTimersByTime(400);
    expect(page.style.transform).toBe('');
    expect(onBack).not.toHaveBeenCalled();
    control.destroy();
  });

  it('纵向为主的滑动不抢滚动', () => {
    const { page, control, onBack } = setup();
    pointer(document, 'pointerdown', 4, 300);
    pointer(document, 'pointermove', 10, 420);
    pointer(document, 'pointerup', 10, 420);
    vi.advanceTimersByTime(400);
    expect(page.style.transform).toBe('');
    expect(onBack).not.toHaveBeenCalled();
    control.destroy();
  });

  it('跟手：只动 transform，带阻尼', () => {
    const { page, control } = setup();
    pointer(document, 'pointerdown', 4, 400);
    pointer(document, 'pointermove', 124, 400);
    // dx=120 × 0.55 = 66px
    expect(page.style.transform).toBe('translateX(66px)');
    pointer(document, 'pointerup', 124, 400);
    control.destroy();
  });

  it('位移不足且慢速：回弹，不返回', () => {
    const { page, control, onBack } = setup();
    pointer(document, 'pointerdown', 4, 400);
    pointer(document, 'pointermove', 60, 400); // dx=56×0.55≈31px
    vi.advanceTimersByTime(600);
    pointer(document, 'pointerup', 60, 400);
    vi.advanceTimersByTime(400);
    expect(onBack).not.toHaveBeenCalled();
    expect(page.style.transform).toBe('');
  });

  it('拖得够远：滑出后调用返回', () => {
    const { page, control, onBack } = setup();
    pointer(document, 'pointerdown', 4, 400);
    // 220px × 0.55 = 121 → 被 MAX_FOLLOW 夹到 120 > 96
    pointer(document, 'pointermove', 224, 400);
    pointer(document, 'pointerup', 224, 400);
    expect(page.style.opacity).toBe('0');
    expect(onBack).not.toHaveBeenCalled();
    vi.advanceTimersByTime(260);
    expect(onBack).toHaveBeenCalledTimes(1);
    control.destroy();
  });

  it('速度够快时即使距离短也提交', () => {
    const { control, onBack } = setup();
    pointer(document, 'pointerdown', 4, 400);
    pointer(document, 'pointermove', 104, 400); // dx=55px
    vi.advanceTimersByTime(10); // 55/10 = 5.5 px/ms
    pointer(document, 'pointerup', 104, 400);
    vi.advanceTimersByTime(260);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(COMMIT_VELOCITY).toBe(0.5);
    expect(COMMIT_DISTANCE).toBe(96);
    control.destroy();
  });

  it('不可返回 / 禁用时不启动', () => {
    const noBack = setup({ canGoBack: false });
    pointer(document, 'pointerdown', 4, 400);
    pointer(document, 'pointermove', 224, 400);
    pointer(document, 'pointerup', 224, 400);
    vi.advanceTimersByTime(300);
    expect(noBack.onBack).not.toHaveBeenCalled();
    noBack.control.destroy();

    const disabled = setup({ enabled: false });
    pointer(document, 'pointerdown', 4, 400);
    pointer(document, 'pointermove', 224, 400);
    pointer(document, 'pointerup', 224, 400);
    vi.advanceTimersByTime(300);
    expect(disabled.onBack).not.toHaveBeenCalled();
    disabled.control.destroy();
  });

  it('起点在横向滚动容器里不启动', () => {
    const { page, control, onBack } = setup();
    const track = document.createElement('div');
    track.className = 'hero__track';
    page.append(track);
    pointer(track, 'pointerdown', 4, 400);
    pointer(track, 'pointermove', 224, 400);
    pointer(track, 'pointerup', 224, 400);
    vi.advanceTimersByTime(300);
    expect(onBack).not.toHaveBeenCalled();
    control.destroy();
  });
});
