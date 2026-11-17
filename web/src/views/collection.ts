/**
 * 标签 / 文件夹编辑面板（阶段 E1）—— 浮层的一种（LayerKind 'collection'）。
 *
 * 只做两件事：
 *   - 标签：列出选中文档已有标签（三态：全有/部分/没有），点一下加或减；输入框新建
 *   - 文件夹：列出全部文件夹（单选），点一下移入；「移出文件夹」
 *
 * 变更**立即生效**（每次点击就调 handlers，main 落库并更新 state），
 * 面板本身在 state 变化时重建 chip 的选中态，不需要「保存」按钮。
 * 只画 DOM，所有规则（归一化/三态/批量变更）来自 core/library.ts。
 */

import {
  collectFacets,
  folderOf,
  normalizeFolder,
  normalizeTag,
  tagsAmongDocs,
  tagsOf,
  tagSelectionState,
  type FacetCount,
} from '../core/library';
import type { Doc, State } from '../core/types';
import { el, icon } from './app';

export interface CollectionSpec {
  readonly kind: 'tags' | 'folder';
  readonly docIds: readonly string[];
}

export interface CollectionHandlers {
  addTag: (tag: string) => void;
  removeTag: (tag: string) => void;
  setFolder: (folder: string | null) => void;
  close: () => void;
}

export interface CollectionSheet {
  readonly el: HTMLElement;
  update(state: State): void;
}

/** 面板主体（不含遮罩/关闭按钮；那部分由 layers.ts 包装）。 */
export function createCollectionSheet(
  spec: CollectionSpec,
  initial: State,
  handlers: CollectionHandlers,
): CollectionSheet {
  const chips = el('div', { class: 'collection-chips', 'data-testid': 'collection-chips' });
  const empty = el('p', { class: 'collection-empty', 'data-testid': 'collection-empty', hidden: '' });
  const input = el('input', {
    class: 'collection-input',
    type: 'text',
    maxlength: '24',
    autocomplete: 'off',
    'data-testid': 'collection-input',
    'aria-label': spec.kind === 'tags' ? '新建标签' : '新建文件夹',
    placeholder: spec.kind === 'tags' ? '输入新标签，回车添加' : '输入新文件夹名，回车创建',
  });
  const submit = el('button', {
    class: 'ui-btn ui-press',
    type: 'button',
    'data-testid': 'collection-submit',
    text: spec.kind === 'tags' ? '添加' : '新建',
  });
  const clearFolder = el('button', {
    class: 'ui-btn ui-btn--ghost ui-press',
    type: 'button',
    'data-testid': 'collection-folder-clear',
    text: '移出文件夹',
  });
  clearFolder.hidden = spec.kind !== 'folder';

  const panel = el(
    'section',
    { class: 'sheet-panel glass', 'data-testid': 'collection-sheet', role: 'dialog', 'aria-label': spec.kind === 'tags' ? '标签' : '文件夹' },
    el('span', { class: 'sheet-panel__handle', 'aria-hidden': 'true' }),
    el(
      'header',
      { class: 'sheet-panel__head' },
      el('h2', { class: 'sheet-panel__title', text: spec.kind === 'tags' ? '标签' : '文件夹' }),
      el('span', { class: 'sheet-panel__hint', 'data-testid': 'collection-count', text: '' }),
    ),
    chips,
    empty,
    el('div', { class: 'collection-form' }, input, submit, clearFolder),
  );

  /** 提交输入框里的名字（标签/文件夹共用；非法输入直接不提交）。 */
  function submitInput(): void {
    const raw = input.value;
    if (spec.kind === 'tags') {
      const tag = normalizeTag(raw);
      if (tag === null) return;
      handlers.addTag(tag);
    } else {
      const folder = normalizeFolder(raw);
      if (folder === null) return;
      handlers.setFolder(folder);
    }
    input.value = '';
    syncSubmit();
  }

  /** 输入合法才允许提交（空白/超长时按钮禁用，给明确反馈而不是静默失败）。 */
  function syncSubmit(): void {
    const valid = spec.kind === 'tags' ? normalizeTag(input.value) !== null : normalizeFolder(input.value) !== null;
    if (valid) submit.removeAttribute('disabled');
    else submit.setAttribute('disabled', '');
  }

  input.addEventListener('input', syncSubmit);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submitInput();
  });
  submit.addEventListener('click', () => submitInput());
  clearFolder.addEventListener('click', () => handlers.setFolder(null));
  syncSubmit();

  /** 画 chip：标签用三态，文件夹用单选。 */
  function paintChips(state: State): void {
    const targets = state.docs.filter((d) => spec.docIds.includes(d.id));
    chips.replaceChildren();
    empty.hidden = true;
    empty.textContent = '';

    if (spec.kind === 'tags') {
      const candidates = tagsAmongDocs(targets);
      if (candidates.length === 0) {
        empty.hidden = false;
        empty.textContent = '选中的文档还没有标签，在下面输入一个新标签。';
        return;
      }
      for (const candidate of candidates) chips.append(tagChip(candidate, targets));
      return;
    }

    const folders: readonly FacetCount[] = collectFacets(state.docs, state.bookmarks).folders;
    if (folders.length === 0) {
      empty.hidden = false;
      empty.textContent = '还没有文件夹，在下面输入一个名字创建。';
      return;
    }
    const current = sharedFolder(targets);
    for (const candidate of folders) {
      chips.append(folderChip(candidate, current));
    }
  }

  /** 选中文档共同的文件夹（不一致返回 undefined，表示「未选中」）。 */
  function sharedFolder(targets: readonly Doc[]): string | null | undefined {
    if (targets.length === 0) return undefined;
    const first = folderOf(targets[0] as Doc);
    for (const doc of targets) if (folderOf(doc) !== first) return undefined;
    return first;
  }

  function tagChip(candidate: FacetCount, targets: readonly Doc[]): HTMLElement {
    const state = tagSelectionState(targets, candidate.value);
    const btn = el('button', {
      class: `collection-chip${state === 'all' ? ' collection-chip--on' : state === 'some' ? ' collection-chip--partial' : ''}`,
      type: 'button',
      'data-testid': 'collection-tag-chip',
      'data-tag': candidate.value,
      'aria-pressed': state === 'all' ? 'true' : state === 'some' ? 'mixed' : 'false',
    }, icon(state === 'all' ? 'check' : 'bookmark'), el('span', { text: candidate.value }));
    btn.addEventListener('click', () => {
      if (state === 'all') handlers.removeTag(candidate.value);
      else handlers.addTag(candidate.value);
    });
    return btn;
  }

  function folderChip(candidate: FacetCount, current: string | null | undefined): HTMLElement {
    const on = current === candidate.value;
    const btn = el('button', {
      class: `collection-chip${on ? ' collection-chip--on' : ''}`,
      type: 'button',
      'data-testid': 'collection-folder-chip',
      'data-folder': candidate.value,
      'aria-pressed': on ? 'true' : 'false',
    }, icon(on ? 'check' : 'shelf'), el('span', { text: candidate.value }));
    btn.addEventListener('click', () => {
      if (on) handlers.setFolder(null);
      else handlers.setFolder(candidate.value);
    });
    return btn;
  }

  paintChips(initial);
  return {
    el: panel,
    update(state: State) {
      paintChips(state);
      const count = state.docs.filter((d) => spec.docIds.includes(d.id)).length;
      const countEl = panel.querySelector<HTMLElement>('[data-testid="collection-count"]');
      if (countEl !== null) countEl.textContent = `已选 ${count} 篇`;
    },
  };
}

/** 收集选中文档的标签集合（供测试/诊断用，不参与渲染）。 */
export function tagsForDocs(state: State, docIds: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const doc of state.docs) {
    if (!docIds.includes(doc.id)) continue;
    for (const tag of tagsOf(doc)) out.add(tag);
  }
  return [...out];
}
