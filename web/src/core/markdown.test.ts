import { describe, expect, it } from 'vitest';
import { escapeHtml, extractTitle, renderMarkdown } from './markdown';

/** 从 HTML 中取出所有 data-bid 值，按出现顺序。 */
function bids(html: string): string[] {
  return [...html.matchAll(/data-bid="([^"]+)"/g)].map((m) => m[1] ?? '');
}

describe('renderMarkdown — 基础渲染', () => {
  it('渲染标题', () => {
    const { html } = renderMarkdown('# 一级标题');
    expect(html).toContain('<h1');
    expect(html).toContain('一级标题');
  });

  it('渲染段落', () => {
    const { html } = renderMarkdown('这是一个段落。');
    expect(html).toContain('<p');
    expect(html).toContain('这是一个段落。');
  });

  it('渲染无序列表', () => {
    const { html } = renderMarkdown('- 项目一\n- 项目二');
    expect(html).toContain('<ul>');
    expect(html).toContain('项目一');
    expect(html).toContain('项目二');
  });

  it('渲染有序列表', () => {
    const { html } = renderMarkdown('1. 第一\n2. 第二');
    expect(html).toContain('<ol>');
  });

  it('渲染围栏代码块并保留语言类名', () => {
    const { html } = renderMarkdown('```ts\nconst a = 1;\n```');
    expect(html).toContain('language-ts');
    expect(html).toContain('const a = 1;');
  });

  it('渲染表格', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const { html } = renderMarkdown(md);
    expect(html).toContain('<table>');
    expect(html).toContain('<th');
    expect(html).toContain('<td');
  });

  it('渲染引用块', () => {
    const { html } = renderMarkdown('> 引用内容');
    expect(html).toContain('<blockquote>');
  });

  it('渲染任务清单复选框', () => {
    const { html } = renderMarkdown('- [ ] 未完成\n- [x] 已完成');
    expect(html).toContain('type="checkbox"');
  });

  it('渲染删除线', () => {
    const { html } = renderMarkdown('~~删除~~');
    expect(html).toContain('<s>');
  });

  it('渲染表格对齐', () => {
    const md = '| L | C | R |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |';
    const { html } = renderMarkdown(md);
    expect(html).toContain('text-align:left');
    expect(html).toContain('text-align:center');
    expect(html).toContain('text-align:right');
  });
});

describe('renderMarkdown — ==高亮== 扩展', () => {
  it('把 ==文字== 转成 <mark>', () => {
    const { html } = renderMarkdown('这里有 ==重点内容== 需要记住');
    expect(html).toContain('<mark>重点内容</mark>');
  });

  it('不误伤单个等号', () => {
    const { html } = renderMarkdown('a = b');
    expect(html).not.toContain('<mark>');
  });

  it('不支持跨行高亮（保持行内语义）', () => {
    const { html } = renderMarkdown('==第一行\n第二行==');
    expect(html).not.toContain('<mark>');
  });

  it('空内容不转换', () => {
    const { html } = renderMarkdown('====');
    expect(html).not.toContain('<mark>');
  });
});

describe('renderMarkdown — 安全：原文 HTML 必须转义', () => {
  it('转义裸 script 标签（不得生成 script 元素）', () => {
    const { html } = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script');
  });

  it('转义裸 img onerror（不得生成 img 元素，属性只能作文本出现）', () => {
    const { html } = renderMarkdown('<img src=x onerror=alert(1)>');
    // 关键断言：没有生成真实的 img 标签
    expect(html).not.toMatch(/<img\s/i);
    expect(html).toContain('&lt;img');
  });

  it('转义 iframe 标签', () => {
    const { html } = renderMarkdown('<iframe src="evil"></iframe>');
    expect(html).not.toContain('<iframe');
  });

  it('拦截 javascript: 链接（不得生成 href）', () => {
    const { html } = renderMarkdown('[点我](javascript:alert(1))');
    // 关键断言：dangerous scheme 绝不能出现在 href 属性里
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).not.toMatch(/<a\s/i);
  });

  it('拦截 vbscript: 链接', () => {
    const { html } = renderMarkdown('[点我](vbscript:msgbox(1))');
    expect(html).not.toMatch(/href="vbscript:/i);
    expect(html).not.toMatch(/<a\s/i);
  });

  it('放行正常 https 链接', () => {
    const { html } = renderMarkdown('[官网](https://example.com)');
    expect(html).toContain('href="https://example.com"');
  });

  it('放行相对链接与锚点', () => {
    const { html } = renderMarkdown('[跳转](#section)');
    expect(html).toContain('href="#section"');
  });

  it('图片 src 不得是 javascript:', () => {
    const { html } = renderMarkdown('![x](javascript:alert(1))');
    expect(html).not.toMatch(/src="javascript:/i);
  });
});

describe('renderMarkdown — data-bid 锚点', () => {
  it('段落带 data-bid', () => {
    const { html } = renderMarkdown('一个段落');
    expect(bids(html).length).toBe(1);
  });

  it('标题带 data-bid', () => {
    const { html } = renderMarkdown('# 标题');
    expect(bids(html).length).toBe(1);
  });

  it('列表项带 data-bid', () => {
    const { html } = renderMarkdown('- 一\n- 二\n- 三');
    expect(bids(html).length).toBe(3);
  });

  it('表格每个单元格都带 data-bid', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const { html } = renderMarkdown(md);
    // 2 个表头 + 2 个数据格 = 4
    expect(bids(html).length).toBe(4);
  });

  it('代码块带 data-bid', () => {
    const { html } = renderMarkdown('```\ncode\n```');
    expect(bids(html).length).toBe(1);
  });

  it('同一文档内所有 bid 唯一', () => {
    const md = [
      '# 标题',
      '',
      '第一个段落。',
      '',
      '第二个段落。',
      '',
      '- 列表一',
      '- 列表二',
      '',
      '| X | Y |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '```js',
      'const x = 1;',
      '```',
    ].join('\n');
    const { html } = renderMarkdown(md);
    const list = bids(html);
    expect(list.length).toBeGreaterThan(0);
    expect(new Set(list).size).toBe(list.length);
  });

  it('blockCount 与实际 bid 数一致', () => {
    const md = '# A\n\n段落一\n\n段落二\n\n- x\n- y';
    const result = renderMarkdown(md);
    expect(result.blockCount).toBe(bids(result.html).length);
  });

  it('重复内容的列表项得到不同 bid', () => {
    const { html } = renderMarkdown('- 同样\n- 同样');
    const list = bids(html);
    expect(list.length).toBe(2);
    expect(list[0]).not.toBe(list[1]);
  });
});

describe('renderMarkdown — 目录', () => {
  it('提取各层级标题', () => {
    const md = '# 一\n## 二\n### 三';
    const { toc } = renderMarkdown(md);
    expect(toc.map((t) => t.level)).toEqual([1, 2, 3]);
    expect(toc.map((t) => t.text)).toEqual(['一', '二', '三']);
  });

  it('目录 bid 与正文标题 bid 一致', () => {
    const md = '# 第一章\n\n内容\n\n## 第一节\n\n更多内容';
    const { toc, html } = renderMarkdown(md);
    const htmlBids = bids(html);
    for (const entry of toc) {
      expect(htmlBids).toContain(entry.bid);
    }
  });

  it('无标题时目录为空', () => {
    const { toc } = renderMarkdown('只有段落，没有标题。');
    expect(toc).toEqual([]);
  });

  it('标题文本去除多余空白', () => {
    const { toc } = renderMarkdown('#   多余   空格   ');
    expect(toc[0]?.text).toBe('多余 空格');
  });

  it('忽略代码块里的 # 号', () => {
    const { toc } = renderMarkdown('```\n# 不是标题\n```');
    expect(toc).toEqual([]);
  });
});

describe('renderMarkdown — 中文与 GFM', () => {
  it('正确处理中文段落', () => {
    const { html } = renderMarkdown('中文内容，包含标点。');
    expect(html).toContain('中文内容，包含标点。');
  });

  it('自动识别裸链接', () => {
    const { html } = renderMarkdown('访问 https://example.com 查看');
    expect(html).toContain('href="https://example.com"');
  });

  it('保留软换行不合并段落', () => {
    const { html } = renderMarkdown('第一行\n第二行\n\n新段落');
    // <p> 上会带 data-bid，所以只断言段落边界与内部换行
    expect(html).toContain('第一行\n第二行</p>');
    expect(html).toContain('新段落</p>');
  });
});

describe('escapeHtml', () => {
  it('转义五个危险字符', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('普通文本原样返回', () => {
    expect(escapeHtml('普通文本 abc')).toBe('普通文本 abc');
  });
});

describe('extractTitle', () => {
  it('优先取一级标题', () => {
    expect(extractTitle('## 二级\n# 一级')).toBe('一级');
  });

  it('无一级标题时取首个标题', () => {
    expect(extractTitle('## 二级标题\n内容')).toBe('二级标题');
  });

  it('无标题返回 null', () => {
    expect(extractTitle('只有正文，没有标题')).toBeNull();
  });

  it('忽略空标题', () => {
    expect(extractTitle('#   \n## 实标题')).toBe('实标题');
  });

  it('去除标题尾部多余的 #', () => {
    expect(extractTitle('# 标题 ##')).toBe('标题');
  });

  it('中文标题正确处理', () => {
    expect(extractTitle('# 考研英语核心词根笔记')).toBe('考研英语核心词根笔记');
  });
});
