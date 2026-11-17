import { describe, expect, it } from 'vitest';
import { coerceSettings, DEFAULT_SETTINGS } from './settings-store';

describe('设置迁移 v1 → v2', () => {
  const v1 = {
    theme: 'night', typeScale: 5, lineScale: 2, paraScale: 3,
    fontFamily: 'sans', focusMode: true, lookupEnabled: false,
  };

  it('旧数据可读：原有字段原样保留，主题不被改掉', () => {
    const s = coerceSettings(v1);
    expect(s.theme).toBe('night');
    expect(s.typeScale).toBe(5);
    expect(s.fontFamily).toBe('sans');
    expect(s.focusMode).toBe(true);
    expect(s.lookupEnabled).toBe(false);
  });

  it('新字段全部落默认值', () => {
    const s = coerceSettings(v1);
    expect(s.accent).toBe('theme');
    expect(s.material).toBe('glass');
    expect(s.glassLevel).toBe(2);
    expect(s.motion).toBe('full');
    expect(s.materialHinted).toBe(false);
  });

  it('非法值回落默认，不抛错', () => {
    const s = coerceSettings({ theme: 'neon', accent: 'pink', material: 'x', glassLevel: 99, motion: 'wild' });
    expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(s.accent).toBe('theme');
    expect(s.material).toBe('glass');
    expect(s.glassLevel).toBe(3);
    expect(s.motion).toBe('full');
  });

  it('新主题与新字段能往返', () => {
    const s = coerceSettings({ theme: 'warm-night', accent: 'jade', material: 'solid', glassLevel: 1, motion: 'off', materialHinted: true });
    expect(s).toMatchObject({ theme: 'warm-night', accent: 'jade', material: 'solid', glassLevel: 1, motion: 'off', materialHinted: true });
    expect(coerceSettings(s)).toEqual(s);
  });

  it('垃圾输入 → 默认设置', () => {
    expect(coerceSettings(null)).toBe(DEFAULT_SETTINGS);
    expect(coerceSettings('x')).toBe(DEFAULT_SETTINGS);
  });
});
