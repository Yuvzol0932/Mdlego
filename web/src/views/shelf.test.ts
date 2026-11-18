// @vitest-environment jsdom
/**
 * 书架页（阶段 C2）行为测试。
 *
 * 验的是「结构与交互契约」，不验像素：
 *   - 有文档时：横幅、继续阅读、网格卡片、底部导航齐全
 *   - 点卡片 → doc/opened；长按 → 进入多选（选择条出现、底部导航让位）
 *   - 更多菜单 → 排序/视图切换真的改了渲染结构
 *   - 空书架 → 诚实的空状态 + 导入入口
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderMarkdown } from '../core/markdown';
import type { Doc, State } from '../core/types';
import { DEFAULT_SETTINGS } from '../data/settings-store';
import { createInitialState, createStore } from '../state/store';
import type { ViewDeps } from './app';
import type { MenuSpec } from './menu';
import { createShelfPage } from './shelf';

const SOURCE = '# 标题\n\n第一段正文。\n\n- [ ] 买牛奶\n';

function makeDoc(id: string, overrides: Partial<Doc> = {}): Doc {
  return {
    id,
    title: `文档 ${id}`,
    text: SOURCE,
    encoding: 'utf-8',
    source: { kind: 'inline' },
    fingerprint: null,
    importedAt: 1000,
    lastReadAt: 2000,
    progress: null,
    ...overrides,
  };
}

interface Rig {
  page: ReturnType<typeof createShelfPage>;
  root: HTMLElement;
  menus: MenuSpec[];
  opened: string[];
  deleted: string[][];
  tagsOpened: string[][];
  foldersOpened: string[][];
  store: ReturnType<typeof createStore>;
  rerender: () => void;
}

function setup(docs: Doc[], options: { bookmarks?: string[] } = {}): Rig {
  const store = createStore({ ...createInitialState(DEFAULT_SETTINGS), docs });
  if (options.bookmarks !== undefined) {
    store.dispatch({ type: 'bookmarks/loaded', bookmarks: options.bookmarks });
  }
  const menus: MenuSpec[] = [];
  const opened: string[] = [];
  const deleted: string[][] = [];
  const tagsOpened: string[][] = [];
  const foldersOpened: string[][] = [];
  const deps: ViewDeps = {
    dispatch: (action) => {
      if (action.type === 'doc/opened') opened.push(action.docId);
      store.dispatch(action);
    },
    getState: () => store.getState(),
    requestImport: () => undefined,
    openToc: () => undefined,
    openSearch: () => undefined,
    searchLibrary: () => [],
    openHit: () => undefined,
    openMenu: (spec) => menus.push(spec),
    requestDelete: (ids) => deleted.push([...ids]),
    toggleBookmark: () => undefined,
    openImage: () => undefined,
    openTypeset: () => undefined,
    openTagEditor: (ids) => tagsOpened.push([...ids]),
    openFolderEditor: (ids) => foldersOpened.push([...ids]),
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
    toast: () => undefined,
    appVersion: 'test',
    buildId: 'test',
    sample: '',
    renderMarkdown,
  };
  const page = createShelfPage(store.getState() as State, deps);
  document.body.append(page.el);
  return {
    page,
    root: page.el,
    menus,
    opened,
    deleted,
    tagsOpened,
    foldersOpened,
    store,
    rerender: () => page.update(store.getState() as State),
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('书架 · 有文档', () => {
  it('横幅、继续阅读、网格卡片、底部导航齐全', () => {
    const rig = setup([
      makeDoc('a', { progress: { bid: 'p-1', ratio: 0.2, percent: 42 }, lastReadAt: 5000 }),
      makeDoc('b'),
    ]);
    expect(rig.root.querySelector('[data-testid="shelf-hero"]')).not.toBeNull();
    expect(rig.root.querySelectorAll('[data-testid="shelf-hero-quote"]')).toHaveLength(1);
    expect(rig.root.querySelector('[data-testid="shelf-hero-import"]')).not.toBeNull();
    expect(rig.root.querySelector('[data-testid="shelf-continue"]')).not.toBeNull();
    expect(rig.root.querySelector('[data-testid="continue-progress"]')).not.toBeNull();
    expect(rig.root.querySelectorAll('[data-testid="doc-item"]')).toHaveLength(2);
    expect(rig.root.querySelector('[data-testid="shelf-grid"]')?.className).toContain('shelf-grid');
    expect(rig.root.querySelector('[data-testid="tabbar"]')).not.toBeNull();
    expect(rig.root.querySelector('[data-testid="shelf-count"]')?.textContent).toContain('2 篇');
  });

  it('没有进度的文档不显示「继续阅读」，也不猜百分比', () => {
    const rig = setup([makeDoc('a')]);
    expect(rig.root.querySelector('[data-testid="shelf-continue"]')).toBeNull();
    expect(rig.root.querySelector('[data-testid="continue-progress"]')).toBeNull();
  });

  it('点卡片打开文档', () => {
    const rig = setup([makeDoc('a')]);
    rig.root.querySelector<HTMLButtonElement>('[data-testid="doc-item"]')?.click();
    expect(rig.opened).toEqual(['a']);
  });

  it('封面用 data-cover 指向令牌色板，首字写在封面上', () => {
    const rig = setup([makeDoc('a', { title: '技术写作指南' })]);
    const cover = rig.root.querySelector('[data-testid="doc-item"] .cover');
    expect(cover?.getAttribute('data-cover')).toMatch(/^[1-8]$/);
    expect(cover?.textContent).toContain('技');
  });
});

describe('书架 · 长按多选', () => {
  it('长按进入多选：选择条出现、卡片 aria-selected=true、底部导航让位', () => {
    vi.useFakeTimers();
    const rig = setup([makeDoc('a'), makeDoc('b')]);
    const card = rig.root.querySelector<HTMLElement>('[data-testid="doc-item"]');
    expect(card).not.toBeNull();
    card?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(500);
    expect(rig.root.querySelector('[data-testid="shelf-selectbar"]')?.hasAttribute('hidden')).toBe(false);
    expect(rig.root.classList.contains('shelf--selecting')).toBe(true);
    expect(card?.getAttribute('aria-selected')).toBe('true');
    expect(rig.root.querySelector('[data-testid="shelf-selectbar"] .shelf-selectbar__count')?.textContent).toContain('1');
  });

  it('多选里点卡片是勾选而不是打开；删除走确认框', () => {
    vi.useFakeTimers();
    const rig = setup([makeDoc('a'), makeDoc('b')]);
    const cards = [...rig.root.querySelectorAll<HTMLElement>('[data-testid="doc-item"]')];
    cards[0]?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    vi.advanceTimersByTime(500);
    cards[1]?.click();
    expect(rig.opened).toEqual([]);
    expect(rig.root.querySelector('[data-testid="shelf-selectbar"] .shelf-selectbar__count')?.textContent).toContain('2');

    rig.root.querySelector<HTMLButtonElement>('[data-testid="shelf-select-delete"]')?.click();
    expect(rig.menus).toHaveLength(1);
    expect(rig.menus[0]?.variant).toBe('dialog');
    expect(rig.menus[0]?.title).toContain('删除 2 篇');

    // 执行确认项：走 requestDelete，并退出选择模式
    const confirm = rig.menus[0]?.items.find((i) => i.id === 'shelf-delete-confirm');
    confirm?.onSelect();
    expect(rig.deleted).toEqual([['a', 'b']]);
    expect(rig.root.classList.contains('shelf--selecting')).toBe(false);
  });

  it('取消退出多选', () => {
    vi.useFakeTimers();
    const rig = setup([makeDoc('a')]);
    rig.root.querySelector<HTMLElement>('[data-testid="doc-item"]')?.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true }),
    );
    vi.advanceTimersByTime(500);
    rig.root.querySelector<HTMLButtonElement>('[data-testid="shelf-select-cancel"]')?.click();
    expect(rig.root.classList.contains('shelf--selecting')).toBe(false);
    expect(rig.root.querySelector('[data-testid="shelf-selectbar"]')?.hasAttribute('hidden')).toBe(true);
  });
});

describe('书架 · 更多菜单', () => {
  it('菜单里有排序与视图项，切列表视图后结构变化', () => {
    const rig = setup([makeDoc('a')]);
    rig.root.querySelector<HTMLButtonElement>('[data-testid="shelf-more"]')?.click();
    expect(rig.menus).toHaveLength(1);
    const spec = rig.menus[0] as MenuSpec;
    expect(spec.variant).toBe('popover');
    const ids = spec.items.map((i) => i.id);
    expect(ids).toContain('shelf-sort-name');
    expect(ids).toContain('shelf-view-list');
    expect(ids).toContain('shelf-menu-import');

    spec.items.find((i) => i.id === 'shelf-view-list')?.onSelect();
    expect(rig.root.querySelector('[data-testid="shelf-grid"]')?.className).toContain('shelf-list');
    expect(rig.root.querySelector('[data-testid="doc-item"]')?.className).toContain('book-row');
  });

  it('按名称排序真的改变顺序', () => {
    const rig = setup([makeDoc('a', { title: '乙文档' }), makeDoc('b', { title: '甲文档' })]);
    rig.root.querySelector<HTMLButtonElement>('[data-testid="shelf-more"]')?.click();
    (rig.menus[0] as MenuSpec).items.find((i) => i.id === 'shelf-sort-name')?.onSelect();
    const titles = [...rig.root.querySelectorAll('.book-card__title')].map((n) => n.textContent);
    expect(titles).toEqual(['甲文档', '乙文档']);
  });
});

describe('书架 · 空状态与更新', () => {
  it('空书架显示空状态与导入入口，且只有导入引导横幅', () => {
    const rig = setup([]);
    expect(rig.root.querySelector('[data-testid="shelf-empty"]')).not.toBeNull();
    expect(rig.root.querySelector('[data-testid="empty-import"]')).not.toBeNull();
    expect(rig.root.querySelectorAll('[data-testid="shelf-hero-quote"]')).toHaveLength(0);
    expect(rig.root.querySelector('[data-testid="shelf-hero-import"]')).not.toBeNull();
  });

  it('文档集合变化时重画内容（不重建页面根节点）', () => {
    const rig = setup([]);
    const shell = rig.root;
    rig.store.dispatch({ type: 'doc/imported', doc: makeDoc('a') });
    rig.rerender();
    expect(rig.root).toBe(shell);
    expect(rig.root.querySelector('[data-testid="shelf-empty"]')).toBeNull();
    expect(rig.root.querySelectorAll('[data-testid="doc-item"]')).toHaveLength(1);
  });
});

describe('书架 · 筛选 / 标签 / 文件夹（阶段 E1）', () => {
  it('筛选条渲染全部/收藏/标签/文件夹及数量', () => {
    const rig = setup(
      [
        makeDoc('a', { tags: ['考研'], folder: '课程' }),
        makeDoc('b', { tags: ['考研', '阅读'], folder: '项目' }),
        makeDoc('c'),
      ],
      { bookmarks: ['b'] },
    );
    expect(rig.root.querySelector('[data-testid="shelf-filters"]')).not.toBeNull();
    expect(rig.root.querySelector('[data-testid="shelf-filter-all"]')?.textContent).toContain('3');
    expect(rig.root.querySelector('[data-testid="shelf-filter-favorites"]')?.textContent).toContain('1');
    expect(rig.root.querySelector('[data-testid="shelf-filter-tag-0"]')?.textContent).toContain('#考研 2');
    expect(rig.root.querySelector('[data-testid="shelf-filter-folder-0"]')?.textContent).toContain('课程');
    expect(rig.root.querySelector('[data-testid="shelf-filter-tag-0"]')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('点标签 chip 只显示带该标签的文档；再点一次回到全部', () => {
    const rig = setup([makeDoc('a', { tags: ['考研'] }), makeDoc('b')]);
    rig.root.querySelector<HTMLElement>('[data-testid="shelf-filter-tag-0"]')?.click();
    expect(rig.root.querySelectorAll('[data-testid="doc-item"]')).toHaveLength(1);
    expect(rig.root.querySelector('[data-testid="shelf-filter-tag-0"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(rig.root.querySelector('[data-testid="shelf-count"]')?.textContent).toContain('筛选出 1 篇');
    rig.root.querySelector<HTMLElement>('[data-testid="shelf-filter-tag-0"]')?.click();
    expect(rig.root.querySelectorAll('[data-testid="doc-item"]')).toHaveLength(2);
  });

  it('收藏筛选只显示收藏文档', () => {
    const rig = setup([makeDoc('a'), makeDoc('b')], { bookmarks: ['a'] });
    rig.root.querySelector<HTMLElement>('[data-testid="shelf-filter-favorites"]')?.click();
    const cards = [...rig.root.querySelectorAll('[data-testid="doc-item"]')].map((c) => c.getAttribute('data-doc-id'));
    expect(cards).toEqual(['a']);
    expect(rig.root.querySelector('[data-testid="shelf-filter-empty"]')).toBeNull();
  });

  it('长按进入多选后，标签/文件夹按钮可用并回传选中 id', () => {
    vi.useFakeTimers();
    const rig = setup([makeDoc('a'), makeDoc('b')]);
    const card = rig.root.querySelector<HTMLElement>('[data-testid="doc-item"]');
    card?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
    vi.advanceTimersByTime(500);
    const tagBtn = rig.root.querySelector<HTMLElement>('[data-testid="shelf-select-tag"]');
    expect(tagBtn).not.toBeNull();
    expect(tagBtn?.hasAttribute('disabled')).toBe(false);
    tagBtn?.click();
    expect(rig.tagsOpened).toEqual([['a']]);
    rig.root.querySelector<HTMLElement>('[data-testid="shelf-select-folder"]')?.click();
    expect(rig.foldersOpened).toEqual([['a']]);
  });
});
