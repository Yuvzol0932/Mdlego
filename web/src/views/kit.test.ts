// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { renderMarkdown } from '../core/markdown';
import { ACCENTS } from '../core/theme';
import type { StateAction } from '../core/types';
import { DEFAULT_SETTINGS } from '../data/settings-store';
import { createInitialState, createStore } from '../state/store';
import { icon, type ViewDeps } from './app';
import { ICON_PATHS, spriteMarkup } from './icons';
import { renderKit } from './kit';
import { renderSettings } from './settings';

function rig() {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, addEventListener: () => undefined, removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  const store = createStore(createInitialState(DEFAULT_SETTINGS));
  const dispatch = (a: StateAction): void => store.dispatch(a);
  const deps: ViewDeps = {
    dispatch, getState: () => store.getState(), requestImport: () => undefined,
    openToc: () => undefined, openSearch: () => undefined,
    searchLibrary: () => [], openHit: () => undefined,
    openMenu: () => undefined, requestDelete: () => undefined,
    toggleBookmark: () => undefined, openImage: () => undefined, openTypeset: () => undefined, openTagEditor: () => undefined, openFolderEditor: () => undefined, openCoverEditor: () => undefined, addSelectionMark: () => undefined, openNoteForSelection: () => undefined, openNoteForMark: () => undefined, removeMark: () => undefined, openMarks: () => undefined, copyText: () => undefined, lookupWord: () => undefined, isReanchorPending: () => false, exportBackup: () => undefined, importBackupFile: () => undefined, importBackupClipboard: () => undefined, openWordbook: () => undefined, openEditor: () => undefined, saveEditedDoc: async () => "saved" as const, exportHtml: () => undefined, printDocument: () => undefined, reanchorSelection: () => undefined, pickBanner: () => undefined, clearBanner: () => undefined, clearStats: () => undefined,
    exportDiagnostics: () => undefined,
    clearDiagnostics: () => undefined,
    diagnosticsCount: () => 0, checkUpdate: async () => undefined, toast: () => undefined,
    appVersion: 't', buildId: 't', sample: '', renderMarkdown,
  };
  return { store, deps };
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('图标精灵', () => {
  it('每个图标都有 symbol，且只注入一次', () => {
    const markup = spriteMarkup();
    for (const name of Object.keys(ICON_PATHS)) expect(markup).toContain(`id="i-${name}"`);
    icon('back'); icon('search');
    expect(document.querySelectorAll('#mdlego-sprite')).toHaveLength(1);
  });
  it('icon() 用 <use> 引用精灵，不内联路径', () => {
    const svg = icon('book');
    expect(svg.querySelector('use')?.getAttribute('href')).toBe('#i-book');
    expect(svg.querySelector('path')).toBeNull();
  });
});

describe('组件展示页', () => {
  it('渲染所有主题、8 个强调色、三档材质', () => {
    const { store, deps } = rig();
    const kit = renderKit(store.getState(), deps);
    document.body.append(kit);
    for (const t of ['system', 'warm-night', 'warm-paper', 'forest', 'slate', 'magazine', 'night', 'paper']) {
      expect(kit.querySelector(`[data-testid="kit-theme-${t}"]`)).not.toBeNull();
    }
    for (const a of ACCENTS) expect(kit.querySelector(`[data-testid="accent-${a}"]`)).not.toBeNull();
    for (const m of ['glass', 'soft', 'solid']) expect(kit.querySelector(`[data-testid="kit-material-${m}"]`)).not.toBeNull();
  });

  it('点主题/强调色/材质 → 派发设置变更', () => {
    const { store, deps } = rig();
    const kit = renderKit(store.getState(), deps);
    document.body.append(kit);
    kit.querySelector<HTMLElement>('[data-testid="kit-theme-forest"]')?.click();
    kit.querySelector<HTMLElement>('[data-testid="accent-jade"]')?.click();
    kit.querySelector<HTMLElement>('[data-testid="kit-material-solid"]')?.click();
    expect(store.getState().settings).toMatchObject({ theme: 'forest', accent: 'jade', material: 'solid' });
  });

  it('色块不含任何内联色值（颜色全部由令牌解析）', () => {
    const { store, deps } = rig();
    const html = renderKit(store.getState(), deps).outerHTML;
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/rgb\(/);
  });
});

describe('设置页外观区', () => {
  it('展示精简后的 6 套高区分度主题，并保留材质与玻璃强度控件', () => {
    const { store, deps } = rig();
    const page = renderSettings(store.getState(), deps);
    for (const id of ['theme-system', 'theme-warm-night', 'theme-warm-paper', 'theme-forest', 'theme-slate', 'theme-paper', 'material-glass', 'glass-level']) {
      expect(page.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    }
    expect(page.querySelector('[data-testid="theme-night"]')).toBeNull();
    expect(page.querySelector('[data-testid="theme-magazine"]')).toBeNull();
  });
  it('点主题立刻改状态（即时预览走根节点属性，不需要刷新）', () => {
    const { store, deps } = rig();
    renderSettings(store.getState(), deps).querySelector<HTMLElement>('[data-testid="theme-forest"]')?.click();
    expect(store.getState().settings.theme).toBe('forest');
  });

  it('关于区展示检查更新按钮与自动检查开关，开关切换即时更新设置', () => {
    const { store, deps } = rig();
    const page = renderSettings(store.getState(), deps);
    const btn = page.querySelector<HTMLButtonElement>('[data-testid="check-update-btn"]');
    const sw = page.querySelector<HTMLButtonElement>('[data-testid="auto-check-update-switch"]');
    expect(btn).not.toBeNull();
    expect(sw).not.toBeNull();
    expect(store.getState().settings.autoCheckUpdate).toBe(true);
    sw?.click();
    expect(store.getState().settings.autoCheckUpdate).toBe(false);
  });
});
