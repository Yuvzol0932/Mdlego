import { describe, expect, it } from 'vitest';
import tokensCss from '../styles/tokens.css?raw';
import themesCss from '../styles/tokens-themes.css?raw';
import { contrastRatio } from './contrast';
import { THEME_SCHEME } from './theme';
import type { ThemeName } from './types';

/** 去掉 CSS 注释（不用正则：逐个找 slash-star … star-slash）。 */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('/*', i);
    if (open < 0) return out + text.slice(i);
    out += text.slice(i, open);
    const close = text.indexOf('*/', open + 2);
    i = close < 0 ? text.length : close + 2;
  }
  return out;
}

const css = stripComments(`${tokensCss}
${themesCss}`);

/** 取某个选择器块里的某个自定义属性（只认十六进制）。 */
function pick(selector: string, prop: string): string | null {
  // 选择器必须顶格写在行首且后接 " {"；同一选择器可能分布在多个块（含两个文件），全部扫一遍
  const head = `${selector} {`;
  let from = 0;
  for (;;) {
    let at = css.indexOf(`
${head}`, from);
    if (at < 0 && from === 0 && css.startsWith(head)) at = 0;
    if (at < 0) return null;
    const open = css.indexOf('{', at);
    const block = css.slice(open + 1, css.indexOf('}', open));
    const decl = block.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${prop}:`));
    const m = decl === undefined ? null : /#[0-9a-fA-F]{3,6}/.exec(decl);
    if (m !== null) return m[0];
    from = open + 1;
  }
}

const THEMES = Object.keys(THEME_SCHEME) as ThemeName[];
// magazine 是 :root 默认值，没有自己的块
const themeVar = (t: ThemeName, p: string): string => {
  const v = pick(`[data-theme='${t}']`, p) ?? (t === 'magazine' ? pick(':root', p) : null);
  if (v === null) throw new Error(`${t} 缺少 ${p}`);
  return v;
};

describe('对比度（正文 ≥ 4.5:1）', () => {
  for (const t of THEMES) {
    it(`${t}：正文与次级文字`, () => {
      const paper = themeVar(t, '--paper');
      const raised = themeVar(t, '--paper-raised');
      expect(contrastRatio(themeVar(t, '--ink'), paper)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(themeVar(t, '--ink'), raised)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(themeVar(t, '--ink-soft'), paper)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('暖黑/米纸的次级灰棕在卡片底上也 ≥ 4.5', () => {
    for (const t of ['warm-night', 'warm-paper'] as const) {
      expect(contrastRatio(themeVar(t, '--ink-faint'), themeVar(t, '--paper-raised'))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('强调色', () => {
  const accents = ['amber', 'rust', 'jade', 'sky', 'rose', 'violet', 'olive', 'slate'];
  for (const a of accents) {
    for (const scheme of ['light', 'dark'] as const) {
      it(`${a}/${scheme}：按钮文字 ≥ 4.5，强调色在纸面上 ≥ 3`, () => {
        const sel = `[data-accent='${a}'][data-scheme='${scheme}']`;
        const accent = pick(sel, '--accent');
        const on = pick(sel, '--on-accent');
        if (accent === null || on === null) throw new Error(`${sel} 缺色`);
        expect(contrastRatio(on, accent)).toBeGreaterThanOrEqual(4.5);
        // 该明暗下最有代表性的纸面：深色 → 暖黑，浅色 → 米纸
        const paper = themeVar(scheme === 'dark' ? 'warm-night' : 'warm-paper', '--paper');
        expect(contrastRatio(accent, paper)).toBeGreaterThanOrEqual(3);
      });
    }
  }

  it('各主题默认强调色按钮文字 ≥ 4.5', () => {
    for (const t of THEMES) {
      const accent = pick(`[data-theme='${t}']`, '--accent') ?? (t === 'magazine' ? pick(':root', '--accent') : null);
      const on = pick(`[data-theme='${t}']`, '--on-accent') ?? pick(':root', '--on-accent');
      if (accent === null || on === null) continue; // night/paper 的强调色在 tokens.css 的旧块里
      expect(contrastRatio(on, accent)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
