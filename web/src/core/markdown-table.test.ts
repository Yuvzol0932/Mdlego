import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

const TABLE_MD =
  '| 单词 | 词性 | 释义 |\n| --- | --- | --- |\n| inspect | v. | 检查，仔细看 |\n| conspicuous | adj. | 显眼的，引人注目的 |';

describe('表格外层滚动容器', () => {
  it('表格被 .table-wrap 包裹', () => {
    const { html } = renderMarkdown(TABLE_MD);
    expect(html).toMatch(/<div class="table-wrap">\s*<table>/);
  });

  it('包裹层正确闭合', () => {
    const { html } = renderMarkdown(TABLE_MD);
    expect(html).toMatch(/<\/table>\s*<\/div>/);
  });

  it('包裹层出现在正文段落之间时结构仍正确', () => {
    const md = ['前面的段落。', '', TABLE_MD, '', '后面的段落。'].join('\n');
    const { html } = renderMarkdown(md);
    const pBefore = html.indexOf('前面的段落');
    const wrapStart = html.indexOf('<div class="table-wrap">');
    const wrapEnd = html.search(/<\/table>\s*<\/div>/);
    const pAfter = html.indexOf('后面的段落');
    expect(pBefore).toBeGreaterThan(-1);
    expect(wrapStart).toBeGreaterThan(pBefore);
    expect(wrapEnd).toBeGreaterThan(wrapStart);
    expect(pAfter).toBeGreaterThan(wrapEnd);
  });

  it('多个表格各自独立包裹（且不会重复包装）', () => {
    const md = [TABLE_MD, '', TABLE_MD].join('\n');
    const { html } = renderMarkdown(md);
    const opens = html.match(/<div class="table-wrap">/g) ?? [];
    const closes = html.match(/<\/table>\s*<\/div>/g) ?? [];
    expect(opens.length).toBe(2);
    expect(closes.length).toBe(2);
    // 关键回归断言：不能出现嵌套包裹
    expect(html).not.toContain('<div class="table-wrap"><div class="table-wrap">');
  });

  it('多次渲染不会累积包装层（解析器复用回归）', () => {
    const first = renderMarkdown(TABLE_MD).html;
    const second = renderMarkdown(TABLE_MD).html;
    const third = renderMarkdown(TABLE_MD).html;
    const countWraps = (s: string): number => (s.match(/<div class="table-wrap">/g) ?? []).length;
    expect(countWraps(first)).toBe(1);
    expect(countWraps(second)).toBe(1);
    expect(countWraps(third)).toBe(1);
  });

  it('无表格时不产生多余包裹层', () => {
    const { html } = renderMarkdown('只有段落，没有表格。');
    expect(html).not.toContain('table-wrap');
  });

  it('表格单元格的 data-bid 仍然保留', () => {
    const { html } = renderMarkdown(TABLE_MD);
    const bids = [...html.matchAll(/data-bid="(t[dh]-[^"]+)"/g)].map((m) => m[1]);
    // 3 列 × (1 表头行 + 2 数据行) = 9 个单元格
    expect(bids.length).toBe(9);
  });

  it('包裹层不影响 blockCount 计数', () => {
    const withTable = renderMarkdown(TABLE_MD);
    expect(withTable.blockCount).toBe(9);
  });

  it('每个表格顶部配有且仅配一个全屏按钮（.table-box / table-expand）', () => {
    const md = [TABLE_MD, '', TABLE_MD].join('\n');
    const { html } = renderMarkdown(md);
    const boxes = html.match(/<div class="table-box">/g) ?? [];
    const btns = html.match(/data-testid="table-expand"/g) ?? [];
    expect(boxes).toHaveLength(2);
    expect(btns).toHaveLength(2);
  });

  it('多次渲染不会重复生成全屏按钮', () => {
    const first = renderMarkdown(TABLE_MD).html;
    const second = renderMarkdown(TABLE_MD).html;
    const countBtns = (s: string): number => (s.match(/data-testid="table-expand"/g) ?? []).length;
    expect(countBtns(first)).toBe(1);
    expect(countBtns(second)).toBe(1);
  });
});
