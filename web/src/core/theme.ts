/**
 * 主题与材质的纯逻辑：把「用户设置」解析成「该写到根节点的属性」。
 * 不读 window；系统明暗、硬件核数由调用方传入。
 */

import type { AccentName, MaterialName, ThemeChoice, ThemeName } from './types';

/** 主题 → 明暗。CSS 的强调色预设按明暗分档，所以必须有这张表。 */
export const THEME_SCHEME: Readonly<Record<ThemeName, 'light' | 'dark'>> = {
  'warm-night': 'dark',
  'warm-paper': 'light',
  forest: 'dark',
  slate: 'dark',
  magazine: 'light',
  night: 'dark',
  paper: 'light',
};

/** 跟随系统时落到哪两套主力主题。 */
export const SYSTEM_LIGHT: ThemeName = 'warm-paper';
export const SYSTEM_DARK: ThemeName = 'warm-night';

export const THEME_LABELS: Readonly<Record<ThemeName, string>> = {
  'warm-night': '夜间·暖黑',
  'warm-paper': '日间·米纸',
  forest: '墨绿',
  slate: '冷灰',
  magazine: '杂志',
  night: '夜间',
  paper: '纸面',
};

/** 强调色预设（顺序即色盘顺序）。 */
export const ACCENTS: readonly AccentName[] = [
  'amber', 'rust', 'jade', 'sky', 'rose', 'violet', 'olive', 'slate',
];

export const ACCENT_LABELS: Readonly<Record<AccentName, string>> = {
  amber: '琥珀', rust: '锈红', jade: '青玉', sky: '天青',
  rose: '玫瑰', violet: '紫藤', olive: '橄榄', slate: '石墨',
};

export const GLASS_LEVEL_MIN = 1;
export const GLASS_LEVEL_MAX = 3;

/** 写到 <html> 上的属性集合。 */
export interface VisualAttrs {
  readonly 'data-theme': ThemeName;
  readonly 'data-scheme': 'light' | 'dark';
  /** null 表示「跟随主题默认强调色」，调用方应移除该属性。 */
  readonly 'data-accent': AccentName | null;
  readonly 'data-material': MaterialName;
  readonly 'data-glass': string;
  readonly 'data-motion': 'off' | 'simple' | 'full';
}

/** 把 ThemeChoice 解析成具体主题。 */
export function resolveTheme(choice: ThemeChoice, systemDark: boolean): ThemeName {
  if (choice === 'system') return systemDark ? SYSTEM_DARK : SYSTEM_LIGHT;
  return choice;
}

export function visualAttrs(
  s: {
    theme: ThemeChoice;
    accent: AccentName | 'theme';
    material: MaterialName;
    glassLevel: number;
    motion: 'off' | 'simple' | 'full';
  },
  systemDark: boolean,
): VisualAttrs {
  const theme = resolveTheme(s.theme, systemDark);
  return {
    'data-theme': theme,
    'data-scheme': THEME_SCHEME[theme],
    'data-accent': s.accent === 'theme' ? null : s.accent,
    'data-material': s.material,
    'data-glass': String(Math.min(GLASS_LEVEL_MAX, Math.max(GLASS_LEVEL_MIN, Math.round(s.glassLevel)))),
    'data-motion': s.motion,
  };
}

/**
 * 启动自检：低端机建议用「柔和半透明」。
 * 只在材质仍是默认的「玻璃」时才建议；用户已主动选过就不再打扰。
 */
export function suggestMaterial(
  env: { cores: number | null; memoryGb: number | null },
  current: MaterialName,
): MaterialName | null {
  if (current !== 'glass') return null;
  const weakCpu = env.cores !== null && env.cores <= 4;
  const weakMem = env.memoryGb !== null && env.memoryGb <= 3;
  return weakCpu || weakMem ? 'soft' : null;
}
