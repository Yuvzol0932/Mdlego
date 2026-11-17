// @vitest-environment jsdom
/**
 * 标签 / 文件夹面板测试（阶段 E1）。
 *
 * 面板只负责「把点击翻译成回调」，所有归一化与批量规则在 core/library.ts 里测；
 * 这里验：三态 chip、加/减标签回调、文件夹单选、输入校验、空态文案。
 */

import { describe, expect, it } from 'vitest';
import type { Doc, State } from '../core/types';
import { DEFAULT_SETTINGS } from '../data/settings-store';
import { createInitialState } from '../state/store';
import { createCollectionSheet, type CollectionSpec } from './collection';

function makeDoc(id: string, patch: Partial<Doc> = {}): Doc {
  return {
    id,
    title: id,
    text: '# ' + id,
    encoding: 'utf-8',
    source: { kind: 'inline' },
    fingerprint: null,
    importedAt: 1,
    lastReadAt: null,
    progress: null,
    ...patch,
  };
}

function setup(spec: CollectionSpec, docs: Doc[]) {
  const state = {
    ...createInitialState(DEFAULT_SETTINGS),
    docs,
  } as State;
  const calls: Array<[string, string | null]> = [];
  const sheet = createCollectionSheet(spec, state, {
    addTag: (tag) => calls.push(['add', tag]),
    removeTag: (tag) => calls.push(['remove', tag]),
    setFolder: (folder) => calls.push(['folder', folder]),
    close: () => calls.push(['close', null]),
  });
  document.body.append(sheet.el);
  return { sheet, calls, state };
}

describe('标签面板', () => {
  it('列出选中文档的标签，已全部有的显示选中态；点击「全有」→移除', () => {
    const docs = [makeDoc('a', { tags: ['考研'] }), makeDoc('b', { tags: ['考研', '阅读'] })];
    const { sheet, calls } = setup({ kind: 'tags', docIds: ['a', 'b'] }, docs);
    const chips = [...sheet.el.querySelectorAll<HTMLElement>('[data-testid="collection-tag-chip"]')];
    expect(chips.map((c) => c.getAttribute('data-tag'))).toEqual(['考研', '阅读']);
    const kaoyan = chips.find((c) => c.getAttribute('data-tag') === '考研');
    expect(kaoyan?.getAttribute('aria-pressed')).toBe('true');
    const reading = chips.find((c) => c.getAttribute('data-tag') === '阅读');
    expect(reading?.getAttribute('aria-pressed')).toBe('mixed'); // 部分文档有
    kaoyan?.click();
    expect(calls).toEqual([['remove', '考研']]);
    reading?.click();
    expect(calls.at(-1)).toEqual(['add', '阅读']);
  });

  it('输入框：合法标签可提交，空白时按钮禁用', () => {
    const { sheet, calls } = setup({ kind: 'tags', docIds: ['a'] }, [makeDoc('a')]);
    const input = sheet.el.querySelector<HTMLInputElement>('[data-testid="collection-input"]') as HTMLInputElement;
    const submit = sheet.el.querySelector<HTMLButtonElement>('[data-testid="collection-submit"]') as HTMLButtonElement;
    expect(submit.hasAttribute('disabled')).toBe(true);
    input.value = '   ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(submit.hasAttribute('disabled')).toBe(true);
    input.value = '  新标签  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(submit.hasAttribute('disabled')).toBe(false);
    submit.click();
    expect(calls).toEqual([['add', '新标签']]);
  });

  it('选中文档都没有标签时给出空态提示', () => {
    const { sheet } = setup({ kind: 'tags', docIds: ['a'] }, [makeDoc('a')]);
    expect(sheet.el.querySelector('[data-testid="collection-empty"]')?.hasAttribute('hidden')).toBe(false);
  });
});

describe('文件夹面板', () => {
  const docs = [makeDoc('a', { folder: '课程' }), makeDoc('b', { folder: '课程' }), makeDoc('c', { folder: '项目' })];
  const spec: CollectionSpec = { kind: 'folder', docIds: ['a', 'b'] };

  it('列出全部文件夹，当前共同文件夹为选中态；点击其他文件夹回传 setFolder', () => {
    const { sheet, calls } = setup(spec, docs);
    const chips = [...sheet.el.querySelectorAll<HTMLElement>('[data-testid="collection-folder-chip"]')];
    expect(chips.map((c) => c.getAttribute('data-folder'))).toEqual(['课程', '项目']);
    const current = chips.find((c) => c.getAttribute('data-folder') === '课程');
    expect(current?.getAttribute('aria-pressed')).toBe('true');
    chips.find((c) => c.getAttribute('data-folder') === '项目')?.click();
    expect(calls.at(-1)).toEqual(['folder', '项目']);
  });

  it('点已选中的文件夹取消归档；有「移出文件夹」按钮', () => {
    const { sheet, calls } = setup(spec, docs);
    const current = [...sheet.el.querySelectorAll<HTMLElement>('[data-testid="collection-folder-chip"]')]
      .find((c) => c.getAttribute('data-folder') === '课程');
    current?.click();
    expect(calls.at(-1)).toEqual(['folder', null]);
    const clear = sheet.el.querySelector<HTMLButtonElement>('[data-testid="collection-folder-clear"]') as HTMLButtonElement;
    expect(clear.hidden).toBe(false);
    clear.click();
    expect(calls.at(-1)).toEqual(['folder', null]);
  });

  it('标签模式下「移出文件夹」按钮隐藏', () => {
    const { sheet } = setup({ kind: 'tags', docIds: ['a'] }, [makeDoc('a')]);
    const clear = sheet.el.querySelector<HTMLButtonElement>('[data-testid="collection-folder-clear"]') as HTMLButtonElement;
    expect(clear.hidden).toBe(true);
  });
});
