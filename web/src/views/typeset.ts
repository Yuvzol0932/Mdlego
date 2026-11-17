/**
 * 阅读排版面板（Aa，阶段 C3）—— 底部面板形态的浮层。
 *
 * 与设置页的区别：这里只放「读的时候会随手调」的四项
 * （字号 / 行距 / 段距 / 字体 / 主题），改动即时生效：
 *   dispatch(settings/changed) → main 订阅者写 <html data-*> → CSS 变量立刻变
 * 所以面板里不需要预览区，正文本身就是预览。
 *
 * 为什么不用整块重建：滑块拖动会连续触发 state 变化，
 * 重建会把正在拖的 input 换掉、手势中断（与设置页踩过的坑同一个）。
 * 所以这里持有控件引用，外部变化时只同步值。
 */

import type { Settings, State, StateAction, ThemeChoice } from '../core/types';
import { LINE_SCALE_MAX, LINE_SCALE_MIN, PARA_SCALE_MAX, PARA_SCALE_MIN, TYPE_SCALE_MAX, TYPE_SCALE_MIN } from '../core/typography';
import { el, icon } from './app';
import { paintSlider, segmentedControl, slider } from './components';

export interface SheetView {
  readonly el: HTMLElement;
  update(state: State): void;
}

/** 面板里的主题选项：只放最常用的四个，其余在设置页。 */
const SHEET_THEMES: ReadonlyArray<{ value: ThemeChoice; label: string; testId: string }> = [
  { value: 'system', label: '跟随系统', testId: 'typeset-theme-system' },
  { value: 'warm-night', label: '暖黑', testId: 'typeset-theme-warm-night' },
  { value: 'warm-paper', label: '米纸', testId: 'typeset-theme-warm-paper' },
  { value: 'forest', label: '墨绿', testId: 'typeset-theme-forest' },
];

function sliderRow(o: {
  label: string;
  value: number;
  min: number;
  max: number;
  testId: string;
  onInput: (value: number) => void;
}): { row: HTMLElement; input: HTMLInputElement; valueEl: HTMLElement } {
  const valueEl = el('span', { class: 'sheet-row__value', text: String(o.value) });
  const input = slider({
    value: o.value,
    min: o.min,
    max: o.max,
    testId: o.testId,
    ariaLabel: o.label,
    onInput: (next) => {
      valueEl.textContent = String(next);
      o.onInput(next);
    },
  });
  return {
    row: el('div', { class: 'sheet-row' }, el('span', { class: 'sheet-row__label', text: o.label }), input, valueEl),
    input,
    valueEl,
  };
}

export function createTypesetSheet(initial: State, dispatch: (action: StateAction) => void): SheetView {
  const patch = (p: Partial<Settings>): void => dispatch({ type: 'settings/changed', patch: p });

  const scale = sliderRow({
    label: '字号',
    value: initial.settings.typeScale,
    min: TYPE_SCALE_MIN,
    max: TYPE_SCALE_MAX,
    testId: 'typeset-type-scale',
    onInput: (typeScale) => patch({ typeScale }),
  });
  const line = sliderRow({
    label: '行距',
    value: initial.settings.lineScale,
    min: LINE_SCALE_MIN,
    max: LINE_SCALE_MAX,
    testId: 'typeset-line-scale',
    onInput: (lineScale) => patch({ lineScale }),
  });
  const para = sliderRow({
    label: '段距',
    value: initial.settings.paraScale,
    min: PARA_SCALE_MIN,
    max: PARA_SCALE_MAX,
    testId: 'typeset-para-scale',
    onInput: (paraScale) => patch({ paraScale }),
  });

  // 字体与主题是离散选择，外部变化时重建这一行即可（没有拖动手势）
  const fontSlot = el('div', { class: 'sheet-row__control' });
  const themeSlot = el('div', { class: 'sheet-row__control sheet-row__control--themes' });

  function buildFont(fontFamily: State['settings']['fontFamily']): void {
    fontSlot.replaceChildren(
      segmentedControl<'sans' | 'serif'>({
        value: fontFamily,
        testId: 'typeset-font',
        items: [
          { value: 'serif', label: '宋体', testId: 'typeset-font-serif' },
          { value: 'sans', label: '黑体', testId: 'typeset-font-sans' },
        ],
        onSelect: (next) => patch({ fontFamily: next }),
      }),
    );
  }

  function buildTheme(theme: ThemeChoice): void {
    const wrap = el('div', { class: 'sheet-themes', role: 'group' });
    for (const item of SHEET_THEMES) {
      const btn = el('button', {
        class: 'sheet-theme',
        type: 'button',
        'data-testid': item.testId,
        'aria-pressed': item.value === theme ? 'true' : 'false',
        text: item.label,
      });
      btn.addEventListener('click', () => patch({ theme: item.value }));
      wrap.append(btn);
    }
    themeSlot.replaceChildren(wrap);
  }

  let builtFont = initial.settings.fontFamily;
  let builtTheme = initial.settings.theme;
  buildFont(builtFont);
  buildTheme(builtTheme);

  const panel = el(
    'section',
    { class: 'sheet-panel glass', 'data-testid': 'typeset-sheet', role: 'dialog', 'aria-label': '排版' },
    el('span', { class: 'sheet-panel__handle', 'aria-hidden': 'true' }),
    el(
      'header',
      { class: 'sheet-panel__head' },
      el('h2', { class: 'sheet-panel__title', text: '排版' }),
      el('span', { class: 'sheet-panel__hint', text: '改动即时生效' }),
    ),
    scale.row,
    line.row,
    para.row,
    el('div', { class: 'sheet-row' }, el('span', { class: 'sheet-row__label', text: '字体' }), fontSlot),
    el('div', { class: 'sheet-row' }, el('span', { class: 'sheet-row__label', text: '主题' }), themeSlot),
  );

  return {
    el: panel,
    update(state) {
      const s = state.settings;
      // 滑块：外部（设置页/快捷切换）改过才回写，避免打断正在拖的手势
      if (Number(scale.input.value) !== s.typeScale) {
        scale.input.value = String(s.typeScale);
        scale.valueEl.textContent = String(s.typeScale);
        paintSlider(scale.input);
      }
      if (Number(line.input.value) !== s.lineScale) {
        line.input.value = String(s.lineScale);
        line.valueEl.textContent = String(s.lineScale);
        paintSlider(line.input);
      }
      if (Number(para.input.value) !== s.paraScale) {
        para.input.value = String(s.paraScale);
        para.valueEl.textContent = String(s.paraScale);
        paintSlider(para.input);
      }
      if (s.fontFamily !== builtFont) {
        builtFont = s.fontFamily;
        buildFont(builtFont);
      }
      if (s.theme !== builtTheme) {
        builtTheme = s.theme;
        buildTheme(builtTheme);
      }
    },
  };
}

/** 面板外壳：遮罩 + 底部滑入。点击遮罩关闭。 */
export function sheetLayer(panel: HTMLElement, onClose: () => void): HTMLElement {
  const layer = el('div', { class: 'sheet-layer', 'data-testid': 'typeset-layer' });
  const scrim = el('div', { class: 'sheet-layer__scrim' });
  scrim.addEventListener('click', onClose);
  const close = el('button', {
    class: 'icon-btn sheet-layer__close',
    type: 'button',
    'data-testid': 'typeset-close',
    'aria-label': '关闭排版面板',
  }, icon('close'));
  close.addEventListener('click', onClose);
  layer.append(scrim, panel, close);
  return layer;
}
