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

describe('设置迁移 v2 → v3（自定义横幅图与语录）', () => {
  const v2 = {
    theme: 'warm-night', accent: 'amber', material: 'glass', glassLevel: 2, motion: 'full',
    materialHinted: true, typeScale: 3, lineScale: 3, paraScale: 2, fontFamily: 'serif',
    focusMode: false, lookupEnabled: true,
  };

  it('旧 v2 数据可读：原有字段保留，新字段落默认值', () => {
    const s = coerceSettings(v2);
    expect(s.theme).toBe('warm-night');
    expect(s.accent).toBe('amber');
    expect(s.bannerImage).toBeNull();
    expect(s.quotes).toEqual([]);
  });

  it('自定义横幅图与语录能往返（语录去空白、去重、丢非法项）', () => {
    const banner = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    const s = coerceSettings({
      ...v2,
      bannerImage: banner,
      quotes: ['  读书   让人自由 ', '', '读书 让人自由', 42, '第二条'],
    });
    expect(s.bannerImage).toBe(banner);
    expect(s.quotes).toEqual(['读书 让人自由', '第二条']);
    expect(coerceSettings(s)).toEqual(s);
  });

  it('非图片 data URL / 超长横幅图回落 null（不写坏 localStorage）', () => {
    expect(coerceSettings({ ...v2, bannerImage: 'javascript:alert(1)' }).bannerImage).toBeNull();
    expect(coerceSettings({ ...v2, bannerImage: 'data:text/plain;base64,AAAA' }).bannerImage).toBeNull();
    expect(coerceSettings({ ...v2, bannerImage: `data:image/png;base64,${'A'.repeat(1_000_001)}` }).bannerImage).toBeNull();
  });
});
