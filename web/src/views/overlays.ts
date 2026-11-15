/**
 * 侧滑抽屉与浮层 —— 目录、单篇搜索。
 *
 * 都是纯展示 + 派发 intent，不做 IO。
 */

import type { RenderResult, SearchHit, State } from '../core/types';
import { el, icon, type ViewDeps } from './app';

/** 遮罩 + 抽屉容器。 */
function drawerShell(testId: string, title: string, close: () => void, body: Node): HTMLElement {
  const mask = el('div', {
    class: 'mask',
    'data-testid': `${testId}-mask`,
    onclick: close,
  });
  return el(
    'div',
    { class: 'drawer-root', 'data-testid': testId },
    mask,
    el(
      'aside',
      { class: 'drawer', role: 'dialog', 'aria-label': title },
      el(
        'header',
        { class: 'drawer__head' },
        el('h2', { class: 'drawer__title', text: title }),
        el('button', {
          class: 'icon-btn',
          type: 'button',
          'data-testid': `${testId}-close`,
          'aria-label': '关闭',
          title: '关闭',
          onclick: close,
        }, icon('close')),
      ),
      body,
    ),
  );
}

/** 目录抽屉。 */
export function renderTocDrawer(
  toc: RenderResult['toc'],
  activeBid: string | null,
  onPick: (bid: string) => void,
  close: () => void,
): HTMLElement {
  const list = el('nav', { class: 'toc', 'data-testid': 'toc-list' });

  if (toc.length === 0) {
    list.append(el('div', { class: 'drawer__empty', text: '这篇文档没有标题' }));
  } else {
    for (const entry of toc) {
      const active = entry.bid === activeBid;
      list.append(
        el('button', {
          class: active ? 'toc__item toc__item--active' : 'toc__item',
          type: 'button',
          'data-testid': 'toc-item',
          'data-bid': entry.bid,
          'data-level': String(entry.level),
          style: `padding-left: calc(var(--sp-4) + ${(entry.level - 1) * 28}px)`,
          onclick: () => onPick(entry.bid),
        }, el('span', { text: entry.text })),
      );
    }
  }

  return drawerShell('toc-drawer', '目录', close, list);
}

/** 搜索浮层。 */
export function renderSearchOverlay(
  state: State,
  deps: ViewDeps,
  onQuery: (query: string) => void,
  onPick: (hit: SearchHit) => void,
  close: () => void,
): HTMLElement {
  const input = el('input', {
    class: 'search__input',
    type: 'search',
    'data-testid': 'search-input',
    placeholder: '在这篇文档里查找',
    value: state.searchQuery,
    enterkeyhint: 'search',
  });

  const results = el('div', { class: 'search__results', 'data-testid': 'search-results' });
  const hits = state.searchResults;

  if (state.searchQuery.length === 0) {
    results.append(el('div', { class: 'drawer__empty', text: '输入关键词开始查找' }));
  } else if (hits.length === 0) {
    results.append(el('div', { class: 'drawer__empty', text: '没有找到匹配内容' }));
  } else {
    results.append(el('div', {
      class: 'search__count',
      'data-testid': 'search-count',
      text: `找到 ${hits.length} 处`,
    }));
    for (const hit of hits.slice(0, 200)) {
      results.append(
        el('button', {
          class: 'search__hit',
          type: 'button',
          'data-testid': 'search-hit',
          'data-bid': hit.bid,
          onclick: () => onPick(hit),
        }, el('span', { text: hit.snippet })),
      );
    }
  }

  let timer: number | null = null;
  input.addEventListener('input', () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => onQuery(input.value), 180);
  });

  const head = el(
    'header',
    { class: 'drawer__head' },
    input,
    el('button', {
      class: 'icon-btn',
      type: 'button',
      'data-testid': 'search-close',
      'aria-label': '关闭',
      title: '关闭',
      onclick: close,
    }, icon('close')),
  );

  return el(
    'div',
    { class: 'drawer-root', 'data-testid': 'search-overlay' },
    el('div', { class: 'mask', 'data-testid': 'search-mask', onclick: close }),
    el('div', { class: 'drawer drawer--top', role: 'dialog', 'aria-label': '搜索' }, head, results),
  );
}
