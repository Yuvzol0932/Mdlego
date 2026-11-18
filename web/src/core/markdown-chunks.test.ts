import { describe, expect, it } from 'vitest';
import { FIRST_SCREEN_BLOCKS, renderMarkdown } from './markdown';

/** 覆盖所有会跨块落边界的结构：标题、段落、列表、引用、表格、围栏、任务、hr。 */
const SAMPLE = `# 标题

第一段。

## 小节一

- 项目一
- 项目二
  - 嵌套 A
  - 嵌套 B

1. 有序一
2. 有序二

> 引用文字
> 第二行

| 列 A | 列 B |
| --- | --- |
| 1 | 2 |
| 3 | 4 |

\`\`\`ts
const a = 1;
const b = 2;
\`\`\`

- [x] 已完成
- [ ] 未完成

---

### 小节二

最后一段，**加粗** 和 \`内联代码\`。

${Array.from({ length: 30 }, (_, i) => `填充段落 ${i}：把总块数撑过首屏上限，确保分片边界真的发生。`).join('\n\n')}
`;

function bidCount(html: string): number {
  return [...html.matchAll(/data-bid="/g)].length;
}

describe('renderMarkdown — 分块渲染', () => {
  it('分片拼接等于一次性渲染的 HTML', () => {
    const full = renderMarkdown(SAMPLE);
    const chunked = renderMarkdown(SAMPLE, { lazy: true });
    const drained = [...chunked.htmlChunks];
    expect(drained.length).toBeGreaterThan(1);
    expect(drained.join('')).toBe(full.html);
    expect(chunked.html).toBe(full.html);
  });

  it('懒分片：htmlChunks 访问后补齐，首片独立且不改写', () => {
    const chunked = renderMarkdown(SAMPLE, { lazy: true });
    const first = chunked.firstHtmlChunk;
    expect(first.length).toBeGreaterThan(0);
    expect(first.startsWith('<h1')).toBe(true);
    // 逐片取，拼起来必须与全量一致（顺序不能乱）
    const rest: string[] = [];
    for (let next = chunked.nextHtmlChunk?.(); next !== null && next !== undefined; next = chunked.nextHtmlChunk?.()) {
      rest.push(next);
    }
    expect(first + rest.join('')).toBe(renderMarkdown(SAMPLE).html);
    expect(chunked.firstHtmlChunk).toBe(first);
  });

  it('首片块数 ≤ 首屏块数上限，长文后续分片存在', () => {
    const long = Array.from({ length: 120 }, (_, i) => `段落 ${i}：用于把正文撑到多块。`).join('\n\n');
    const chunked = renderMarkdown(`# 长文\n\n${long}`, { lazy: true });
    const firstBids = bidCount(chunked.firstHtmlChunk);
    expect(firstBids).toBeGreaterThan(0);
    expect(firstBids).toBeLessThanOrEqual(FIRST_SCREEN_BLOCKS + 2);
    const total = bidCount(chunked.html);
    expect(total).toBeGreaterThan(firstBids);
    expect(chunked.html).toBe(renderMarkdown(`# 长文\n\n${long}`).html);
  });

  it('非懒渲染也给出分片，且 firstHtmlChunk 与首片一致', () => {
    const full = renderMarkdown(SAMPLE);
    expect(full.htmlChunks.length).toBeGreaterThan(1);
    expect(full.firstHtmlChunk).toBe(full.htmlChunks[0]);
    expect(full.nextHtmlChunk).toBeUndefined();
  });

  it('空文档分片安全', () => {
    const empty = renderMarkdown('', { lazy: true });
    expect(empty.html).toBe('');
    expect(empty.firstHtmlChunk).toBe('');
    expect(empty.htmlChunks).toEqual(['']);
  });
});

describe('renderMarkdown — 分片↔块区间（转场改造 Step 1 契约）', () => {
  it('blockIds 与 blockCount 等长，且与 HTML 里的 data-bid 顺序一致', () => {
    const render = renderMarkdown(SAMPLE);
    expect(render.blockIds.length).toBe(render.blockCount);
    const inHtml = [...render.html.matchAll(/data-bid="([^"]+)"/g)].map((m) => m[1]);
    expect(inHtml).toEqual([...render.blockIds]);
  });

  it('chunkBlockRanges 覆盖 0..blockCount 无重叠无缺口', () => {
    const render = renderMarkdown(SAMPLE);
    expect(render.chunkBlockRanges.length).toBe(render.htmlChunks.length);
    let cursor = 0;
    for (const range of render.chunkBlockRanges) {
      expect(range.startIdx).toBe(cursor);
      expect(range.endIdx).toBeGreaterThanOrEqual(range.startIdx);
      cursor = range.endIdx;
    }
    expect(cursor).toBe(render.blockCount);
  });

  it('每片 HTML 的块数等于该片声明的区间宽度', () => {
    const render = renderMarkdown(SAMPLE);
    render.htmlChunks.forEach((html, index) => {
      const range = render.chunkBlockRanges[index];
      expect(range).toBeDefined();
      expect(bidCount(html)).toBe(range!.endIdx - range!.startIdx);
    });
  });

  it('htmlChunkAt 可按索引随机取片，越界返回 null', () => {
    const render = renderMarkdown(SAMPLE);
    const last = render.htmlChunks.length - 1;
    expect(render.htmlChunkAt(0)).toBe(render.firstHtmlChunk);
    expect(render.htmlChunkAt(last)).toBe(render.htmlChunks[last]);
    expect(render.htmlChunkAt(last + 1)).toBeNull();
    expect(render.htmlChunkAt(-1)).toBeNull();
  });

  it('懒渲染：htmlChunkAt 跳过未渲染的中间片，之后仍能补齐全量', () => {
    const render = renderMarkdown(SAMPLE, { lazy: true });
    const last = render.htmlChunks.length - 1;
    // 直接取最后一片（懒渲染下前面还有片没渲染）
    const tail = render.htmlChunkAt(last);
    expect(tail).not.toBeNull();
    expect(tail).toBe(render.htmlChunks[last]);
    // 补齐后全新量仍然等价
    expect(render.html).toBe(renderMarkdown(SAMPLE).html);
  });

  it('懒渲染重复取同一片只渲染一次（结果稳定）', () => {
    const render = renderMarkdown(SAMPLE, { lazy: true });
    const a = render.htmlChunkAt(1);
    const b = render.htmlChunkAt(1);
    expect(a).toBe(b);
  });
});

describe('正文首段标记 data-lede：与挂载区间解耦（转场改造 Step 1 回归）', () => {
  it('首段只标记一次，且落在文档第一个顶层段落上', () => {
    const html = renderMarkdown('# 标题\n\n第一段。\n\n第二段。\n\n第三段。\n').html;
    expect(html.match(/data-lede/g) ?? []).toHaveLength(1);
    // 标记必须落在「第一段」这段文字上
    const lede = /<p[^>]*data-lede[^>]*>([^<]*)/.exec(html);
    expect(lede?.[1]).toContain('第一段');
  });

  it('分隔线只是分隔符，不占首段名额', () => {
    const html = renderMarkdown('---\n\n分隔线后才是首段。\n').html;
    expect(html.match(/data-lede/g) ?? []).toHaveLength(1);
    const lede = /<p[^>]*data-lede[^>]*>([^<]*)/.exec(html);
    expect(lede?.[1]).toContain('分隔线后才是首段');
  });

  it('标题在前时不占首段名额', () => {
    const html = renderMarkdown('# 一级\n\n## 二级\n\n正文首段。\n').html;
    expect(html.match(/data-lede/g) ?? []).toHaveLength(1);
    const lede = /<p[^>]*data-lede[^>]*>([^<]*)/.exec(html);
    expect(lede?.[1]).toContain('正文首段');
  });

  it('文档以列表/引用/代码开头时没有首段（不误标中段段落）', () => {
    for (const source of [
      '- 列表第一项\n- 第二项\n\n后面才有段落。\n',
      '> 引用\n\n后面才有段落。\n',
      '```ts\nconst a = 1;\n```\n\n后面才有段落。\n',
    ]) {
      const html = renderMarkdown(source).html;
      expect(html.match(/data-lede/g) ?? [], source).toHaveLength(0);
    }
  });

  it('懒渲染与全量渲染的首段标记一致（分片不能改变标记位置）', () => {
    const source = '# 标题\n\n' + Array.from({ length: 120 }, (_, i) => `第 ${i} 段。`).join('\n\n') + '\n';
    const full = renderMarkdown(source);
    const lazy = renderMarkdown(source, { lazy: true });
    // 全量补齐懒渲染的所有分片
    for (let i = 0; i < lazy.htmlChunks.length; i++) lazy.htmlChunkAt(i);
    expect(lazy.html).toBe(full.html);
    expect(lazy.html.match(/data-lede/g) ?? []).toHaveLength(1);
  });

  it('分片取子集渲染时首段标记不会漂移到别段（核心回归）', () => {
    // 模拟阅读页「从中间开始挂分片」：只渲染后半段
    const source = Array.from({ length: 200 }, (_, i) => `段落 ${i}。`).join('\n\n') + '\n';
    const full = renderMarkdown(source);
    const firstChunkLede = /data-lede/.test(full.htmlChunkAt(0) ?? '');
    expect(firstChunkLede).toBe(true);
    // 后面任何一片都不得再出现 data-lede
    for (let i = 1; i < full.htmlChunks.length; i++) {
      expect(/data-lede/.test(full.htmlChunkAt(i) ?? ''), `chunk ${i}`).toBe(false);
    }
  });
});
