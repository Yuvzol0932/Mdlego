/**
 * HTML 导出单测（阶段 E6）。
 */

import { describe, expect, it } from 'vitest';
import { buildExportHtml, escapeHtml, type ExportPalette } from './export-html';

const PALETTE: ExportPalette = {
  ink: 'var(--ink)',
  paper: 'var(--paper)',
  soft: 'var(--ink-soft)',
  rule: 'var(--rule)',
  accent: 'var(--accent)',
  codeBg: 'var(--paper-raised)',
};

describe('HTML 导出', () => {
  it('包含标题、正文与内嵌样式，是完整文档', () => {
    const html = buildExportHtml({
      title: '文章 <标题>',
      bodyHtml: '<h1>正文</h1><p>段落</p>',
      dark: false,
      palette: PALETTE,
    });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>文章 &lt;标题&gt;</title>');
    expect(html).toContain('<h1>正文</h1>');
    expect(html).toContain('max-width: 46rem');
    expect(html).toContain('由墨读导出');
  });

  it('日/夜主题用不同纸面与墨色', () => {
    const light = buildExportHtml({ title: 't', bodyHtml: '<p>x</p>', dark: false, palette: PALETTE });
    const dark = buildExportHtml({ title: 't', bodyHtml: '<p>x</p>', dark: true, palette: PALETTE });
    expect(light).not.toBe(dark);
    expect(dark).toContain('color-scheme: dark');
    expect(light).toContain('color-scheme: light');
  });

  it('转义工具覆盖危险字符', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });
});
