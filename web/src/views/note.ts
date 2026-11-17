/**
 * 备注编辑面板（阶段 E2）。
 *
 * 新建批注（选好文字后点「批注」）与编辑已有批注共用同一个面板：
 *   - 标题下方显示被标注的原文（截断），避免用户忘了注释的是哪段
 *   - textarea 500 字上限；保存/取消
 * 面板本身不落库：保存时把文本交给 main，由 main 决定新建 mark 还是更新 mark。
 */

import { el, icon } from './app';

/** 备注最大长度。 */
export const NOTE_MAX_LEN = 500;

export interface NoteDraft {
  readonly docId: string;
  readonly mode: 'new' | 'edit';
  /** 编辑已有批注时的 mark id。 */
  readonly markId?: string;
  /** 被标注原文（用于预览与新建时构造锚点）。 */
  readonly quote: string;
  readonly initial: string;
}

export interface NoteHandlers {
  readonly save: (text: string) => void;
  readonly cancel: () => void;
}

export interface NoteSheet {
  readonly el: HTMLElement;
}

export function createNoteSheet(draft: NoteDraft, handlers: NoteHandlers): NoteSheet {
  const textarea = el('textarea', {
    class: 'note-input',
    'data-testid': 'note-input',
    rows: '4',
    maxlength: String(NOTE_MAX_LEN),
    placeholder: '写下这条批注…',
    'aria-label': '批注内容',
  });
  textarea.value = draft.initial;

  const counter = el('span', { class: 'note-counter', 'data-testid': 'note-counter', text: `${draft.initial.length}/${NOTE_MAX_LEN}` });
  const syncCounter = (): void => {
    counter.textContent = `${textarea.value.length}/${NOTE_MAX_LEN}`;
  };
  textarea.addEventListener('input', syncCounter);

  const saveBtn = el('button', {
    class: 'ui-btn ui-press',
    type: 'button',
    'data-testid': 'note-save',
    text: draft.mode === 'new' ? '保存批注' : '保存修改',
  });
  const submit = (): void => {
    handlers.save(textarea.value.trim());
  };
  saveBtn.addEventListener('click', submit);

  const cancelBtn = el('button', {
    class: 'ui-btn ui-btn--ghost ui-press',
    type: 'button',
    'data-testid': 'note-cancel',
    text: '取消',
  });
  cancelBtn.addEventListener('click', () => handlers.cancel());

  const quote = draft.quote.replace(/\s+/g, ' ').trim();
  const quotePreview = el(
    'p',
    { class: 'note-quote', 'data-testid': 'note-quote' },
    quote.length > 0 ? quote : '（无原文预览）',
  );

  const panel = el(
    'section',
    { class: 'sheet-panel glass', 'data-testid': 'note-sheet', role: 'dialog', 'aria-label': '批注' },
    el('span', { class: 'sheet-panel__handle', 'aria-hidden': 'true' }),
    el(
      'header',
      { class: 'sheet-panel__head' },
      el('h2', { class: 'sheet-panel__title', text: draft.mode === 'new' ? '新建批注' : '编辑批注' }),
      el('span', { class: 'sheet-panel__hint' }, counter),
    ),
    quotePreview,
    textarea,
    el('div', { class: 'note-actions' }, cancelBtn, saveBtn),
  );

  // 打开即聚焦，符合「点了批注就是要写字」的预期
  window.setTimeout(() => textarea.focus(), 30);
  void icon;

  return { el: panel };
}
