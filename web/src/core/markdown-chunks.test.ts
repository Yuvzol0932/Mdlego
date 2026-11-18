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
