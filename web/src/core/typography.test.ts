import { describe, expect, it } from 'vitest';
import {
  clampScale,
  DEFAULT_TYPE_PREFS,
  LINE_SCALE_LABELS,
  LINE_SCALE_MAX,
  LINE_SCALE_MIN,
  normalizeTypePrefs,
  PARA_SCALE_LABELS,
  PARA_SCALE_MAX,
  PARA_SCALE_MIN,
  typeAttributes,
  TYPE_SCALE_LABELS,
  TYPE_SCALE_MAX,
  TYPE_SCALE_MIN,
  typePrefsFromSettings,
} from './typography';
import type { Settings } from './types';

const BASE_SETTINGS: Settings = {
  theme: 'magazine',
  accent: 'theme',
  material: 'glass',
  glassLevel: 2,
  motion: 'full',
  materialHinted: false,
  typeScale: 3,
  lineScale: 3,
  paraScale: 2,
  fontFamily: 'serif',
  focusMode: false,
  lookupEnabled: true,
};

describe('clampScale', () => {
  it('区间内取整返回', () => {
    expect(clampScale(3.4, 1, 7)).toBe(3);
    expect(clampScale(3.6, 1, 7)).toBe(4);
  });

  it('低于下限夹到下限', () => {
    expect(clampScale(-5, 1, 7)).toBe(1);
    expect(clampScale(0, 1, 7)).toBe(1);
  });

  it('高于上限夹到上限', () => {
    expect(clampScale(99, 1, 7)).toBe(7);
  });

  it('NaN / Infinity 回落到下限而非崩溃', () => {
    expect(clampScale(Number.NaN, 1, 7)).toBe(1);
    expect(clampScale(Number.POSITIVE_INFINITY, 1, 7)).toBe(1);
  });
});

describe('normalizeTypePrefs', () => {
  it('空输入得到默认值', () => {
    const p = normalizeTypePrefs(null);
    expect(p).toEqual(DEFAULT_TYPE_PREFS);
  });

  it('undefined 得到默认值', () => {
    expect(normalizeTypePrefs(undefined)).toEqual(DEFAULT_TYPE_PREFS);
  });

  it('合法输入原样保留', () => {
    const p = normalizeTypePrefs({
      typeScale: 5,
      lineScale: 2,
      paraScale: 3,
      fontFamily: 'sans',
    });
    expect(p).toEqual({ typeScale: 5, lineScale: 2, paraScale: 3, fontFamily: 'sans' });
  });

  it('越界值被夹紧', () => {
    const p = normalizeTypePrefs({ typeScale: 99, lineScale: -3, paraScale: 50 });
    expect(p.typeScale).toBe(TYPE_SCALE_MAX);
    expect(p.lineScale).toBe(LINE_SCALE_MIN);
    expect(p.paraScale).toBe(PARA_SCALE_MAX);
  });

  it('非法字体回落到 serif', () => {
    const p = normalizeTypePrefs({ fontFamily: 'comic-sans' as 'sans' });
    expect(p.fontFamily).toBe('serif');
  });

  it('只给部分字段时其余取默认', () => {
    const p = normalizeTypePrefs({ typeScale: 6 });
    expect(p.typeScale).toBe(6);
    expect(p.lineScale).toBe(DEFAULT_TYPE_PREFS.lineScale);
    expect(p.fontFamily).toBe(DEFAULT_TYPE_PREFS.fontFamily);
  });
});

describe('typeAttributes', () => {
  it('输出四个 data 属性', () => {
    const attrs = typeAttributes(DEFAULT_TYPE_PREFS);
    expect(Object.keys(attrs).sort()).toEqual([
      'data-font',
      'data-line-scale',
      'data-para-scale',
      'data-type-scale',
    ]);
  });

  it('数值被转成字符串', () => {
    const attrs = typeAttributes({
      typeScale: 5,
      lineScale: 2,
      paraScale: 1,
      fontFamily: 'sans',
    });
    expect(attrs['data-type-scale']).toBe('5');
    expect(attrs['data-line-scale']).toBe('2');
    expect(attrs['data-para-scale']).toBe('1');
    expect(attrs['data-font']).toBe('sans');
  });

  it('越界输入也被规范化后再输出', () => {
    const attrs = typeAttributes({
      typeScale: 999,
      lineScale: 0,
      paraScale: 0,
      fontFamily: 'serif',
    });
    expect(attrs['data-type-scale']).toBe(String(TYPE_SCALE_MAX));
    expect(attrs['data-line-scale']).toBe(String(LINE_SCALE_MIN));
  });
});

describe('typePrefsFromSettings', () => {
  it('从 Settings 正确提取排版字段', () => {
    const p = typePrefsFromSettings({ ...BASE_SETTINGS, typeScale: 4, lineScale: 5 });
    expect(p.typeScale).toBe(4);
    expect(p.lineScale).toBe(5);
    expect(p.paraScale).toBe(2);
    expect(p.fontFamily).toBe('serif');
  });

  it('Settings 里越界的值也会被夹紧', () => {
    const p = typePrefsFromSettings({ ...BASE_SETTINGS, typeScale: -1 });
    expect(p.typeScale).toBe(TYPE_SCALE_MIN);
  });
});

describe('档位标签', () => {
  it('字号标签数量与档位范围一致', () => {
    expect(TYPE_SCALE_LABELS.length).toBe(TYPE_SCALE_MAX - TYPE_SCALE_MIN + 1);
  });

  it('行高标签数量与档位范围一致', () => {
    expect(LINE_SCALE_LABELS.length).toBe(LINE_SCALE_MAX - LINE_SCALE_MIN + 1);
  });

  it('段落标签数量与档位范围一致', () => {
    expect(PARA_SCALE_LABELS.length).toBe(PARA_SCALE_MAX - PARA_SCALE_MIN + 1);
  });

  it('标签全部非空', () => {
    for (const label of [...TYPE_SCALE_LABELS, ...LINE_SCALE_LABELS, ...PARA_SCALE_LABELS]) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
