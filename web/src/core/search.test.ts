import { describe, expect, it } from 'vitest';
import { extractBlockTexts, orderHitsByBlocks, searchInRender } from './search';
import { renderMarkdown } from './markdown';

describe('extractBlockTexts', () => {
  it('抽出段落文本', () => {
    const r = renderMarkdown('第一段内容\n\n第二段内容');
    const values = [...extractBlockTexts(r).values()];
    expect(values).toContain('第一段内容');
    expect(values).toContain('第二段内容');
  });

  it('块 id 与渲染结果中的 data-bid 一致', () => {
    const r = renderMarkdown('# 标题\n\n正文');
    const bids = [...r.html.matchAll(/data-bid="([^"]+)"/g)].map((m) => m[1] ?? '');
    const keys = [...extractBlockTexts(r).keys()];
    for (const bid of bids) expect(keys).toContain(bid);
  });

  it('含行内标签时取纯文本', () => {
    const r = renderMarkdown('这里有 **重点** 和 `代码`');
    expect([...extractBlockTexts(r).values()].join(' ')).toContain('这里有 重点 和 代码');
  });

  it('折叠多余空白', () => {
    const r = renderMarkdown('第一行\n第二行');
    expect([...extractBlockTexts(r).values()].join(' ')).toContain('第一行 第二行');
  });

  it('表格每个单元格都有文本', () => {
    const r = renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |');
    const values = [...extractBlockTexts(r).values()];
    expect(values).toContain('A');
    expect(values).toContain('1');
  });

  it('空文档返回空 Map', () => {
    expect(extractBlockTexts(renderMarkdown('')).size).toBe(0);
  });

  it('多次渲染不串数据（每次都是新 Map）', () => {
    const a = renderMarkdown('只有 A');
    const b = renderMarkdown('只有 B');
    expect([...extractBlockTexts(a).values()].join('')).toContain('A');
    expect([...extractBlockTexts(a).values()].join('')).not.toContain('B');
    expect([...extractBlockTexts(b).values()].join('')).toContain('B');
  });
});

describe('searchInRender', () => {
  const render = renderMarkdown(
    ['# 词根 -spect-', '', 'inspect 表示检查，仔细看。', '', 'retrospect 表示回顾。', '', 'prospect 表示前景。'].join('\n'),
  );

  it('找到英文命中（大小写不敏感）', () => {
    expect(searchInRender(render, 'doc-1', 'SPECT').length).toBeGreaterThanOrEqual(3);
  });

  it('命中带 bid 与块内偏移', () => {
    const hits = searchInRender(render, 'doc-1', 'inspect');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.bid).toMatch(/^p-|^h/);
    expect(hits[0]?.start).toBeGreaterThanOrEqual(0);
  });

  it('命中片段包含关键词', () => {
    expect(searchInRender(render, 'doc-1', 'retrospect')[0]?.snippet).toContain('retrospect');
  });

  it('docId 被正确带入', () => {
    expect(searchInRender(render, 'my-doc', 'inspect').every((h) => h.docId === 'my-doc')).toBe(true);
  });

  it('空关键词返回空', () => {
    expect(searchInRender(render, 'doc-1', '')).toEqual([]);
    expect(searchInRender(render, 'doc-1', '   ')).toEqual([]);
  });

  it('找不到时返回空数组', () => {
    expect(searchInRender(render, 'doc-1', 'zzzznotexist')).toEqual([]);
  });

  it('中文搜索', () => {
    expect(searchInRender(render, 'doc-1', '回顾').length).toBeGreaterThan(0);
  });

  it('同一个块里多次出现会分别命中', () => {
    const r = renderMarkdown('apple and apple and apple');
    expect(searchInRender(r, 'd', 'apple')).toHaveLength(3);
  });

  it('命中顺序按文档顺序', () => {
    const r = renderMarkdown('第一段 alpha\n\n第二段 alpha\n\n第三段 alpha');
    const hits = searchInRender(r, 'd', 'alpha');
    expect(hits[0]?.snippet).toContain('第一段');
    expect(hits[hits.length - 1]?.snippet).toContain('第三段');
  });

  it('不修改输入 render', () => {
    const before = render.html;
    searchInRender(render, 'd', 'inspect');
    expect(render.html).toBe(before);
  });

  it('搜索代码块内容', () => {
    const r = renderMarkdown('```ts\nconst inspect = 1;\n```');
    expect(searchInRender(r, 'd', 'inspect')).toHaveLength(1);
  });
});

describe('orderHitsByBlocks', () => {
  it('按块出现顺序排列', () => {
    const r = renderMarkdown('第一段 alpha\n\n第二段 alpha\n\n第三段 alpha');
    const hits = searchInRender(r, 'd', 'alpha');
    const ordered = orderHitsByBlocks([...hits].reverse(), r);
    expect(ordered[0]?.snippet).toContain('第一段');
    expect(ordered[ordered.length - 1]?.snippet).toContain('第三段');
  });

  it('空数组安全', () => {
    expect(orderHitsByBlocks([], renderMarkdown('内容'))).toEqual([]);
  });
});
