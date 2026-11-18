/**
 * 预测式返回决策单测（转场改造 Step 4）。
 *
 * 重点是两条硬约束：
 *   ① 书架根页面 + 无浮层 → **绝不**开启原生拦截（否则废掉退回桌面的系统动画）
 *   ② 有子浮层时只能关浮层，不能把整张阅读页一起缩
 */

import { describe, expect, it } from 'vitest';
import {
  canFollowMorph,
  decideBackAction,
  normalizePhase,
  normalizeProgress,
  settleDurationMs,
  shouldInterceptBack,
  type BackStack,
} from './back-gesture';

/** 书架根页面（无可退层级）。 */
const SHELF_ROOT: BackStack = { pageDepth: 1, layerDepth: 0, topIsReader: false };
/** 阅读页（无浮层）。 */
const READER: BackStack = { pageDepth: 2, layerDepth: 0, topIsReader: true };
/** 阅读页 + 一个浮层（例如查词卡）。 */
const READER_WITH_LAYER: BackStack = { pageDepth: 2, layerDepth: 1, topIsReader: true };
/** 设置页（非阅读页，但有页面可退）。 */
const SETTINGS: BackStack = { pageDepth: 2, layerDepth: 0, topIsReader: false };

describe('decideBackAction：退栈优先级', () => {
  it('有子浮层 → 先关浮层', () => {
    expect(decideBackAction(READER_WITH_LAYER)).toEqual({ kind: 'close-layer' });
  });

  it('阅读页无浮层 → 退回书架', () => {
    expect(decideBackAction(READER)).toEqual({ kind: 'close-reader' });
  });

  it('非阅读页但有页面可退 → 普通返回', () => {
    expect(decideBackAction(SETTINGS)).toEqual({ kind: 'pop-page' });
  });

  it('书架根页面 → 交给系统（退回桌面）', () => {
    expect(decideBackAction(SHELF_ROOT)).toEqual({ kind: 'system' });
  });

  it('多个浮层时仍然只关一层（逐层退，不一次清空）', () => {
    const stacked: BackStack = { pageDepth: 3, layerDepth: 3, topIsReader: true };
    expect(decideBackAction(stacked)).toEqual({ kind: 'close-layer' });
  });

  it('浮层优先于页面栈深度', () => {
    const deepWithLayer: BackStack = { pageDepth: 5, layerDepth: 2, topIsReader: false };
    expect(decideBackAction(deepWithLayer)).toEqual({ kind: 'close-layer' });
  });
});

describe('shouldInterceptBack：绝不能废掉系统退回桌面动画', () => {
  it('书架根页面 + 无浮层 → 不拦截', () => {
    expect(shouldInterceptBack(SHELF_ROOT)).toBe(false);
  });

  it('阅读页 → 拦截', () => {
    expect(shouldInterceptBack(READER)).toBe(true);
  });

  it('任何有浮层的状态 → 拦截', () => {
    expect(shouldInterceptBack(READER_WITH_LAYER)).toBe(true);
  });

  it('非阅读页但有页面可退 → 拦截', () => {
    expect(shouldInterceptBack(SETTINGS)).toBe(true);
  });

  it('只有「完全到底」才放行给系统', () => {
    const states: BackStack[] = [SHELF_ROOT, READER, READER_WITH_LAYER, SETTINGS];
    for (const s of states) {
      const action = decideBackAction(s);
      expect(shouldInterceptBack(s)).toBe(action.kind !== 'system');
    }
  });
});

describe('canFollowMorph：跟手缩窗的前提', () => {
  it('纯净阅读页才可以整页缩窗', () => {
    expect(canFollowMorph(READER)).toBe(true);
  });

  it('有浮层时不能缩整页（只能关浮层）', () => {
    expect(canFollowMorph(READER_WITH_LAYER)).toBe(false);
  });

  it('书架根页面不能缩窗', () => {
    expect(canFollowMorph(SHELF_ROOT)).toBe(false);
  });

  it('非阅读页不能缩窗', () => {
    expect(canFollowMorph(SETTINGS)).toBe(false);
  });
});

describe('normalizePhase / normalizeProgress：外部输入健壮性', () => {
  it('识别四个已知阶段', () => {
    expect(normalizePhase('start')).toBe('start');
    expect(normalizePhase('move')).toBe('move');
    expect(normalizePhase('commit')).toBe('commit');
    expect(normalizePhase('cancel')).toBe('cancel');
  });

  it('未知/非法阶段返回 null（调用方忽略，不抛错）', () => {
    expect(normalizePhase('weird')).toBeNull();
    expect(normalizePhase(undefined)).toBeNull();
    expect(normalizePhase(null)).toBeNull();
    expect(normalizePhase(42)).toBeNull();
  });

  it('进度被夹到 0..1', () => {
    expect(normalizeProgress(0.5)).toBe(0.5);
    expect(normalizeProgress(-3)).toBe(0);
    expect(normalizeProgress(9)).toBe(1);
  });

  it('非法进度归零，不产生 NaN', () => {
    expect(normalizeProgress('0.5')).toBe(0);
    expect(normalizeProgress(Number.NaN)).toBe(0);
    expect(normalizeProgress(undefined)).toBe(0);
  });
});

describe('settleDurationMs', () => {
  it('取消时短回弹，提交时直接落地', () => {
    expect(settleDurationMs('cancel')).toBe(200);
    expect(settleDurationMs('commit')).toBe(0);
  });
});
