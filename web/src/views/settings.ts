/**
 * 设置面板 —— 可调排版能力的实际载体。
 *
 * 关键设计：这里只派发 action，不直接改 CSS、不直接改存储。
 * 状态变化 → main.ts 的订阅者 → 写根节点属性 → CSS 档位生效。
 * 这样"设置生效"只有一条路径，不会出现某处改了某处没改。
 */

import {
  LINE_SCALE_LABELS,
  LINE_SCALE_MAX,
  LINE_SCALE_MIN,
  PARA_SCALE_LABELS,
  PARA_SCALE_MAX,
  PARA_SCALE_MIN,
  TYPE_SCALE_LABELS,
  TYPE_SCALE_MAX,
  TYPE_SCALE_MIN,
} from '../core/typography';
import type { Settings, State } from '../core/types';
import { el, icon, type ViewDeps } from './app';

/** 档位调节器：左右按钮 + 进度点 + 当前档位名。 */
function stepper(options: {
  label: string;
  testId: string;
  value: number;
  min: number;
  max: number;
  labels: readonly string[];
  onChange: (next: number) => void;
}): HTMLElement {
  const { label, testId, value, min, max, labels, onChange } = options;

  const pips = el('div', { class: 'stepper__track', 'aria-hidden': 'true' });
  for (let i = min; i <= max; i++) {
    pips.append(
      el('span', {
        class: i <= value ? 'stepper__pip stepper__pip--on' : 'stepper__pip',
        'data-pip': String(i),
      }),
    );
  }

  const dec = el('button', {
    class: 'stepper__btn',
    type: 'button',
    'data-testid': `${testId}-decrease`,
    'aria-label': `减小${label}`,
    text: '−',
  });
  if (value <= min) dec.setAttribute('disabled', 'true');
  dec.addEventListener('click', () => onChange(Math.max(min, value - 1)));

  const inc = el('button', {
    class: 'stepper__btn',
    type: 'button',
    'data-testid': `${testId}-increase`,
    'aria-label': `增大${label}`,
    text: '+',
  });
  if (value >= max) inc.setAttribute('disabled', 'true');
  inc.addEventListener('click', () => onChange(Math.min(max, value + 1)));

  return el(
    'div',
    { class: 'panel__row', 'data-testid': testId },
    el('div', { class: 'panel__label', text: label }),
    el(
      'div',
      { class: 'stepper' },
      dec,
      pips,
      inc,
      el('span', {
        class: 'stepper__value',
        'data-testid': `${testId}-value`,
        text: labels[value - min] ?? String(value),
      }),
    ),
  );
}

/** 分段控件：用于主题、字体这类互斥选择。 */
function segmented(options: {
  label: string;
  testId: string;
  value: string;
  items: ReadonlyArray<{ value: string; label: string; testId: string }>;
  onSelect: (value: string) => void;
}): HTMLElement {
  const { label, testId, value, items, onSelect } = options;

  const bar = el('div', { class: 'segmented', 'data-testid': testId, role: 'group' });
  for (const item of items) {
    const pressed = item.value === value;
    const btn = el('button', {
      class: 'segmented__item',
      type: 'button',
      'data-testid': item.testId,
      'aria-pressed': pressed ? 'true' : 'false',
      text: item.label,
    });
    btn.addEventListener('click', () => onSelect(item.value));
    bar.append(btn);
  }

  return el(
    'div',
    { class: 'panel__row' },
    el('div', { class: 'panel__label', text: label }),
    bar,
  );
}

/** 渲染设置页。 */
export function renderSettings(state: State, deps: ViewDeps): HTMLElement {
  const { settings } = state;

  const patch = (p: Partial<Settings>): void => {
    deps.dispatch({ type: 'settings/changed', patch: p });
  };

  const rows: Node[] = [];

  // ── 排版 ─────────────────────────────────
  rows.push(
    stepper({
      label: '字号',
      testId: 'type-scale',
      value: settings.typeScale,
      min: TYPE_SCALE_MIN,
      max: TYPE_SCALE_MAX,
      labels: TYPE_SCALE_LABELS,
      onChange: (next) => patch({ typeScale: next }),
    }),
  );

  rows.push(
    stepper({
      label: '行距',
      testId: 'line-scale',
      value: settings.lineScale,
      min: LINE_SCALE_MIN,
      max: LINE_SCALE_MAX,
      labels: LINE_SCALE_LABELS,
      onChange: (next) => patch({ lineScale: next }),
    }),
  );

  rows.push(
    stepper({
      label: '段间距',
      testId: 'para-scale',
      value: settings.paraScale,
      min: PARA_SCALE_MIN,
      max: PARA_SCALE_MAX,
      labels: PARA_SCALE_LABELS,
      onChange: (next) => patch({ paraScale: next }),
    }),
  );

  rows.push(
    segmented({
      label: '字体',
      testId: 'font-family',
      value: settings.fontFamily,
      items: [
        { value: 'serif', label: '宋体', testId: 'font-serif' },
        { value: 'sans', label: '黑体', testId: 'font-sans' },
      ],
      onSelect: (value) => patch({ fontFamily: value === 'sans' ? 'sans' : 'serif' }),
    }),
  );

  // 实时预览：改档位时这里立刻变化，用户能看到效果而不是只有数字在动。
  // 放两段是为了让「段间距」档位也肉眼可见。
  const preview = el(
    'div',
    { class: 'preview', 'data-testid': 'type-preview' },
    el('p', {
      text: '词根 -spect- 表示「看」。掌握它，可以一次记住几十个考研高频词。',
    }),
    el('p', {
      text: 'inspect 检查 · retrospect 回顾 · prospect 前景 · conspicuous 显眼的。',
    }),
  );
  rows.push(preview);

  // ── 阅读偏好 ──
  {
    rows.push(
      segmented({
        label: '主题',
        testId: 'theme',
        value: settings.theme,
        items: [
          { value: 'magazine', label: '杂志', testId: 'theme-magazine' },
          { value: 'night', label: '夜间', testId: 'theme-night' },
          { value: 'paper', label: '纸面', testId: 'theme-paper' },
        ],
        onSelect: (value) =>
          patch({ theme: value === 'night' ? 'night' : value === 'paper' ? 'paper' : 'magazine' }),
      }),
    );

    const buildInfo = el(
      'dl',
      { class: 'build-info', 'data-testid': 'build-info' },
      el('dt', { text: '版本 versionName' }),
      el('dd', { 'data-testid': 'build-version', text: deps.appVersion }),
      el('dt', { text: '构建指纹 buildId' }),
      el('dd', { 'data-testid': 'build-id', text: deps.buildId }),
      el('dt', { text: '网络权限' }),
      el('dd', { text: '未申请（完全离线）' }),
    );
    rows.push(buildInfo);
  }

  const actions: Node[] = [
    el('button', {
      class: 'icon-btn',
      type: 'button',
      'data-testid': 'back-home',
      'aria-label': '返回',
      title: '返回',
      onclick: () => {
        location.hash = '#/';
      },
    }, icon('back')),
  ];

  return el(
    'div',
    { class: 'shell', 'data-testid': 'shell' },
    el(
      'header',
      { class: 'appbar appbar--center' },
      ...actions,
      el('h1', {
        class: 'appbar__title',
        'data-testid': 'app-title',
        text: '设置',
      }),
      // 右侧占位，保证标题真正居中而不是「视觉上偏左」
      el('span', { class: 'appbar__spacer', 'aria-hidden': 'true' }),
    ),
    el('main', { class: 'main' }, el('div', { class: 'panel', 'data-testid': 'settings-panel' }, ...rows)),
  );
}
