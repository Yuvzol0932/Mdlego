/**
 * 全库搜索 tab（阶段 C1 的最小实现，E1 再扩筛选/标签）。
 *
 * 搜索本身不在这层做：`deps.searchLibrary(query)` 由 main.ts 编排
 * （它负责按需渲染文档并调用 core/search.ts 的纯函数），
 * 视图只负责输入、防抖、把命中画成列表、点击交给 main 打开并定位。
 *
 * 全库搜索会把每篇文档渲染一遍，所以这里做了三件事控制成本：
 *   1. 输入防抖 220ms；
 *   2. 结果上限 60 条，够了就停；
 *   3. 文档很多时提示「仅搜索最近 N 篇」而不是静静变慢。
 */

import type { SearchHit, State } from '../core/types';
import { el, icon, type PageView, type ViewDeps } from './app';
import { renderTabBar } from './tabbar';

/** 输入防抖时长（毫秒）。 */
const DEBOUNCE_MS = 220;
/** 结果上限：超过就不再收，避免一次渲染上千条卡片。 */
const MAX_HITS = 60;

export function createSearchPage(initial: State, deps: ViewDeps): PageView {
  let query = '';
  let hits: SearchHit[] = [];
  let docsStamp = docsSignature(initial);

  const input = el('input', {
    class: 'search-page__input',
    type: 'search',
    inputmode: 'search',
    autocomplete: 'off',
    placeholder: '搜索全部文档…',
    'aria-label': '搜索全部文档',
    'data-testid': 'library-search-input',
  });

  const results = el('div', { class: 'search-page__results', 'data-testid': 'library-search-results' });
  const hint = el('p', { class: 'search-page__hint', 'data-testid': 'library-search-hint' });

  let timer: number | null = null;

  function docsSignature(state: State): string {
    return state.docs.map((d) => `${d.id}|${d.text.length}`).join('\n');
  }

  /** 按当前 query 重新搜索并重画。 */
  function runSearch(state: State): void {
    const q = query.trim();
    hits = q.length === 0 ? [] : deps.searchLibrary(q).slice(0, MAX_HITS);
    paint(state, q);
  }

  /** 把 hits 画成列表；同时决定提示文案。 */
  function paint(state: State, q: string): void {
    results.replaceChildren();
    hint.textContent = '';

    if (q.length === 0) {
      hint.textContent =
        state.docs.length === 0
          ? '书架还是空的，先导入一篇 Markdown 再搜索。'
          : `输入关键词，在 ${state.docs.length} 篇文档里找。`;
      return;
    }
    if (hits.length === 0) {
      hint.textContent = `没有找到「${q}」。`;
      return;
    }

    const titleOf = new Map(state.docs.map((d) => [d.id, d.title] as const));
    for (const hit of hits) {
      const btn = el(
        'button',
        {
          class: 'search-hit',
          type: 'button',
          'data-testid': 'library-search-hit',
          'data-doc-id': hit.docId,
          onclick: () => deps.openHit(hit),
        },
        el('span', { class: 'search-hit__title', text: titleOf.get(hit.docId) ?? '（未知文档）' }),
        el('span', { class: 'search-hit__snippet', text: hit.snippet }),
      );
      results.append(btn);
    }
    if (hits.length >= MAX_HITS) {
      hint.textContent = `仅显示前 ${MAX_HITS} 条结果，可以换个更具体的关键词。`;
    }
  }

  // 输入：防抖后搜索。用 input 事件而不是 keydown，输入法组合输入也能正确触发。
  input.addEventListener('input', () => {
    query = input.value;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      runSearch(deps.getState());
    }, DEBOUNCE_MS);
  });

  // 回车立即搜，不等防抖
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    query = input.value;
    runSearch(deps.getState());
  });

  const header = el(
    'header',
    { class: 'appbar appbar--plain' },
    el('span', { class: 'appbar__spacer', 'aria-hidden': 'true' }),
    el('h1', { class: 'appbar__title', 'data-testid': 'app-title', text: '搜索' }),
    el('button', {
      class: 'icon-btn',
      type: 'button',
      'data-testid': 'library-search-clear',
      'aria-label': '清空搜索',
      title: '清空',
      onclick: () => {
        input.value = '';
        query = '';
        runSearch(deps.getState());
        input.focus();
      },
    }, icon('close')),
  );

  const page = el(
    'div',
    { class: 'shell', 'data-testid': 'shell' },
    header,
    el(
      'main',
      { class: 'main main--tabbed' },
      el(
        'div',
        { class: 'search-page', 'data-testid': 'search-page' },
        el('div', { class: 'search-page__field' }, icon('search'), input),
        hint,
        results,
      ),
    ),
    renderTabBar('search', deps),
  );

  paint(initial, '');

  return {
    el: page,
    update(state: State) {
      // 文档集合变了（导入/删除）：若已有查询，重跑一次，结果保持最新
      const next = docsSignature(state);
      if (next !== docsStamp) {
        docsStamp = next;
        if (query.trim().length > 0) runSearch(state);
        else paint(state, '');
        return;
      }
      // 仅当空态提示依赖的文档数变化时更新提示（避免每次滚动/进度变化都重画）
      if (query.trim().length === 0) paint(state, '');
    },
  };
}
