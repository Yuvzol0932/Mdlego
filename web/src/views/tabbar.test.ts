// @vitest-environment jsdom
/**
 * 底部导航（阶段 C1）行为测试。
 *
 * 验的是「结构 + 交互契约」：五个入口齐全、当前 tab 高亮、
 * 点其它 tab 走 nav/tab、点中间＋走真实导入链路、点当前 tab 不产生多余 dispatch。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderMarkdown } from '../core/markdown';
import { DEFAULT_SETTINGS } from '../data/settings-store';
import { createInitialState, createStore } from '../state/store';
import type { StateAction } from '../core/types';
import type { ViewDeps } from './app';
import { renderTabBar } from './tabbar';

function rig() {
  const store = createStore(createInitialState(DEFAULT_SETTINGS));
  const dispatched: StateAction[] = [];
  const dispatch = (action: StateAction): void => {
    dispatched.push(action);
    store.dispatch(action);
  };
  const importSpy = vi.fn();
  const deps: ViewDeps = {
    dispatch,
    getState: () => store.getState(),
    requestImport: importSpy,
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
    addSelectionMark: () => undefined,
    openNoteForSelection: () => undefined,
    openNoteForMark: () => undefined,
    removeMark: () => undefined,
    openMarks: () => undefined,
    copyText: () => undefined,
    lookupWord: () => undefined,
    isReanchorPending: () => false,
    exportBackup: () => undefined,
    importBackupFile: () => undefined,
    importBackupClipboard: () => undefined,
    reanchorSelection: () => undefined,
    pickBanner: () => undefined,
    clearBanner: () => undefined,
    clearStats: () => undefined,
    toast: () => undefined,
    appVersion: 'test',
    buildId: 'test',
    sample: '',
    renderMarkdown,
  };
  return { deps, dispatched, importSpy };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('底部导航', () => {
  it('五个入口齐全，中间是导入入口', () => {
    const { deps } = rig();
    const nav = renderTabBar('shelf', deps);
    document.body.append(nav);

    expect(nav.getAttribute('data-testid')).toBe('tabbar');
    for (const id of ['tab-shelf', 'tab-search', 'tab-stats', 'tab-settings', 'import-file']) {
      expect(nav.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    }
    // 五项：四个文字 tab + 一个凸起按钮
    expect(nav.querySelectorAll('.tabbar__item').length).toBe(4);
    expect(nav.querySelectorAll('.tabbar__plus').length).toBe(1);
  });

  it('当前 tab 用 aria-current=page 高亮，且只有一项', () => {
    const { deps } = rig();
    const nav = renderTabBar('stats', deps);
    const current = [...nav.querySelectorAll('.tabbar__item')].filter(
      (n) => n.getAttribute('aria-current') === 'page',
    );
    expect(current.length).toBe(1);
    expect(current[0]?.getAttribute('data-testid')).toBe('tab-stats');
  });

  it('点其它 tab 派发 nav/tab', () => {
    const { deps, dispatched } = rig();
    const nav = renderTabBar('shelf', deps);
    nav.querySelector<HTMLButtonElement>('[data-testid="tab-search"]')?.click();
    expect(dispatched).toEqual([{ type: 'nav/tab', tab: 'search' }]);
  });

  it('点当前 tab 不派发任何 action（避免无谓状态变化）', () => {
    const { deps, dispatched } = rig();
    const nav = renderTabBar('shelf', deps);
    nav.querySelector<HTMLButtonElement>('[data-testid="tab-shelf"]')?.click();
    expect(dispatched).toEqual([]);
  });

  it('中间＋走真实的导入请求', () => {
    const { deps, importSpy, dispatched } = rig();
    const nav = renderTabBar('shelf', deps);
    nav.querySelector<HTMLButtonElement>('[data-testid="import-file"]')?.click();
    expect(importSpy).toHaveBeenCalledTimes(1);
    expect(dispatched).toEqual([]);
  });
});
