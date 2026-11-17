import { describe, expect, it } from 'vitest';
import {
  back, canGoBack, closeLayer, closeReader, INITIAL_NAV, openLayer, pageKey, pushPage, switchTab, topPage,
} from './nav';
import type { NavState, Page } from './types';

const reader = (docId: string): Page => ({ kind: 'reader', docId });
const settings: Page = { kind: 'tab', tab: 'settings' };

describe('页面栈', () => {
  it('初始只有书架，无处可退', () => {
    expect(topPage(INITIAL_NAV)).toEqual({ kind: 'tab', tab: 'shelf' });
    expect(canGoBack(INITIAL_NAV)).toBe(false);
    expect(back(INITIAL_NAV)).toBe(INITIAL_NAV);
  });

  it('书架 → 阅读 → 设置，逐级返回', () => {
    let nav = pushPage(INITIAL_NAV, reader('a'));
    nav = pushPage(nav, settings);
    expect(nav.pages.map(pageKey)).toEqual(['tab:shelf', 'reader:a', 'tab:settings']);
    nav = back(nav);
    expect(topPage(nav)).toEqual(reader('a'));
    nav = back(nav);
    expect(topPage(nav)).toEqual({ kind: 'tab', tab: 'shelf' });
    expect(canGoBack(nav)).toBe(false);
  });

  it('重复压同一页是空操作', () => {
    const nav = pushPage(INITIAL_NAV, reader('a'));
    expect(pushPage(nav, reader('a'))).toBe(nav);
  });

  it('再开另一篇会替换阅读页，不会叠两层阅读页', () => {
    let nav = pushPage(INITIAL_NAV, reader('a'));
    nav = pushPage(nav, reader('b'));
    expect(nav.pages.map(pageKey)).toEqual(['tab:shelf', 'reader:b']);
  });

  it('切 tab 清空栈与浮层', () => {
    let nav = pushPage(INITIAL_NAV, reader('a'));
    nav = openLayer(nav, 'toc');
    nav = switchTab(nav, 'settings');
    expect(nav).toEqual({ pages: [{ kind: 'tab', tab: 'settings' }], layers: [] });
  });

  it('closeReader 连同其上的设置页一起收起', () => {
    let nav = pushPage(pushPage(INITIAL_NAV, reader('a')), settings);
    nav = closeReader(nav);
    expect(nav.pages.map(pageKey)).toEqual(['tab:shelf']);
  });
});

describe('浮层栈：多层浮层 + 返回', () => {
  const base: NavState = pushPage(INITIAL_NAV, reader('a'));

  it('返回先弹浮层，页面不动', () => {
    let nav = openLayer(openLayer(base, 'toc'), 'lookup');
    expect(nav.layers).toEqual(['toc', 'lookup']);
    nav = back(nav);
    expect(nav.layers).toEqual(['toc']);
    expect(topPage(nav)).toEqual(reader('a'));
    nav = back(nav);
    expect(nav.layers).toEqual([]);
    expect(topPage(nav)).toEqual(reader('a'));
    nav = back(nav);
    expect(topPage(nav)).toEqual({ kind: 'tab', tab: 'shelf' });
  });

  it('同类浮层不重复，重开会移到栈顶', () => {
    let nav = openLayer(openLayer(base, 'toc'), 'search');
    nav = openLayer(nav, 'toc');
    expect(nav.layers).toEqual(['search', 'toc']);
    expect(openLayer(nav, 'toc')).toBe(nav);
  });

  it('closeLayer 关指定浮层及其上方的，关不存在的是空操作', () => {
    const nav = openLayer(openLayer(base, 'toc'), 'search');
    expect(closeLayer(nav, 'toc').layers).toEqual([]);
    expect(closeLayer(nav, 'lookup')).toBe(nav);
  });

  it('页面栈变化会清掉浮层（浮层不跨页存活）', () => {
    const nav = pushPage(openLayer(base, 'toc'), settings);
    expect(nav.layers).toEqual([]);
  });

  it('canGoBack：有浮层即可退', () => {
    expect(canGoBack(openLayer(INITIAL_NAV, 'search'))).toBe(true);
  });

  it('C1 新增浮层（menu / typeset / image）与既有浮层共用同一条返回路径', () => {
    let nav = pushPage(INITIAL_NAV, reader('a'));
    nav = openLayer(nav, 'typeset');
    nav = openLayer(nav, 'menu');
    expect(nav.layers).toEqual(['typeset', 'menu']);
    nav = back(nav);
    expect(nav.layers).toEqual(['typeset']);
    nav = back(nav);
    expect(nav.layers).toEqual([]);
    // 浮层都关掉后才开始退页面
    nav = back(nav);
    expect(topPage(nav)).toEqual({ kind: 'tab', tab: 'shelf' });
    expect(openLayer(INITIAL_NAV, 'image').layers).toEqual(['image']);
  });
});

describe('阶段 C 新增一级 tab', () => {
  it('切到搜索 / 统计：栈底换掉、浮层清空、可返回为 false', () => {
    for (const tab of ['search', 'stats'] as const) {
      const nav = switchTab(openLayer(INITIAL_NAV, 'menu'), tab);
      expect(nav).toEqual({ pages: [{ kind: 'tab', tab }], layers: [] });
      expect(topPage(nav)).toEqual({ kind: 'tab', tab });
      expect(canGoBack(nav)).toBe(false);
    }
  });

  it('搜索页作为底层 tab 时，打开文档得到两层栈（返回回到搜索）', () => {
    const nav = pushPage(switchTab(INITIAL_NAV, 'search'), reader('a'));
    expect(nav.pages.map(pageKey)).toEqual(['tab:search', 'reader:a']);
    expect(topPage(back(nav))).toEqual({ kind: 'tab', tab: 'search' });
  });
});
