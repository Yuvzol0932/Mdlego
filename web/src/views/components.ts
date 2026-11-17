/**
 * 统一组件（阶段 B2）：按钮 / 开关 / 分段 / 滑块 / 卡片 / 胶囊 / 强调色色板 / 主题预览。
 *
 * 只产出 DOM + 回调，不碰状态与存储。样式在 styles/components.css，全部走令牌。
 * 每个组件都接受 testId，保证测试经 data-testid 接头。
 */

import { ACCENT_LABELS, THEME_LABELS, THEME_SCHEME } from '../core/theme';
import type { AccentName, ThemeName } from '../core/types';
import { el, icon } from './app';
import type { IconName } from './icons';

export function button(o: {
  label?: string;
  icon?: IconName;
  variant?: 'default' | 'primary' | 'ghost';
  round?: boolean;
  testId: string;
  onClick: () => void;
  ariaLabel?: string;
}): HTMLButtonElement {
  const cls = ['ui-btn', 'ui-press'];
  if (o.variant === 'primary') cls.push('ui-btn--primary');
  if (o.variant === 'ghost') cls.push('ui-btn--ghost');
  if (o.round === true) cls.push('ui-btn--round');
  const btn = el('button', {
    class: cls.join(' '),
    type: 'button',
    'data-testid': o.testId,
    'aria-label': o.ariaLabel ?? o.label ?? o.testId,
    onclick: () => o.onClick(),
  });
  if (o.icon !== undefined) btn.append(icon(o.icon));
  if (o.label !== undefined) btn.append(el('span', { text: o.label }));
  return btn;
}

export function switchControl(o: {
  checked: boolean;
  testId: string;
  ariaLabel: string;
  onChange: (next: boolean) => void;
}): HTMLButtonElement {
  const btn = el('button', {
    class: 'ui-switch',
    type: 'button',
    role: 'switch',
    'data-testid': o.testId,
    'aria-checked': o.checked ? 'true' : 'false',
    'aria-label': o.ariaLabel,
  });
  btn.addEventListener('click', () => {
    const next = btn.getAttribute('aria-checked') !== 'true';
    btn.setAttribute('aria-checked', next ? 'true' : 'false');
    o.onChange(next);
  });
  return btn;
}

export function segmentedControl<T extends string>(o: {
  value: T;
  items: ReadonlyArray<{ value: T; label: string; testId: string }>;
  testId: string;
  onSelect: (value: T) => void;
}): HTMLElement {
  const bar = el('div', { class: 'ui-seg', role: 'group', 'data-testid': o.testId });
  const buttons: Array<[T, HTMLButtonElement]> = [];
  for (const item of o.items) {
    const b = el('button', {
      class: 'ui-seg__item ui-press',
      type: 'button',
      'data-testid': item.testId,
      'aria-pressed': item.value === o.value ? 'true' : 'false',
      text: item.label,
    });
    b.addEventListener('click', () => {
      for (const [v, other] of buttons) other.setAttribute('aria-pressed', v === item.value ? 'true' : 'false');
      o.onSelect(item.value);
    });
    buttons.push([item.value, b]);
    bar.append(b);
  }
  return bar;
}

export function slider(o: {
  value: number;
  min: number;
  max: number;
  step?: number;
  testId: string;
  ariaLabel: string;
  onInput: (value: number) => void;
}): HTMLInputElement {
  const input = el('input', {
    class: 'ui-slider',
    type: 'range',
    min: String(o.min),
    max: String(o.max),
    step: String(o.step ?? 1),
    value: String(o.value),
    'data-testid': o.testId,
    'aria-label': o.ariaLabel,
  });
  const paint = (): void => {
    const pct = ((Number(input.value) - o.min) / (o.max - o.min)) * 100;
    input.style.setProperty('--fill', `${pct}%`);
  };
  paint();
  input.addEventListener('input', () => {
    paint();
    o.onInput(Number(input.value));
  });
  return input;
}

export function card(o: { testId: string; hero?: boolean }, ...children: Array<Node | string>): HTMLElement {
  return el('div', { class: o.hero === true ? 'ui-card ui-card--hero' : 'ui-card', 'data-testid': o.testId }, ...children);
}

export function chip(o: {
  label: string;
  pressed: boolean;
  testId: string;
  onToggle: (next: boolean) => void;
}): HTMLButtonElement {
  const b = el('button', {
    class: 'ui-chip ui-press',
    type: 'button',
    'data-testid': o.testId,
    'aria-pressed': o.pressed ? 'true' : 'false',
    text: o.label,
  });
  b.addEventListener('click', () => {
    const next = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', next ? 'true' : 'false');
    o.onToggle(next);
  });
  return b;
}

/**
 * 强调色色板。色块自己带 data-accent + data-scheme，颜色由令牌解析（var(--accent)），
 * 所以这里不出现任何色值；scheme 取当前生效明暗，保证色块与实际应用后的颜色一致。
 */
export function accentPalette(o: {
  value: AccentName | 'theme';
  scheme: 'light' | 'dark';
  onSelect: (value: AccentName | 'theme') => void;
  accents: readonly AccentName[];
}): HTMLElement {
  const wrap = el('div', { class: 'kit__row', role: 'group', 'data-testid': 'accent-palette' });
  const all: Array<[AccentName | 'theme', HTMLElement]> = [];
  const select = (v: AccentName | 'theme'): void => {
    for (const [k, node] of all) node.setAttribute('aria-pressed', k === v ? 'true' : 'false');
    o.onSelect(v);
  };
  const themeDot = el('button', {
    class: 'ui-chip ui-press',
    type: 'button',
    'data-testid': 'accent-theme',
    'aria-pressed': o.value === 'theme' ? 'true' : 'false',
    text: '跟随主题',
  });
  themeDot.addEventListener('click', () => select('theme'));
  all.push(['theme', themeDot]);
  wrap.append(themeDot);
  for (const name of o.accents) {
    const dot = el('button', {
      class: 'ui-swatch',
      type: 'button',
      'data-testid': `accent-${name}`,
      'data-accent': name,
      'data-scheme': o.scheme,
      'aria-label': ACCENT_LABELS[name],
      'aria-pressed': o.value === name ? 'true' : 'false',
    });
    dot.addEventListener('click', () => select(name));
    all.push([name, dot]);
    wrap.append(dot);
  }
  return wrap;
}

/** 主题预览块：自带 data-theme，用该主题自己的纸面/墨色/强调色画一个小样。 */
export function themeChoice(o: {
  theme: ThemeName | 'system';
  pressed: boolean;
  testId: string;
  onSelect: () => void;
}): HTMLElement {
  const label = o.theme === 'system' ? '跟随系统' : THEME_LABELS[o.theme];
  const sample = el('span', { class: 'ui-theme__chip' }, '墨', el('i'));
  if (o.theme !== 'system') {
    sample.setAttribute('data-theme', o.theme);
    sample.setAttribute('data-scheme', THEME_SCHEME[o.theme]);
  }
  const b = el('button', {
    class: 'ui-theme ui-press',
    type: 'button',
    'data-testid': o.testId,
    'aria-pressed': o.pressed ? 'true' : 'false',
    'aria-label': label,
  }, sample, el('span', { text: label }));
  b.addEventListener('click', () => o.onSelect());
  return b;
}
