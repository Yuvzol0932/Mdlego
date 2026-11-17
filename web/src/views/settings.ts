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
import { ACCENTS, GLASS_LEVEL_MAX, GLASS_LEVEL_MIN, THEME_SCHEME, resolveTheme } from '../core/theme';
import type { MaterialName, MotionLevel, Settings, State, ThemeChoice, ThemeName } from '../core/types';
import { el, icon, systemPrefersDark, type ViewDeps } from './app';
import { accentPalette, segmentedControl, slider, themeChoice } from './components';
import { renderTabBar } from './tabbar';

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

  // ── 外观：修改即时预览（settings/changed → main 订阅者写根节点属性 → CSS 立即生效） ──
  {
    const label = (text: string): HTMLElement => el('div', { class: 'panel__label', text });
    const themes = el('div', { class: 'kit__row', 'data-testid': 'theme' });
    const choices: ThemeChoice[] = ['system', 'warm-night', 'warm-paper', 'forest', 'slate', 'magazine', 'night', 'paper'];
    for (const t of choices) {
      themes.append(
        themeChoice({
          theme: t,
          pressed: settings.theme === t,
          testId: `theme-${t}`,
          onSelect: () => patch({ theme: t as ThemeName | 'system' }),
        }),
      );
    }
    const scheme = THEME_SCHEME[resolveTheme(settings.theme, systemPrefersDark())];
    rows.push(
      el('div', { class: 'panel__row', 'data-testid': 'appearance' }, label('主题'), themes),
      el('div', { class: 'panel__row' }, label('强调色'),
        accentPalette({ value: settings.accent, scheme, accents: ACCENTS, onSelect: (accent) => patch({ accent }) })),
      el('div', { class: 'panel__row' }, label('材质'),
        segmentedControl<MaterialName>({
          value: settings.material,
          testId: 'material',
          items: [
            { value: 'glass', label: '玻璃', testId: 'material-glass' },
            { value: 'soft', label: '柔和半透明', testId: 'material-soft' },
            { value: 'solid', label: '纯色', testId: 'material-solid' },
          ],
          onSelect: (material) => patch({ material }),
        })),
      el('div', { class: 'panel__row' }, label('玻璃强度'),
        slider({
          value: settings.glassLevel, min: GLASS_LEVEL_MIN, max: GLASS_LEVEL_MAX,
          testId: 'glass-level', ariaLabel: '玻璃强度（弱/标准/强）',
          onInput: (glassLevel) => patch({ glassLevel }),
        })),
      el('div', { class: 'panel__row' }, label('动效'),
        segmentedControl<MotionLevel>({
          value: settings.motion,
          testId: 'motion',
          items: [
            { value: 'off', label: '关', testId: 'motion-off' },
            { value: 'simple', label: '简约', testId: 'motion-simple' },
            { value: 'full', label: '完整', testId: 'motion-full' },
          ],
          onSelect: (motion) => patch({ motion }),
        })),
    );
  }

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
    // 长按查词开关：M5 唯一的设置项入口（docs/M5-DICT-PLAN.md §7.1）。
    // 关掉后 views/reader.ts 的长按绑定整个不生效，正文长按完全无反应。
    const lookupOn = settings.lookupEnabled;
    const lookupSwitch = el('button', {
      class: 'switch',
      type: 'button',
      role: 'switch',
      'data-testid': 'lookup-enabled-switch',
      'aria-checked': lookupOn ? 'true' : 'false',
      'aria-label': '长按查词',
      onclick: () => patch({ lookupEnabled: !lookupOn }),
    });
    rows.push(
      el(
        'div',
        { class: 'panel__row panel__row--inline', 'data-testid': 'lookup-enabled' },
        el('div', { class: 'panel__label', text: '长按查词' }),
        lookupSwitch,
      ),
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

  // 作为二级页被压入（例如从阅读页进设置）时给返回键；作为一级 tab 时它自己是返回栈底，
  // 没有可返回的地方，不画返回键。
  const pushed = state.nav.pages.length > 1;
  const actions: Node[] = pushed
    ? [
        el('button', {
          class: 'icon-btn',
          type: 'button',
          'data-testid': 'back-home',
          'aria-label': '返回',
          title: '返回',
          onclick: () => deps.dispatch({ type: 'nav/back' }),
        }, icon('back')),
      ]
    : [el('span', { class: 'appbar__spacer', 'aria-hidden': 'true' })];

  const page = el(
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
    el('main', { class: pushed ? 'main' : 'main main--tabbed' }, el('div', { class: 'panel', 'data-testid': 'settings-panel' }, ...rows)),
  );

  if (pushed) return page;
  page.append(renderTabBar('settings', deps));
  return page;
}
