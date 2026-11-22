// @vitest-environment jsdom
/**
 * 全库搜索 tab 视图测试（阶段 E1 增强）。
 *
 * 验的是分组/高亮/范围筛选与「不伪造」：
 *   - 命中按文档分组，标题与命中数正确，关键词渲染成 <mark>
 *   - 同一篇文档只展示前 3 条，其余概括成「还有 N 处」
 *   - 仅收藏范围只保留收藏文档的命中；没有收藏时显示明确文案
 *   - 空查询/无结果显示诚实提示，不画空卡片
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderMarkdown } from '../core/markdown';
import type { Doc, SearchHit, State } from '../core/types';
import { DEFAULT_SETTINGS } from '../data/settings-store';
import { createInitialState, createStore } from '../state/store';
import type { ViewDeps } from './app';
import { createSearchPage } from './search';

function makeDoc(id: string, title: string): Doc {
  return {
    id,
    title,
    text: `# ${title}`,
    encoding: 'utf-8',
    source: { kind: 'inline' },
    fingerprint: null,
    importedAt: 1,
    lastReadAt: null,
    progress: null,
  };
}

function hit(docId: string, snippet: string, start = 0): SearchHit {
  return { docId, bid: 'b1', start, end: start + 2, snippet };
}

interface Rig {
  root: HTMLElement;
  input: HTMLInputElement;
  hits: SearchHit[];
  opened: SearchHit[];
  rerender: () => void;
}

function setup(options: {
  docs: Doc[];
  hits: SearchHit[];
  bookmarks?: string[];
}): Rig {
  const store = createStore({ ...createInitialState(DEFAULT_SETTINGS), docs: options.docs });
  if (options.bookmarks !== undefined) {
    store.dispatch({ type: 'bookmarks/loaded', bookmarks: options.bookmarks });
  }
  const hitsRef = { current: options.hits };
  const opened: SearchHit[] = [];
  const deps: ViewDeps = {
    dispatch: (action) => store.dispatch(action),
    getState: () => store.getState(),
    requestImport: () => undefined,
    openToc: () => undefined,
    openSearch: () => undefined,
    searchLibrary: (q) => (q.trim().length === 0 ? [] : hitsRef.current),
    openHit: (h) => opened.push(h),
    openMenu: () => undefined,
    requestDelete: () => undefined,
    toggleBookmark: () => undefined,
    openImage: () => undefined,
    openTable: () => undefined,
    openTypeset: () => undefined,
    openTagEditor: () => undefined,
    openFolderEditor: () => undefined,
    openCoverEditor: () => undefined,
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
    openWordbook: () => undefined,
    openEditor: () => undefined,
    saveEditedDoc: async () => 'saved' as const,
    exportHtml: () => undefined,
    printDocument: () => undefined,
    reanchorSelection: () => undefined,
    pickBanner: () => undefined,
    clearBanner: () => undefined,
    clearStats: () => undefined,
    exportDiagnostics: () => undefined,
    clearDiagnostics: () => undefined,
    diagnosticsCount: () => 0,
    checkUpdate: async () => undefined,
    toast: () => undefined,
    appVersion: 'test',
    buildId: 'test',
    sample: '',
    renderMarkdown,
  };
  const page = createSearchPage(store.getState() as State, deps);
  document.body.append(page.el);
  return {
    root: page.el,
    input: page.el.querySelector<HTMLInputElement>('[data-testid="library-search-input"]') as HTMLInputElement,
    hits: options.hits,
    opened,
    rerender: () => page.update(store.getState() as State),
  };
}

function type(rig: Rig, value: string): void {
  rig.input.value = value;
  rig.input.dispatchEvent(new Event('input', { bubbles: true }));
  vi.advanceTimersByTime(300);
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const DOCS = [makeDoc('a', 'Markdown 进阶'), makeDoc('b', '写作指南'), makeDoc('c', '未收藏文档')];
const HITS = [
  hit('a', '…把 Markdown 写成长期资产…'),
  hit('a', '…Markdown 的分层规则…'),
  hit('a', '…Markdown 表格…'),
  hit('a', '…Markdown 代码块…'),
  hit('b', '…Markdown 是纯文本…'),
  hit('c', '…Markdown 也可以…'),
];

describe('搜索分组与高亮', () => {
  it('按文档分组，显示标题与命中数，关键词渲染为 mark', () => {
    const rig = setup({ docs: DOCS, hits: HITS });
    type(rig, 'Markdown');
    const groups = rig.root.querySelectorAll('[data-testid="library-search-group"]');
    expect(groups).toHaveLength(3);
    expect(groups[0]?.querySelector('[data-testid="library-search-group-head"]')?.textContent).toContain('Markdown 进阶');
    expect(groups[0]?.querySelector('[data-testid="library-search-group-head"]')?.textContent).toContain('4 处');
    expect(rig.root.querySelectorAll('mark').length).toBeGreaterThan(3);
    expect(rig.root.querySelector('[data-testid="library-search-hint"]')?.textContent).toContain('在 3 篇文档里找到 6 处');
  });

  it('同一文档最多展示 3 条，其余概括成「还有 N 处」', () => {
    const rig = setup({ docs: DOCS, hits: HITS });
    type(rig, 'Markdown');
    const firstGroup = rig.root.querySelector('[data-testid="library-search-group"]');
    expect(firstGroup?.querySelectorAll('[data-testid="library-search-hit"]').length).toBe(3);
    expect(firstGroup?.querySelector('[data-testid="library-search-group-more"]')?.textContent).toContain('还有 1 处');
  });

  it('点片段把命中交给 main（openHit）', () => {
    const rig = setup({ docs: DOCS, hits: [hit('b', '…Markdown 是纯文本…')] });
    type(rig, 'markdown');
    rig.root.querySelector<HTMLElement>('[data-testid="library-search-hit"]')?.click();
    expect(rig.opened).toHaveLength(1);
    expect(rig.opened[0]?.docId).toBe('b');
  });
});

describe('范围筛选（全部 / 仅收藏）', () => {
  it('仅收藏只保留收藏文档的命中', () => {
    const rig = setup({ docs: DOCS, hits: HITS, bookmarks: ['b'] });
    type(rig, 'Markdown');
    rig.root.querySelector<HTMLElement>('[data-testid="search-scope-favorites"]')?.click();
    const groups = rig.root.querySelectorAll('[data-testid="library-search-group"]');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.getAttribute('data-doc-id')).toBe('b');
    expect(rig.root.querySelector('[data-testid="search-scope-favorites"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('收藏里没有命中时给出明确文案，不画空分组', () => {
    const rig = setup({ docs: DOCS, hits: HITS, bookmarks: ['zzz'] });
    type(rig, 'Markdown');
    rig.root.querySelector<HTMLElement>('[data-testid="search-scope-favorites"]')?.click();
    expect(rig.root.querySelectorAll('[data-testid="library-search-group"]')).toHaveLength(0);
    expect(rig.root.querySelector('[data-testid="library-search-hint"]')?.textContent).toContain('收藏里没有找到');
  });
});

describe('空状态', () => {
  it('空查询提示文档数；无结果提示关键词', () => {
    const rig = setup({ docs: DOCS, hits: [] });
    expect(rig.root.querySelector('.search-empty__title')?.textContent).toContain('在 3 篇文档中检索');
    type(rig, '不存在的词');
    expect(rig.root.querySelector('[data-testid="library-search-hint"]')?.textContent).toContain('没有找到');
    expect(rig.root.querySelectorAll('[data-testid="library-search-group"]')).toHaveLength(0);
  });
});
