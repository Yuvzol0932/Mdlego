// @vitest-environment jsdom
/**
 * 统计页（阶段 C1 壳 + C6 数据）视图测试。
 *
 * 重点：
 *   - 没有数据时显示空状态，**不显示 0 数字冒充数据**
 *   - 有数据时三张卡 / 七日图 / 最近读过都在
 *   - 时长文案：不足 1 分钟不会被说成 0 分钟
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { renderMarkdown } from '../core/markdown';
import type { State, StatsSnapshot } from '../core/types';
import { DEFAULT_SETTINGS } from '../data/settings-store';
import { createInitialState } from '../state/store';
import type { ViewDeps } from './app';
import { formatDuration, renderStats } from './stats';

function deps(): ViewDeps {
  return {
    dispatch: () => undefined,
    getState: () => createInitialState(DEFAULT_SETTINGS),
    requestImport: () => undefined,
    openToc: () => undefined,
    openSearch: () => undefined,
    searchLibrary: () => [],
    openHit: () => undefined,
    openMenu: () => undefined,
    requestDelete: () => undefined,
    toggleBookmark: () => undefined,
    openImage: () => undefined,
    openTypeset: () => undefined,
    openTagEditor: () => undefined,
    openFolderEditor: () => undefined,
    pickBanner: () => undefined,
    clearBanner: () => undefined,
    clearStats: () => undefined,
    toast: () => undefined,
    appVersion: 'test',
    buildId: 'test',
    sample: '',
    renderMarkdown,
  };
}

const snapshot: StatsSnapshot = {
  todayMs: 12 * 60_000,
  streakDays: 3,
  docCount: 5,
  week: [
    { day: '2026-11-11', ms: 0 },
    { day: '2026-11-12', ms: 4 * 60_000 },
    { day: '2026-11-13', ms: 0 },
    { day: '2026-11-14', ms: 8 * 60_000 },
    { day: '2026-11-15', ms: 2 * 60_000 },
    { day: '2026-11-16', ms: 6 * 60_000 },
    { day: '2026-11-17', ms: 12 * 60_000 },
  ],
  recent: [{ docId: 'a', title: '技术写作指南', lastReadAt: Date.UTC(2026, 10, 17) }],
};

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('时长文案', () => {
  it('0 / 不足 1 分钟 / 分钟 / 小时', () => {
    expect(formatDuration(0)).toBe('0 分钟');
    expect(formatDuration(15_000)).toBe('不足 1 分钟');
    expect(formatDuration(4 * 60_000)).toBe('4 分钟');
    expect(formatDuration(60 * 60_000)).toBe('1 小时');
    expect(formatDuration(80 * 60_000)).toBe('1 小时 20 分');
  });
});

describe('统计页', () => {
  it('没有数据时显示空状态，不伪造数字', () => {
    const state = { ...createInitialState(DEFAULT_SETTINGS), stats: null } as State;
    const el = renderStats(state, deps());
    document.body.append(el);
    expect(el.querySelector('[data-testid="stats-empty"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="stats-today"]')).toBeNull();
    expect(el.querySelector('[data-testid="stats-chart"]')).toBeNull();
    expect(el.textContent).not.toContain('0 分钟');
  });

  it('有数据时三张卡 + 七日图 + 最近读过', () => {
    const state = { ...createInitialState(DEFAULT_SETTINGS), stats: snapshot } as State;
    const el = renderStats(state, deps());
    document.body.append(el);
    expect(el.querySelector('[data-testid="stats-today"]')?.textContent).toContain('12 分钟');
    expect(el.querySelector('[data-testid="stats-streak"]')?.textContent).toContain('3 天');
    expect(el.querySelector('[data-testid="stats-docs"]')?.textContent).toContain('5 篇');
    expect(el.querySelector('[data-testid="stats-chart"]')).not.toBeNull();
    expect(el.querySelectorAll('.stats-bar')).toHaveLength(7);
    expect(el.querySelector('[data-testid="stats-recent-item"]')?.textContent).toContain('技术写作指南');
  });

  it('柱状图归一化：最长的那天柱子最高，今天高亮', () => {
    const state = { ...createInitialState(DEFAULT_SETTINGS), stats: snapshot } as State;
    const el = renderStats(state, deps());
    const bars = [...el.querySelectorAll<SVGRectElement>('.stats-bar')];
    const heights = bars.map((b) => Number(b.getAttribute('height')));
    expect(Math.max(...heights)).toBe(heights[6]);
    expect(bars[6]?.classList.contains('stats-bar--today')).toBe(true);
  });
});
