// @vitest-environment jsdom
/**
 * 阶段 A 验收：局部更新与返回栈。
 *
 * 核心断言是「节点身份」—— 阅读页的 <article> 在滚动保存、勾选、开关浮层、
 * 改排版、进设置再返回这些操作里必须是同一个 DOM 节点（data-gen 不变），
 * 否则就等于整树重渲染，长按查词监听、选区、滚动位置都会丢。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderMarkdown } from '../core/markdown';
import { canGoBack, topPage } from '../core/nav';
import type { Doc, State, StateAction } from '../core/types';
import { DEFAULT_SETTINGS } from '../data/settings-store';
import { createInitialState, createStore, type Store } from '../state/store';
import { createAppHost, signaturePage, type ViewDeps } from './app';
import { createLayerHost } from './layers';
import { createReaderPage } from './reader';
import { renderSettings } from './settings';
import { createShelfPage } from './shelf';

const SOURCE = '# 标题\n\n第一段正文。\n\n- [ ] 买牛奶\n- [x] 写代码\n\n## 第二节\n\n第二段。\n';

function makeDoc(id: string): Doc {
  return {
    id,
    title: `文档 ${id}`,
    text: SOURCE,
    encoding: 'utf-8',
    source: { kind: 'inline' },
    fingerprint: null,
    importedAt: 1000,
    lastReadAt: null,
    progress: null,
  };
}

interface Rig {
  store: Store;
  root: HTMLElement;
  deps: ViewDeps;
  dispatch: (a: StateAction) => void;
  article: () => HTMLElement | null;
  gen: () => string | null;
}

function setup(): Rig {
  document.body.innerHTML = '<div data-testid="app-root"></div>';
  const root = document.querySelector<HTMLElement>('[data-testid="app-root"]') as HTMLElement;
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;

  const store = createStore({ ...createInitialState(DEFAULT_SETTINGS), docs: [makeDoc('a'), makeDoc('b')] });
  const dispatch = (a: StateAction): void => store.dispatch(a);
  const deps: ViewDeps = {
    dispatch,
    getState: () => store.getState(),
    requestImport: () => undefined,
    openToc: () => dispatch({ type: 'layer/opened', layer: 'toc' }),
    openSearch: () => dispatch({ type: 'layer/opened', layer: 'search' }),
    searchLibrary: () => [],
    openHit: () => undefined,
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
    importBackupClipboard: () => undefined, openWordbook: () => undefined, openEditor: () => undefined, saveEditedDoc: async () => "saved" as const, exportHtml: () => undefined, printDocument: () => undefined,
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

  const host = createAppHost(root, {
    isRestoringScroll: () => false,
    createPage: (page, state: State) => {
      if (page.kind === 'reader') return createReaderPage(state, deps);
      if (page.kind === 'editor') return createShelfPage(state, deps);
      if (page.tab === 'settings') {
        return signaturePage((s) => renderSettings(s, deps), (s) => JSON.stringify(s.settings), state);
      }
      return createShelfPage(state, deps);
    },
  });
  const layers = createLayerHost(root, {
    activeBid: () => null,
    pickToc: () => undefined,
    query: () => undefined,
    pickHit: () => undefined,
    menuSpec: () => null,
    imageSrc: () => null,
    tableElement: () => null,
    collectionSpec: () => null,
    coverDocId: () => null,
    pickCoverImage: async () => null,
    saveCover: () => undefined,
    addTag: () => undefined,
    removeTag: () => undefined,
    setFolder: () => undefined,
    noteDraft: () => null,
    noteSave: () => undefined,
    noteCancel: () => undefined,
    marksInput: () => null,
    marksRemove: () => undefined,
    marksJump: () => undefined,
    marksReanchor: () => undefined,
    marksExport: () => undefined,
    wordbookInput: () => null,
    wordbookRemove: () => undefined,
    wordbookClearWords: () => undefined,
    wordbookClearHistory: () => undefined,
    wordbookSwitchTab: () => undefined,
    dispatch: (action) => dispatch(action),
    motionLevel: () => 'full',
    close: (layer) => dispatch({ type: 'layer/closed', layer }),
  });
  store.subscribe((s) => {
    host.update(s);
    layers.sync(s);
  });
  host.update(store.getState());

  return {
    store,
    root,
    deps,
    dispatch,
    article: () => root.querySelector<HTMLElement>('[data-testid="article"]'),
    gen: () => root.querySelector('[data-testid="article"]')?.getAttribute('data-gen') ?? null,
  };
}

/** 打开文档（与 main.ts 的 openDoc 等价：先 opened 再 ready）。 */
function openDoc(rig: Rig, id: string): void {
  rig.dispatch({ type: 'doc/opened', docId: id });
  rig.dispatch({ type: 'reader/ready', render: renderMarkdown(makeDoc(id).text) });
}

let rig: Rig;
beforeEach(() => {
  rig = setup();
});

describe('A1 · 阅读页正文不被重建', () => {
  it('打开文档后正文只建一次', () => {
    openDoc(rig, 'a');
    expect(rig.article()?.querySelector('h1')?.textContent).toContain('标题');
    expect(rig.root.querySelectorAll('[data-testid="article"]')).toHaveLength(1);
  });

  it('保存阅读进度（doc/updated）不重建正文', () => {
    openDoc(rig, 'a');
    const before = rig.article();
    const doc = rig.store.getState().docs[0] as Doc;
    rig.dispatch({ type: 'doc/updated', doc: { ...doc, progress: { bid: 'p-1', ratio: 0.4 }, lastReadAt: 5 } });
    expect(rig.article()).toBe(before);
  });

  it('勾选任务不重建正文，且勾选状态落到 DOM 与状态树', () => {
    openDoc(rig, 'a');
    const before = rig.article();
    const box = before?.querySelector<HTMLInputElement>('.task-box[data-task-bid]');
    expect(box).not.toBeNull();
    const bid = box?.getAttribute('data-task-bid') ?? '';
    const was = box?.checked ?? false;
    if (box === null || box === undefined) return;
    box.checked = !was;
    box.dispatchEvent(new Event('change', { bubbles: true }));

    expect(rig.article()).toBe(before);
    const saved = rig.store.getState().tasks.find((t) => t.bid === bid);
    expect(saved?.checked).toBe(!was);
    expect(box.getAttribute('data-task-checked')).toBe(was ? '0' : '1');
  });

  it('打开/关闭目录与搜索浮层不重建正文', () => {
    openDoc(rig, 'a');
    const before = rig.article();
    rig.deps.openToc();
    expect(rig.root.querySelector('[data-testid="toc-drawer"]')).not.toBeNull();
    expect(rig.article()).toBe(before);
    rig.dispatch({ type: 'layer/closed', layer: 'toc' });
    expect(rig.root.querySelector('[data-testid="toc-drawer"]')).toBeNull();
    rig.deps.openSearch();
    expect(rig.root.querySelector('[data-testid="search-overlay"]')).not.toBeNull();
    rig.dispatch({ type: 'search/queried', query: '段', results: [] });
    rig.dispatch({ type: 'layer/closed', layer: 'search' });
    expect(rig.article()).toBe(before);
  });

  it('搜索结果更新不重建输入框（焦点不丢）', () => {
    openDoc(rig, 'a');
    rig.deps.openSearch();
    const input = rig.root.querySelector('[data-testid="search-input"]');
    rig.dispatch({ type: 'search/queried', query: '段', results: [{ docId: 'a', bid: 'p-1', start: 0, end: 1, snippet: '第一段' }] });
    expect(rig.root.querySelector('[data-testid="search-input"]')).toBe(input);
    expect(rig.root.querySelectorAll('[data-testid="search-hit"]')).toHaveLength(1);
  });

  it('改字号/字体/行距（只改 settings）不重建正文', () => {
    openDoc(rig, 'a');
    const before = rig.article();
    rig.dispatch({ type: 'settings/changed', patch: { typeScale: 4 } });
    rig.dispatch({ type: 'settings/changed', patch: { fontFamily: 'sans' } });
    expect(rig.article()).toBe(before);
  });

  it('进设置页再返回：正文还是同一个节点', () => {
    openDoc(rig, 'a');
    const before = rig.article();
    rig.dispatch({ type: 'nav/push', page: { kind: 'tab', tab: 'settings' } });
    expect(rig.article()).toBeNull(); // DOM 里只有设置页，不会出现重复 testid
    expect(rig.root.querySelector('[data-testid="settings-panel"]')).not.toBeNull();
    rig.dispatch({ type: 'nav/back' });
    expect(rig.article()).toBe(before);
  });

  it('关闭「长按查词」才会换节点（监听无法摘除）', () => {
    openDoc(rig, 'a');
    const before = rig.gen();
    rig.dispatch({ type: 'settings/changed', patch: { lookupEnabled: !DEFAULT_SETTINGS.lookupEnabled } });
    expect(rig.gen()).not.toBe(before);
  });

  it('换文档才重建', () => {
    openDoc(rig, 'a');
    const before = rig.article();
    rig.dispatch({ type: 'doc/closed' });
    openDoc(rig, 'b');
    expect(rig.article()).not.toBe(before);
  });
});

describe('A2 · 返回栈：多层浮层 + 返回', () => {
  it('书架 → 阅读 → 目录 → 查词，逐层返回', () => {
    openDoc(rig, 'a');
    rig.dispatch({ type: 'layer/opened', layer: 'toc' });
    rig.dispatch({ type: 'layer/opened', layer: 'lookup' });
    expect(rig.store.getState().nav.layers).toEqual(['toc', 'lookup']);

    rig.dispatch({ type: 'nav/back' });
    expect(rig.store.getState().nav.layers).toEqual(['toc']);
    expect(rig.root.querySelector('[data-testid="toc-drawer"]')).not.toBeNull();

    rig.dispatch({ type: 'nav/back' });
    expect(rig.root.querySelector('[data-testid="toc-drawer"]')).toBeNull();
    expect(rig.store.getState().currentDocId).toBe('a'); // 浮层都关了，页面还在

    rig.dispatch({ type: 'nav/back' });
    expect(rig.store.getState().currentDocId).toBeNull();
    expect(rig.root.querySelector('[data-testid="shelf"]')).not.toBeNull();
    expect(canGoBack(rig.store.getState().nav)).toBe(false); // 到底：下一次返回才是退出应用
  });

  it('阅读 → 设置 → 返回回到阅读页，而不是书架', () => {
    openDoc(rig, 'a');
    rig.dispatch({ type: 'nav/push', page: { kind: 'tab', tab: 'settings' } });
    rig.dispatch({ type: 'nav/back' });
    expect(topPage(rig.store.getState().nav)).toEqual({ kind: 'reader', docId: 'a' });
    expect(rig.article()).not.toBeNull();
  });

  it('设置页内的返回按钮与系统返回走同一条栈', () => {
    openDoc(rig, 'a');
    rig.dispatch({ type: 'nav/push', page: { kind: 'tab', tab: 'settings' } });
    rig.root.querySelector<HTMLElement>('[data-testid="back-home"]')?.click();
    expect(topPage(rig.store.getState().nav).kind).toBe('reader');
  });

  it('在设置页打开阅读相关浮层后切走：浮层不残留', () => {
    openDoc(rig, 'a');
    rig.dispatch({ type: 'layer/opened', layer: 'toc' });
    rig.dispatch({ type: 'nav/push', page: { kind: 'tab', tab: 'settings' } });
    expect(rig.root.querySelector('[data-testid="toc-drawer"]')).toBeNull();
    rig.dispatch({ type: 'nav/back' });
    expect(rig.root.querySelector('[data-testid="toc-drawer"]')).toBeNull();
  });
});

describe('A4 · 回归基线', () => {
  it('阅读进度：存进 doc 后重新打开仍在', () => {
    openDoc(rig, 'a');
    const doc = rig.store.getState().docs[0] as Doc;
    rig.dispatch({ type: 'doc/updated', doc: { ...doc, progress: { bid: 'p-1', ratio: 0.5 } } });
    rig.dispatch({ type: 'doc/closed' });
    openDoc(rig, 'a');
    expect(rig.store.getState().docs.find((d) => d.id === 'a')?.progress).toEqual({ bid: 'p-1', ratio: 0.5 });
  });

  it('任务勾选：关文档再打开，勾选状态仍然套在新正文上', () => {
    openDoc(rig, 'a');
    const box = rig.article()?.querySelector<HTMLInputElement>('.task-box[data-task-bid]');
    if (box === null || box === undefined) throw new Error('没有任务框');
    const bid = box.getAttribute('data-task-bid') ?? '';
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));

    rig.dispatch({ type: 'doc/closed' });
    openDoc(rig, 'a');
    const again = rig.article()?.querySelector<HTMLInputElement>(`.task-box[data-task-bid="${bid}"]`);
    expect(again?.checked).toBe(true);
  });
});

// 导入去重见 data/import.test.ts（「相同内容被标记为重复」「内容不同不算重复」）。
