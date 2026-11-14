import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

/** 提取 HTML 中所有 data-task-bid 元素内部的纯文本。 */
function taskTexts(html: string): string[] {
  const out: string[] = [];
  const re = /<li[^>]*data-task="true"[^>]*>([\s\S]*?)<\/li>/g;
  for (const m of html.matchAll(re)) {
    const inner = (m[1] ?? '')
      .replace(/<input[^>]*>/g, '')
      .replace(/<[^>]+>/g, '')
      .trim();
    out.push(inner);
  }
  return out;
}

describe('任务清单 —— 文字必须保留', () => {
  it('未勾选项目的文字完整保留', () => {
    const { html } = renderMarkdown('- [ ] 拆分主干与修饰成分');
    expect(taskTexts(html)).toEqual(['拆分主干与修饰成分']);
  });

  it('已勾选项目的文字完整保留', () => {
    const { html } = renderMarkdown('- [x] 已完成的任务');
    expect(taskTexts(html)).toEqual(['已完成的任务']);
  });

  it('多个任务项逐一保留文字', () => {
    const md = ['- [x] 第一件事', '- [ ] 第二件事', '- [ ] 第三件事'].join('\n');
    expect(taskTexts(renderMarkdown(md).html)).toEqual(['第一件事', '第二件事', '第三件事']);
  });

  it('文字里带行内强调时仍保留可读文本', () => {
    const { html } = renderMarkdown('- [ ] 标记 **重点** 内容');
    expect(taskTexts(html)).toEqual(['标记 重点 内容']);
  });

  it('复选框自身仍然存在且带状态', () => {
    const { html } = renderMarkdown('- [x] 完成任务');
    expect(html).toContain('class="task-box"');
    expect(html).toContain('data-task-checked="1"');
    expect(html).toContain(' checked');
  });
});
