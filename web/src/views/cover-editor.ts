/**
 * 单篇文档封面编辑器（Bottom Sheet，LayerKind 'cover'）。
 *
 * 支持：
 *   - 实时 3:4 封面预览（复用 buildCoverElement，与书架 100% 一致）；
 *   - 12 套精选色板 × 6 种图书装帧版式；
 *   - 自定义封面主徽标（1..4 字符）与副标题角标；
 *   - 自定义本地封面图片（缩图后存入 Doc.cover.image）；
 *   - 一键恢复自动派生封面。
 */

import type { CoverPattern, Doc, DocCover } from '../core/types';
import { el } from './app';
import {
  COVER_COUNT,
  COVER_PATTERNS,
  buildCoverElement,
  coverIndex,
  coverPattern,
} from './cover';

export interface CoverEditorHandlers {
  pickImage: () => Promise<string | null>;
  save: (docId: string, cover: DocCover | null) => void;
  close: () => void;
}

export interface CoverEditorSheet {
  readonly el: HTMLElement;
}

export function createCoverEditorSheet(doc: Doc, handlers: CoverEditorHandlers): CoverEditorSheet {
  const autoPalette = coverIndex(doc.title);
  const autoPattern = coverPattern(doc.title);

  let draft: DocCover = {
    palette: doc.cover?.palette ?? autoPalette,
    pattern: doc.cover?.pattern ?? autoPattern,
    monogram: doc.cover?.monogram ?? '',
    subtitle: doc.cover?.subtitle ?? '',
    image: doc.cover?.image ?? null,
  };

  const previewHost = el('div', { class: 'cover-editor__preview-box' });

  const clearImgBtn = el('button', {
    class: 'ui-btn ui-btn--ghost ui-press',
    type: 'button',
    'data-testid': 'cover-clear-image',
    text: '清除图片',
  });
  const pickImgBtn = el('button', {
    class: 'ui-btn ui-press',
    type: 'button',
    'data-testid': 'cover-pick-image',
    text: '选本地图片',
  });

  const swatches: HTMLButtonElement[] = [];
  const paletteRow = el('div', { class: 'cover-editor__swatches', role: 'radiogroup', 'aria-label': '封面配色' });
  for (let i = 1; i <= COVER_COUNT; i += 1) {
    const btn = el('button', {
      class: 'cover-editor__swatch ui-press',
      type: 'button',
      'data-cover': String(i),
      'data-testid': `cover-palette-${i}`,
      'aria-label': `配色 ${i}`,
      'aria-checked': 'false',
      role: 'radio',
    });
    btn.addEventListener('click', () => {
      draft = { ...draft, palette: i };
      paint();
    });
    swatches.push(btn);
    paletteRow.append(btn);
  }

  const patternBtns: Array<{ readonly id: CoverPattern; readonly btn: HTMLButtonElement }> = [];
  const patternRow = el('div', { class: 'cover-editor__patterns', role: 'radiogroup', 'aria-label': '装帧版式' });
  for (const p of COVER_PATTERNS) {
    const btn = el('button', {
      class: 'cover-editor__pattern ui-press',
      type: 'button',
      'data-testid': `cover-pattern-${p.id}`,
      role: 'radio',
      'aria-checked': 'false',
      text: p.label,
    });
    btn.addEventListener('click', () => {
      draft = { ...draft, pattern: p.id };
      paint();
    });
    patternBtns.push({ id: p.id, btn });
    patternRow.append(btn);
  }

  const monogramInput = el('input', {
    class: 'collection-input',
    type: 'text',
    maxlength: '4',
    autocomplete: 'off',
    'data-testid': 'cover-monogram',
    placeholder: '主字/徽标（留空自动取首字，如 CET4）',
    'aria-label': '封面主字或徽标',
  });
  monogramInput.value = draft.monogram ?? '';
  monogramInput.addEventListener('input', () => {
    draft = { ...draft, monogram: monogramInput.value };
    paintPreview();
  });

  const subtitleInput = el('input', {
    class: 'collection-input',
    type: 'text',
    maxlength: '16',
    autocomplete: 'off',
    'data-testid': 'cover-subtitle',
    placeholder: '副标角标（留空取文件夹或时长）',
    'aria-label': '封面副标角标',
  });
  subtitleInput.value = draft.subtitle ?? '';
  subtitleInput.addEventListener('input', () => {
    draft = { ...draft, subtitle: subtitleInput.value };
    paintPreview();
  });

  pickImgBtn.addEventListener('click', () => {
    void handlers.pickImage().then((data) => {
      if (data === null) return;
      draft = { ...draft, image: data };
      paint();
    });
  });

  clearImgBtn.addEventListener('click', () => {
    draft = { ...draft, image: null };
    paint();
  });

  const resetBtn = el('button', {
    class: 'ui-btn ui-btn--ghost ui-press',
    type: 'button',
    'data-testid': 'cover-reset',
    text: '恢复自动',
  });
  resetBtn.addEventListener('click', () => {
    handlers.save(doc.id, null);
    handlers.close();
  });

  const cancelBtn = el('button', {
    class: 'ui-btn ui-btn--ghost ui-press',
    type: 'button',
    'data-testid': 'cover-cancel',
    text: '取消',
  });
  cancelBtn.addEventListener('click', () => handlers.close());

  const saveBtn = el('button', {
    class: 'ui-btn ui-btn--primary ui-press',
    type: 'button',
    'data-testid': 'cover-save',
    text: '保存封面',
  });
  saveBtn.addEventListener('click', () => {
    const cleanMono = draft.monogram?.trim();
    const cleanSub = draft.subtitle?.trim();
    const normalized: DocCover = {
      ...(draft.palette !== undefined ? { palette: draft.palette } : {}),
      ...(draft.pattern !== undefined ? { pattern: draft.pattern } : {}),
      ...(cleanMono !== undefined && cleanMono.length > 0 ? { monogram: cleanMono } : {}),
      ...(cleanSub !== undefined && cleanSub.length > 0 ? { subtitle: cleanSub } : {}),
      ...(draft.image !== undefined && draft.image !== null ? { image: draft.image } : {}),
    };
    handlers.save(doc.id, normalized);
    handlers.close();
  });

  function paintPreview(): void {
    previewHost.replaceChildren(buildCoverElement(doc, 'cover--card cover-editor__card', { override: draft }));
  }

  function paint(): void {
    paintPreview();
    swatches.forEach((btn, idx) => {
      const active = (draft.palette ?? autoPalette) === idx + 1;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
    });
    for (const item of patternBtns) {
      const active = (draft.pattern ?? autoPattern) === item.id;
      item.btn.classList.toggle('is-active', active);
      item.btn.setAttribute('aria-checked', active ? 'true' : 'false');
    }
    const hasImg = typeof draft.image === 'string' && draft.image.length > 0;
    if (hasImg) clearImgBtn.removeAttribute('disabled');
    else clearImgBtn.setAttribute('disabled', '');
  }

  const panel = el(
    'section',
    {
      class: 'sheet-panel glass cover-editor',
      'data-testid': 'cover-editor-sheet',
      role: 'dialog',
      'aria-label': '编辑封面',
    },
    el('span', { class: 'sheet-panel__handle', 'aria-hidden': 'true' }),
    el(
      'header',
      { class: 'sheet-panel__head' },
      el('h2', { class: 'sheet-panel__title', text: '编辑封面' }),
    ),
    el(
      'div',
      { class: 'cover-editor__top' },
      previewHost,
      el(
        'div',
        { class: 'cover-editor__meta' },
        el('p', { class: 'cover-editor__doc-title', text: doc.title }),
        el('div', { class: 'cover-editor__img-actions' }, pickImgBtn, clearImgBtn),
      ),
    ),
    el('div', { class: 'cover-editor__label', text: '配色' }),
    paletteRow,
    el('div', { class: 'cover-editor__label', text: '装帧版式' }),
    patternRow,
    el('div', { class: 'cover-editor__label', text: '徽标与角标' }),
    el('div', { class: 'cover-editor__inputs' }, monogramInput, subtitleInput),
    el(
      'footer',
      { class: 'cover-editor__actions' },
      resetBtn,
      el('span', { class: 'cover-editor__spacer' }),
      cancelBtn,
      saveBtn,
    ),
  );

  paint();
  return { el: panel };
}
