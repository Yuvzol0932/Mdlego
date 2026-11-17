/**
 * 组件展示页（#/kit）—— 仅开发环境 / kit 构建可见。
 *
 * 用途：在各主题、各材质档下一眼检查所有统一组件；
 * 并实时统计「当前生效的 backdrop-filter 层数」，验证不超过 3 个。
 */

import { ACCENTS, GLASS_LEVEL_MAX, GLASS_LEVEL_MIN, THEME_LABELS, THEME_SCHEME, resolveTheme } from '../core/theme';
import type { MaterialName, MotionLevel, State, ThemeChoice, ThemeName } from '../core/types';
import { el, icon, systemPrefersDark, type ViewDeps } from './app';
import {
  accentPalette, button, card, chip, segmentedControl, slider, switchControl, themeChoice,
} from './components';
import { ICON_PATHS, type IconName } from './icons';

const THEME_ORDER: readonly ThemeName[] = ['warm-night', 'warm-paper', 'forest', 'slate', 'magazine', 'night', 'paper'];

function section(title: string, ...children: Node[]): HTMLElement {
  return el('section', {}, el('h2', { text: title }), ...children);
}

/** 统计当前真正生效的 backdrop-filter 层数。 */
export function countGlassLayers(root: ParentNode = document): number {
  let n = 0;
  for (const node of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    const cs = getComputedStyle(node);
    const v = cs.backdropFilter || cs.getPropertyValue('-webkit-backdrop-filter');
    if (v !== '' && v !== 'none') n += 1;
  }
  return n;
}

export function renderKit(state: State, deps: ViewDeps): HTMLElement {
  const s = state.settings;
  const patch = (p: Partial<typeof s>): void => deps.dispatch({ type: 'settings/changed', patch: p });
  const scheme = THEME_SCHEME[resolveTheme(s.theme, systemPrefersDark())];

  const themes = el('div', { class: 'kit__row', 'data-testid': 'kit-themes' });
  for (const t of ['system', ...THEME_ORDER] as ThemeChoice[]) {
    themes.append(
      themeChoice({ theme: t, pressed: s.theme === t, testId: `kit-theme-${t}`, onSelect: () => patch({ theme: t }) }),
    );
  }

  const glassCount = el('div', { 'data-testid': 'glass-count', text: '玻璃层：…' });
  const refreshCount = (): void => {
    requestAnimationFrame(() => {
      const n = countGlassLayers(document);
      glassCount.textContent = `玻璃层：${n} / 3`;
      glassCount.setAttribute('data-count', String(n));
    });
  };

  const demoNav = el(
    'div',
    { class: 'kit__glass-demo glass', 'data-testid': 'kit-glass-nav' },
    icon('shelf'), icon('search'),
    button({ icon: 'plus', variant: 'primary', round: true, testId: 'kit-fab', ariaLabel: '导入', onClick: () => undefined }),
    icon('chart'), icon('settings'),
  );
  const demoToolbar = el(
    'div',
    { class: 'kit__glass-demo glass', 'data-testid': 'kit-glass-toolbar' },
    icon('drop'), icon('underline'), icon('note'), icon('search'), icon('more'),
  );

  const icons = el('div', { class: 'kit__row', 'data-testid': 'kit-icons' });
  for (const name of Object.keys(ICON_PATHS) as IconName[]) icons.append(el('span', { title: name }, icon(name)));

  const header = el(
    'header',
    { class: 'appbar' },
    el('button', {
      class: 'icon-btn', type: 'button', 'data-testid': 'kit-back', 'aria-label': '返回',
      onclick: () => deps.dispatch({ type: 'nav/back' }),
    }, icon('back')),
    el('h1', { class: 'appbar__title', 'data-testid': 'app-title', text: '组件展示 · Kit' }),
    el('span', { class: 'appbar__spacer', 'aria-hidden': 'true' }),
  );

  const body = el(
    'main',
    { class: 'main' },
    el(
      'div',
      { class: 'kit', 'data-testid': 'kit' },
      section('主题', themes),
      section('强调色（8 色 + 跟随主题）', accentPalette({
        value: s.accent, scheme, accents: ACCENTS, onSelect: (accent) => patch({ accent }),
      })),
      section(
        '材质与动效',
        el('div', { class: 'kit__row' },
          segmentedControl<MaterialName>({
            value: s.material, testId: 'kit-material',
            items: [
              { value: 'glass', label: '玻璃', testId: 'kit-material-glass' },
              { value: 'soft', label: '柔和半透明', testId: 'kit-material-soft' },
              { value: 'solid', label: '纯色', testId: 'kit-material-solid' },
            ],
            onSelect: (material) => patch({ material }),
          }),
          segmentedControl<MotionLevel>({
            value: s.motion, testId: 'kit-motion',
            items: [
              { value: 'off', label: '关', testId: 'kit-motion-off' },
              { value: 'simple', label: '简约', testId: 'kit-motion-simple' },
              { value: 'full', label: '完整', testId: 'kit-motion-full' },
            ],
            onSelect: (motion) => patch({ motion }),
          })),
        slider({
          value: s.glassLevel, min: GLASS_LEVEL_MIN, max: GLASS_LEVEL_MAX, testId: 'kit-glass-level',
          ariaLabel: '玻璃强度', onInput: (glassLevel) => patch({ glassLevel }),
        }),
      ),
      section(
        '玻璃（只用于小面积悬浮层）',
        el('div', { class: 'kit__backdrop' }, demoNav, demoToolbar),
        glassCount,
      ),
      section(
        '按钮 / 开关 / 胶囊',
        el('div', { class: 'kit__row' },
          button({ label: '导入文档', variant: 'primary', testId: 'kit-btn-primary', onClick: () => undefined }),
          button({ label: '次要', testId: 'kit-btn-default', onClick: () => undefined }),
          button({ label: '描边', variant: 'ghost', testId: 'kit-btn-ghost', onClick: () => undefined }),
          button({ icon: 'play', round: true, variant: 'primary', testId: 'kit-btn-play', ariaLabel: '继续阅读', onClick: () => undefined }),
          switchControl({ checked: true, testId: 'kit-switch-on', ariaLabel: '开', onChange: () => undefined }),
          switchControl({ checked: false, testId: 'kit-switch-off', ariaLabel: '关', onChange: () => undefined }),
          chip({ label: '全部', pressed: true, testId: 'kit-chip-on', onToggle: () => undefined }),
          chip({ label: '收藏', pressed: false, testId: 'kit-chip-off', onToggle: () => undefined })),
      ),
      section(
        '卡片（实色，不用玻璃）',
        card({ testId: 'kit-card' }, el('strong', { text: '技术写作指南' }), el('div', { text: '3 天前阅读 · 68%' })),
        card({ testId: 'kit-card-hero', hero: true }, el('strong', { text: '阅读，是为了遇见更大的世界。' })),
      ),
      section('图标（统一线性 · 2px 描边）', icons),
      section('主题名', el('div', { text: THEME_ORDER.map((t) => THEME_LABELS[t]).join(' · ') })),
    ),
  );

  refreshCount();
  return el('div', { class: 'shell', 'data-testid': 'shell' }, header, body);
}
