/**
 * 轻量编辑器（阶段 E5）。
 *
 * 布局：顶栏（返回 / 标题 / 保存）+ 分段（编辑 | 预览）+ 正文编辑区 / 预览区。
 * 预览用 `deps.renderMarkdown`（与阅读页同一个渲染器），输入防抖 180ms 更新。
 *
 * 保存不在视图里做：`deps.saveEditedDoc` 返回明确结果，
 * 冲突/无原文件时由本视图弹确认（覆盖 / 另存为副本），不静默覆盖用户原文件。
 */

import type { Doc, State } from '../core/types';
import { isTextChanged, titleFromText } from '../core/editor';
import { el, icon, type PageView, type ViewDeps } from './app';
import type { MenuItem, MenuSpec } from './menu';

/** 预览防抖。 */
const PREVIEW_DEBOUNCE_MS = 180;

export type SaveMode = 'auto' | 'force' | 'copy';
export type SaveOutcome = 'saved' | 'copied' | 'conflict' | 'no-original' | 'missing' | 'failed';

export function createEditorPage(initial: State, deps: ViewDeps, docId: string): PageView {
  const doc: Doc | undefined = initial.docs.find((item) => item.id === docId);
  if (doc === undefined) {
    return {
      el: el('div', { class: 'shell', 'data-testid': 'shell' }, el('p', { text: '文档不存在' })),
      update: () => undefined,
    };
  }

  let text = doc.text;
  let savedText = doc.text;
  let mode: 'write' | 'preview' = 'write';
  let previewTimer: number | null = null;
  let saving = false;

  const title = el('h1', { class: 'appbar__title', 'data-testid': 'app-title', text: '编辑' });
  const backBtn = el('button', {
    class: 'icon-btn',
    type: 'button',
    'data-testid': 'editor-back',
    'aria-label': '返回',
    title: '返回',
  }, icon('back'));
  const saveBtn = el('button', {
    class: 'ui-btn ui-press',
    type: 'button',
    'data-testid': 'editor-save',
    text: '保存',
  });
  saveBtn.setAttribute('disabled', '');

  const header = el(
    'header',
    { class: 'appbar appbar--center' },
    backBtn,
    title,
    el('span', { class: 'appbar__spacer' }, saveBtn),
  );

  const writeTab = el('button', {
    class: 'editor-tab editor-tab--on ui-press',
    type: 'button',
    'data-testid': 'editor-tab-write',
    text: '编辑',
  });
  const previewTab = el('button', {
    class: 'editor-tab ui-press',
    type: 'button',
    'data-testid': 'editor-tab-preview',
    text: '预览',
  });
  const tabs = el('div', { class: 'editor-tabs', role: 'tablist', 'aria-label': '编辑/预览' }, writeTab, previewTab);

  const textarea = el('textarea', {
    class: 'editor-input',
    'data-testid': 'editor-input',
    'aria-label': 'Markdown 正文',
    spellcheck: 'false',
    autocapitalize: 'off',
    autocomplete: 'off',
  });
  textarea.value = text;

  const preview = el('div', {
    class: 'article editor-preview',
    'data-testid': 'editor-preview',
    'aria-label': '预览',
  });
  preview.hidden = true;

  const status = el('p', { class: 'editor-status', 'data-testid': 'editor-status' });
  const dirty = el('span', { class: 'editor-dirty', 'data-testid': 'editor-dirty', text: '' });

  const main = el('main', { class: 'main main--editor' },
    el('div', { class: 'editor-page', 'data-testid': 'editor-page' }, tabs, textarea, preview),
  );
  const footer = el('footer', { class: 'editor-footer' }, status, dirty);

  const page = el('div', { class: 'shell editor-shell', 'data-testid': 'shell' }, header, main, footer);

  function refreshStatus(): void {
    const changed = isTextChanged(savedText, text);
    const chars = text.replace(/\s/g, '').length;
    status.textContent = `${chars} 字`;
    dirty.textContent = changed ? '未保存' : '已同步';
    if (changed) saveBtn.removeAttribute('disabled');
    else saveBtn.setAttribute('disabled', '');
  }

  function renderPreview(): void {
    try {
      preview.innerHTML = deps.renderMarkdown(text).html;
    } catch (error) {
      preview.replaceChildren(el('p', {
        class: 'editor-error',
        'data-testid': 'editor-preview-error',
        text: `预览失败：${error instanceof Error ? error.message : String(error)}`,
      }));
    }
  }

  function schedulePreview(): void {
    if (previewTimer !== null) window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      previewTimer = null;
      if (mode === 'preview') renderPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }

  textarea.addEventListener('input', () => {
    text = textarea.value;
    refreshStatus();
    schedulePreview();
  });

  function setMode(next: 'write' | 'preview'): void {
    mode = next;
    const previewing = next === 'preview';
    writeTab.className = previewing ? 'editor-tab ui-press' : 'editor-tab editor-tab--on ui-press';
    previewTab.className = previewing ? 'editor-tab editor-tab--on ui-press' : 'editor-tab ui-press';
    writeTab.setAttribute('aria-selected', previewing ? 'false' : 'true');
    previewTab.setAttribute('aria-selected', previewing ? 'true' : 'false');
    textarea.hidden = previewing;
    preview.hidden = !previewing;
    if (previewing) renderPreview();
  }
  writeTab.addEventListener('click', () => setMode('write'));
  previewTab.addEventListener('click', () => setMode('preview'));

  /** 冲突/无原文件时的选择弹层。 */
  function askFallback(outcome: SaveOutcome): void {
    const items: MenuItem[] = [];
    if (outcome === 'conflict') {
      items.push({
        id: 'editor-overwrite',
        testId: 'editor-overwrite',
        label: '覆盖原文件（外部修改会丢失）',
        danger: true,
        onSelect: () => void performSave('force'),
      });
    }
    items.push({
      id: 'editor-save-copy',
      testId: 'editor-save-copy',
      label: '存为应用内副本（不改原文件）',
      onSelect: () => void performSave('copy'),
    });
    items.push({ id: 'editor-save-cancel', testId: 'editor-save-cancel', label: '取消', onSelect: () => undefined });
    deps.openMenu({
      variant: 'dialog',
      title: outcome === 'conflict' ? '原文件已被外部修改' : '这篇没有可写回的原文件',
      items,
    });
  }

  async function performSave(requested: SaveMode): Promise<void> {
    if (saving) return;
    saving = true;
    saveBtn.setAttribute('disabled', '');
    try {
      const outcome = await deps.saveEditedDoc(docId, text, requested);
      if (outcome === 'saved') {
        savedText = text;
        refreshStatus();
        deps.toast('已保存到原文件');
        return;
      }
      if (outcome === 'copied') {
        // main 已建副本并返回阅读页
        return;
      }
      if (outcome === 'failed') return;
      askFallback(outcome);
    } finally {
      saving = false;
      if (mode === 'write' && isTextChanged(savedText, text)) saveBtn.removeAttribute('disabled');
    }
  }

  saveBtn.addEventListener('click', () => void performSave('auto'));

  function requestLeave(): void {
    if (!isTextChanged(savedText, text)) {
      deps.dispatch({ type: 'nav/back' });
      return;
    }
    deps.openMenu({
      variant: 'dialog',
      title: '放弃未保存的修改？',
      items: [
        {
          id: 'editor-discard',
          testId: 'editor-discard',
          label: '放弃修改并返回',
          danger: true,
          onSelect: () => deps.dispatch({ type: 'nav/back' }),
        },
        { id: 'editor-stay', testId: 'editor-stay', label: '继续编辑', onSelect: () => undefined },
      ],
    });
  }
  backBtn.addEventListener('click', requestLeave);

  refreshStatus();

  return {
    el: page,
    update(state: State) {
      const current = state.docs.find((item) => item.id === docId);
      if (current === undefined) {
        if (state.nav.pages.length > 1) deps.dispatch({ type: 'nav/back' });
        return;
      }
      title.textContent = `编辑 · ${titleFromText(text, current.title)}`;
    },
    destroy() {
      if (previewTimer !== null) window.clearTimeout(previewTimer);
      previewTimer = null;
    },
  };
}
