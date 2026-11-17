/**
 * 路由与页面栈 —— 纯函数。
 *
 * 模型：
 *   pages  页面栈，栈底是一级 tab（shelf / settings…），其上可压二级页（reader）。
 *          设置页也可以压在阅读页之上（阅读现场原样保留）。
 *   layers 浮层栈，挂在页面栈之上（目录 / 搜索 / 查词卡片…）。
 *
 * 返回只有一条规则（系统返回键与应用内返回共用）：
 *   先弹浮层 → 再弹页面 → 都空了才是「退出应用」。
 */

import type { LayerKind, NavState, Page, Tab } from './types';

export const INITIAL_NAV: NavState = { pages: [{ kind: 'tab', tab: 'shelf' }], layers: [] };

/** 当前顶部页面。栈永不为空。 */
export function topPage(nav: NavState): Page {
  return nav.pages[nav.pages.length - 1] ?? { kind: 'tab', tab: 'shelf' };
}

/** 页面的稳定键，用于页面缓存与滚动位置记忆。 */
export function pageKey(page: Page): string {
  return page.kind === 'tab' ? `tab:${page.tab}` : `reader:${page.docId}`;
}

/** 栈里的阅读页（至多一个）。 */
export function readerPage(nav: NavState): Extract<Page, { kind: 'reader' }> | null {
  for (const page of nav.pages) if (page.kind === 'reader') return page;
  return null;
}

/** 还有可返回的东西吗？false 时调用方应退出应用。 */
export function canGoBack(nav: NavState): boolean {
  return nav.layers.length > 0 || nav.pages.length > 1;
}

/** 一级 tab 切换：清空栈与浮层，以该 tab 为栈底。 */
export function switchTab(nav: NavState, tab: Tab): NavState {
  const top = topPage(nav);
  if (nav.pages.length === 1 && top.kind === 'tab' && top.tab === tab && nav.layers.length === 0) return nav;
  return { pages: [{ kind: 'tab', tab }], layers: [] };
}

/** 压入页面。重复压同一页是空操作；已有阅读页时再开阅读页会替换它。 */
export function pushPage(nav: NavState, page: Page): NavState {
  const top = topPage(nav);
  if (pageKey(top) === pageKey(page)) return nav;
  if (page.kind === 'reader') {
    // 阅读页永远直接压在栈底 tab 之上；其上的页面（如设置）一并丢弃
    const root = nav.pages[0] ?? { kind: 'tab', tab: 'shelf' };
    return { pages: [root, page], layers: [] };
  }
  // tab 页作为二级页压入（如阅读页里进设置）；栈里已有则不重复
  if (nav.pages.some((p) => pageKey(p) === pageKey(page))) return nav;
  return { pages: [...nav.pages, page], layers: [] };
}

/** 关闭阅读页（连同压在它上面的页面）。 */
export function closeReader(nav: NavState): NavState {
  const idx = nav.pages.findIndex((p) => p.kind === 'reader');
  if (idx < 0) return nav.layers.length === 0 ? nav : { ...nav, layers: [] };
  const pages = nav.pages.slice(0, idx);
  return { pages: pages.length > 0 ? pages : [{ kind: 'tab', tab: 'shelf' }], layers: [] };
}

/** 打开浮层。同类型浮层已在栈里则移到栈顶，不重复。 */
export function openLayer(nav: NavState, layer: LayerKind): NavState {
  if (nav.layers[nav.layers.length - 1] === layer) return nav;
  return { ...nav, layers: [...nav.layers.filter((l) => l !== layer), layer] };
}

/** 关闭指定浮层（及其上方的浮层）。 */
export function closeLayer(nav: NavState, layer: LayerKind): NavState {
  const idx = nav.layers.lastIndexOf(layer);
  if (idx < 0) return nav;
  return { ...nav, layers: nav.layers.slice(0, idx) };
}

/** 返回一步：浮层优先，其次页面。无处可退时原样返回。 */
export function back(nav: NavState): NavState {
  if (nav.layers.length > 0) return { ...nav, layers: nav.layers.slice(0, -1) };
  if (nav.pages.length > 1) return { ...nav, pages: nav.pages.slice(0, -1) };
  return nav;
}
