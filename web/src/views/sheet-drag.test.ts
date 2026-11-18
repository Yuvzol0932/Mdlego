// @vitest-environment jsdom
/**
 * Bottom sheet 下拉手势单测（阶段 D3）。
 *
 * jsdom 没有 PointerEvent：用 MouseEvent 冒充，事件处理器只读 clientY / pointerId，
 * 足够覆盖「跟手、阈值、速度、回弹、禁用」这些判定。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISMISS_DISTANCE, DISMISS_VELOCITY, enableSheetDrag } from './sheet-drag';

function setup(options: { enabled?: boolean } = {}) {
  document.body.innerHTML = '';
  const panel = document.createElement('section');
  const scrim = document.createElement('div');
  const handle = document.createElement('span');
  panel.append(handle);
  document.body.append(scrim, panel);
  const onDismiss = vi.fn();
  const control = enableSheetDrag({
    panel,
    scrim,
    handle,
    enabled: options.enabled ?? true,
    durationMs: 220,
    onDismiss,
  });
  return { panel, scrim, handle, control, onDismiss };
}

function pointer(el: HTMLElement, type: string, clientY: number): void {
  const event = new MouseEvent(type, { clientY, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  el.dispatchEvent(event);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('下拉关闭', () => {
  it('拖过阈值后松手：继续滑出并调用关闭', () => {
    const { panel, handle, control, onDismiss } = setup();
    pointer(handle, 'pointerdown', 100);
    pointer(handle, 'pointermove', 100 + DISMISS_DISTANCE + 20);
    expect(panel.getAttribute('data-dragging')).toBe('1');
    expect(panel.style.transform).toContain('translateY');
    pointer(handle, 'pointerup', 100 + DISMISS_DISTANCE + 20);
    expect(panel.style.transform).toContain('110%');
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(260);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    control.destroy();
  });

  it('位移不足且速度慢：回弹，不关闭', () => {
    const { panel, handle, control, onDismiss } = setup();
    pointer(handle, 'pointerdown', 100);
    pointer(handle, 'pointermove', 120);
    // 20px / 500ms ≈ 0.04px/ms，低于速度阈值，走回弹分支
    vi.advanceTimersByTime(500);
    pointer(handle, 'pointerup', 120);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(panel.style.transform).toContain('translateY(0px)');
    vi.advanceTimersByTime(260);
    // 回弹结束后清掉 inline，避免下次打开带着旧 transform
    expect(panel.style.transform).toBe('');
    control.destroy();
  });

  it('速度够快时即使位移不大也关闭（按速度吸附）', () => {
    const { panel, handle, control, onDismiss } = setup();
    pointer(handle, 'pointerdown', 100);
    // 30px / 10ms = 3px/ms > 0.55
    pointer(handle, 'pointermove', 130);
    vi.advanceTimersByTime(10);
    pointer(handle, 'pointerup', 130);
    vi.advanceTimersByTime(260);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(DISMISS_VELOCITY).toBe(0.55);
    control.destroy();
  });

  it('遮罩随位移淡出', () => {
    const { panel, scrim, handle, control } = setup();
    pointer(handle, 'pointerdown', 100);
    pointer(handle, 'pointermove', 260);
    const opacity = Number(scrim.style.opacity);
    expect(opacity).toBeGreaterThan(0);
    expect(opacity).toBeLessThan(1);
    expect(panel.style.transform).toContain('translateY(160px)');
    control.destroy();
  });

  it('disabled 时不挂手势，拖动/松手都不改变面板、不关闭', () => {
    const { panel, handle, onDismiss } = setup({ enabled: false });
    pointer(handle, 'pointerdown', 100);
    pointer(handle, 'pointermove', 300);
    pointer(handle, 'pointerup', 300);
    vi.advanceTimersByTime(300);
    expect(panel.style.transform).toBe('');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('destroy 后不再响应手势', () => {
    const { panel, handle, control, onDismiss } = setup();
    control.destroy();
    pointer(handle, 'pointerdown', 100);
    pointer(handle, 'pointermove', 260);
    pointer(handle, 'pointerup', 260);
    vi.advanceTimersByTime(300);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(panel.style.transform).toBe('');
  });
});

/**
 * 多抓取元素 + 排除按钮（lookup #8 给查词弹层加的）。
 *
 * 查词弹层的把手必须是弹层的第一个子元素（不能包进一个组合容器），
 * 标题行里又有两个按钮，所以需要：多个抓取元素、样式选择器排除按钮。
 */
describe('多抓取元素', () => {
  function setupMulti() {
    document.body.innerHTML = '';
    const panel = document.createElement('section');
    const scrim = document.createElement('div');
    const handle = document.createElement('span');
    const head = document.createElement('header');
    const button = document.createElement('button');
    button.className = 'lookup__action';
    const title = document.createElement('h2');
    head.append(title, button);
    panel.append(handle, head);
    document.body.append(scrim, panel);
    const onDismiss = vi.fn();
    const control = enableSheetDrag({
      panel,
      scrim,
      handles: [handle, head],
      ignoreTargetSelector: '.lookup__action',
      enabled: true,
      durationMs: 220,
      onDismiss,
    });
    return { panel, handle, head, button, control, onDismiss };
  }

  it('把手能拖', () => {
    const { panel, handle, control, onDismiss } = setupMulti();
    pointer(handle, 'pointerdown', 100);
    pointer(handle, 'pointermove', 260);
    expect(panel.style.transform).toContain('translateY(160px)');
    pointer(handle, 'pointerup', 260);
    vi.advanceTimersByTime(260);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    control.destroy();
  });

  it('标题行也能拖', () => {
    const { panel, head, control, onDismiss } = setupMulti();
    pointer(head, 'pointerdown', 100);
    pointer(head, 'pointermove', 260);
    expect(panel.style.transform).toContain('translateY(160px)');
    pointer(head, 'pointerup', 260);
    vi.advanceTimersByTime(260);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    control.destroy();
  });

  it('标题行里的按钮上按下不启动拖拽（点按钮是动作）', () => {
    const { panel, button, control, onDismiss } = setupMulti();
    pointer(button, 'pointerdown', 100);
    pointer(button, 'pointermove', 300);
    pointer(button, 'pointerup', 300);
    vi.advanceTimersByTime(300);
    expect(panel.style.transform).toBe('');
    expect(onDismiss).not.toHaveBeenCalled();
    control.destroy();
  });

  it('handles 为空数组时不挂手势', () => {
    const panel = document.createElement('section');
    const onDismiss = vi.fn();
    const control = enableSheetDrag({
      panel,
      scrim: null,
      handles: [],
      enabled: true,
      durationMs: 220,
      onDismiss,
    });
    pointer(panel, 'pointerdown', 100);
    pointer(panel, 'pointermove', 300);
    pointer(panel, 'pointerup', 300);
    vi.advanceTimersByTime(300);
    expect(panel.style.transform).toBe('');
    control.destroy();
  });
});
