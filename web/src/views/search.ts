/**
 * 全库搜索 tab（阶段 C1 骨架 → 阶段 E1 增强）。
 *
 * 搜索本身不在这层做：`deps.searchLibrary(query)` 由 main.ts 编排
 * （按需渲染文档 + core/search.ts 的纯函数），视图只负责输入、防抖、
 * 分组显示、关键词高亮、范围筛选（全部 / 仅收藏），点击交给 main 打开并定位。
 *
 * 成本控制（沿用 C1）：输入防抖 220ms；结果上限 60 条；命中很多时明确提示。
 */

import { groupHitsByDoc, highlightSegments, type SearchGroup } from '../core/search';
import type { SearchHit, State } from '../core/types';
import { el, icon, type PageView, type ViewDeps } from './app';
import { renderTabBar } from './tabbar';

/** 输入防抖时长（毫秒）。 */
const DEBOUNCE_MS = 220;
/** 展示上限：超过就不再收，避免一次渲染上千条。 */
const MAX_HITS = 60;
/** 每篇文档最多展示几条片段（其余用「还有 N 处」概括）。 */
const PER_DOC = 3;

type Scope = 'all' | 'favorites';

export function createSearchPage(initial: State, deps: ViewDeps): PageView {
  let query = '';
  let scope: Scope = 'all';
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
  const scopes = el('div', { class: 'search-page__scopes', 'data-testid': 'library-search-scopes', role: 'group', 'aria-label': '搜索范围' });

  let timer: number | null = null;

  function docsSignature(state: State): string {
    return state.docs.map((d) => `${d.id}|${d.text.length}`).join('\n');
  }

  /** 收藏 id 集合（范围筛选用）。 */
  function favoriteSet(state: State): Set<string> {
    return new Set(state.bookmarks);
  }

  /** 按当前 query / scope 重新搜索并重画。 */
  function runSearch(state: State): void {
    const q = query.trim();
    if (q.length === 0) {
      hits = [];
      paint(state, q);
      return;
    }
    const raw = deps.searchLibrary(q);
    const favorites = scope === 'favorites' ? favoriteSet(state) : null;
    hits = raw
      .filter((hit) => favorites === null || favorites.has(hit.docId))
      .slice(0, MAX_HITS);
    paint(state, q);
  }

  /** 范围 chip：全部文档 / 仅收藏（显示收藏数）。 */
  function paintScopes(state: State): void {
    const favorites = state.bookmarks.filter((id) => state.docs.some((d) => d.id === id)).length;
    const items: Array<{ scope: Scope; label: string; count: number; testId: string }> = [
      { scope: 'all', label: '全部文档', count: state.docs.length, testId: 'search-scope-all' },
      { scope: 'favorites', label: '仅收藏', count: favorites, testId: 'search-scope-favorites' },
    ];
    scopes.replaceChildren();
    for (const item of items) {
      const on = scope === item.scope;
      const chip = el('button', {
        class: on ? 'search-scope search-scope--on ui-press' : 'search-scope ui-press',
        type: 'button',
        'data-testid': item.testId,
        'aria-pressed': on ? 'true' : 'false',
        text: `${item.label} ${item.count}`,
      });
      chip.addEventListener('click', () => {
        if (scope === item.scope) return;
        scope = item.scope;
        paintScopes(deps.getState());
        runSearch(deps.getState());
      });
      scopes.append(chip);
    }
  }

  /** 把命中画成分组列表，并决定提示文案。 */
  function paint(state: State, q: string): void {
    results.replaceChildren();
    hint.textContent = '';
    paintScopes(state);

    if (q.length === 0) {
      results.append(
        el(
          'div',
          { class: 'search-empty' },
          el('div', { class: 'search-empty__mark', 'aria-hidden': 'true' }, icon('search')),
          el('p', {
            class: 'search-empty__title',
            text: state.docs.length === 0 ? '书架还是空的' : `在 ${state.docs.length} 篇文档中检索`,
          }),
          el('p', {
            class: 'search-empty__desc',
            text: state.docs.length === 0 ? '先导入一篇 Markdown 文档，即可全文检索。' : '支持按标题、正文关键词与收藏范围筛选。',
          }),
        ),
      );
      return;
    }

    const groups = groupHitsByDoc(hits, state.docs, PER_DOC);
    if (groups.length === 0) {
      hint.textContent =
        scope === 'favorites' ? `收藏里没有找到「${q}」。` : `没有找到「${q}」。`;
      return;
    }

    const totalHits = groups.reduce((sum, group) => sum + group.count, 0);
    hint.textContent = `在 ${groups.length} 篇文档里找到 ${totalHits} 处`;
    for (const group of groups) results.append(groupBlock(group, q));

    if (hits.length >= MAX_HITS) {
      hint.textContent += `（仅显示前 ${MAX_HITS} 处，可以换个更具体的关键词）`;
    }
  }

  /** 一篇文档一个分组：标题 + 命中数 + 最多 3 条高亮片段。 */
  function groupBlock(group: SearchGroup, q: string): HTMLElement {
    const block = el('section', {
      class: 'search-group',
      'data-testid': 'library-search-group',
      'data-doc-id': group.docId,
    });
    const head = el(
      'button',
      {
        class: 'search-group__head ui-press',
        type: 'button',
        'data-testid': 'library-search-group-head',
        'aria-label': `打开《${group.title}》的第一处命中`,
      },
      el('span', { class: 'search-group__title', text: group.title }),
      el('span', { class: 'search-group__count', text: `${group.count} 处` }),
      el('span', { class: 'search-group__chevron', 'aria-hidden': 'true' }, icon('chevron')),
    );
    const first = group.hits[0];
    if (first !== undefined) head.addEventListener('click', () => deps.openHit(first));
    block.append(head);

    for (const hit of group.hits) {
      const snippet = el('button', {
        class: 'search-hit',
        type: 'button',
        'data-testid': 'library-search-hit',
        'data-doc-id': hit.docId,
      });
      for (const segment of highlightSegments(hit.snippet, q)) {
        if (segment.hit) snippet.append(el('mark', { text: segment.text }));
        else snippet.append(document.createTextNode(segment.text));
      }
      snippet.addEventListener('click', () => deps.openHit(hit));
      block.append(snippet);
    }

    if (group.count > group.hits.length) {
      const rest = group.count - group.hits.length;
      const more = el('button', {
        class: 'search-group__more',
        type: 'button',
        'data-testid': 'library-search-group-more',
        text: `还有 ${rest} 处，打开文档继续搜索`,
      });
      more.addEventListener('click', () => deps.openHit(group.hits[0] as SearchHit));
      block.append(more);
    }
    return block;
  }

  const clearBtn = el(
    'button',
    {
      class: 'search-page__clear',
      type: 'button',
      'data-testid': 'library-search-clear',
      'aria-label': '清空搜索',
      title: '清空',
      hidden: '',
      onclick: () => {
        input.value = '';
        query = '';
        clearBtn.setAttribute('hidden', '');
        runSearch(deps.getState());
        input.focus();
      },
    },
    icon('close'),
  );

  // 输入：防抖后搜索。用 input 事件而不是 keydown，输入法组合输入也能正确触发。
  input.addEventListener('input', () => {
    query = input.value;
    if (query.length > 0) clearBtn.removeAttribute('hidden');
    else clearBtn.setAttribute('hidden', '');
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
    el('span', { class: 'appbar__spacer', 'aria-hidden': 'true' }),
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
        el('div', { class: 'search-page__field' }, icon('search'), input, clearBtn),
        scopes,
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
      // 收藏变化或空态提示依赖的数据变化时刷新（查询为空时只刷新提示与范围计数）
      if (query.trim().length === 0) paint(state, '');
      else paintScopes(state);
    },
  };
}
