import { describe, expect, it } from 'vitest';
import { resolveTheme, suggestMaterial, THEME_SCHEME, visualAttrs } from './theme';

const base = { theme: 'system', accent: 'theme', material: 'glass', glassLevel: 2, motion: 'full' } as const;

describe('主题解析', () => {
  it('跟随系统：明→米纸，暗→暖黑', () => {
    expect(resolveTheme('system', false)).toBe('warm-paper');
    expect(resolveTheme('system', true)).toBe('warm-night');
  });
  it('固定主题不受系统明暗影响', () => {
    expect(resolveTheme('forest', false)).toBe('forest');
  });
  it('属性：scheme 与主题一致；accent=theme 时为 null', () => {
    const a = visualAttrs({ ...base, theme: 'warm-night' }, false);
    expect(a['data-scheme']).toBe('dark');
    expect(a['data-accent']).toBeNull();
    expect(visualAttrs({ ...base, accent: 'jade' }, false)['data-accent']).toBe('jade');
  });
  it('玻璃档位夹到 1..3', () => {
    expect(visualAttrs({ ...base, glassLevel: 0 }, false)['data-glass']).toBe('1');
    expect(visualAttrs({ ...base, glassLevel: 9 }, false)['data-glass']).toBe('3');
  });
  it('每个主题都有明暗归属', () => {
    expect(Object.keys(THEME_SCHEME)).toHaveLength(7);
  });
});

describe('材质自检', () => {
  it('低核数建议柔和；正常机器不建议', () => {
    expect(suggestMaterial({ cores: 4, memoryGb: null }, 'glass')).toBe('soft');
    expect(suggestMaterial({ cores: 8, memoryGb: 8 }, 'glass')).toBeNull();
    expect(suggestMaterial({ cores: null, memoryGb: null }, 'glass')).toBeNull();
  });
  it('用户已选过非玻璃就不再建议', () => {
    expect(suggestMaterial({ cores: 2, memoryGb: 2 }, 'solid')).toBeNull();
  });
});
