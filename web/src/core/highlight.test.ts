import { describe, expect, it } from 'vitest';
import { escapeHtml, highlightCode } from './highlight';

const KINDS = new Set(['comment', 'string', 'number', 'keyword', 'tag', 'attr']);

/** 取出所有 tok-* 类别。 */
function tokenKinds(html: string): string[] {
  return [...html.matchAll(/class="tok-([a-z]+)"/g)].map((m) => m[1] ?? '');
}

/** 去掉所有标签后应是「转义后的原文」——证明没有丢字、没有重复、没有注入。 */
function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

describe('highlightCode — 安全底线', () => {
  const risky = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    'a & b < c > d "e" \'f\' `g`',
    'const s = `模板 ${x} <b>粗</b>`;',
    'const s = "未闭合字符串',
    '/* 未闭合块注释',
    '&lt;已经转义的实体 &amp;',
  ];

  for (const lang of ['js', 'ts', 'json', 'css', 'bash', 'py', 'html', 'md', 'text', 'nonsense', '']) {
    it(`${lang || '(空语言)'}：不生成任何真实标签，只输出 span`, () => {
      const html = highlightCode(`<script>alert(1)</script>\n${risky.join('\n')}`, lang);
      expect(html).not.toContain('<script');
      expect(html).not.toContain('<img');
      expect(html).not.toContain('</script>');
      // 只允许 <span class="tok-…"> 与 </span>
      const tags = [...html.matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((m) => (m[1] ?? '').toLowerCase());
      expect(tags.every((tag) => tag === 'span')).toBe(true);
      // span 必须成对闭合
      expect((html.match(/<span/g) ?? []).length).toBe((html.match(/<\/span>/g) ?? []).length);
      // 所有 class 都在约定集合内
      for (const kind of tokenKinds(html)) expect(KINDS.has(kind)).toBe(true);
    });
  }

  it('未知语言与空语言只转义、不加标记', () => {
    expect(highlightCode('const a = 1;', 'nonsense')).toBe('const a = 1;');
    expect(highlightCode('<b>&</b>', '')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
    expect(highlightCode('<b>&</b>', 'text')).not.toContain('<span');
    expect(highlightCode('<b>&</b>', 'plain')).not.toContain('<span');
  });

  it('语言名大小写与别名都能识别', () => {
    expect(tokenKinds(highlightCode('const a = 1;', 'JS'))).toContain('keyword');
    expect(tokenKinds(highlightCode('const a = 1;', 'typescript'))).toContain('keyword');
    expect(tokenKinds(highlightCode('def f(): pass', 'Python'))).toContain('keyword');
  });

  it('空源码返回空串', () => {
    expect(highlightCode('', 'ts')).toBe('');
    expect(highlightCode('', 'nonsense')).toBe('');
  });
});

describe('highlightCode — 各语言 token', () => {
  it('js：注释 / 关键字 / 数字 / 字符串 / 模板串', () => {
    const code = '// 注释\nconst n = 42;\nconst s = "字符串";\nconst t = `模板 ${x}`;';
    const kinds = tokenKinds(highlightCode(code, 'js'));
    for (const kind of ['comment', 'keyword', 'number', 'string']) expect(kinds).toContain(kind);
  });

  it('ts：额外类型关键字', () => {
    const kinds = tokenKinds(highlightCode('interface A { readonly x: number }', 'ts'));
    expect(kinds).toContain('keyword');
  });

  it('json：字符串 / 数字 / true-false-null', () => {
    const html = highlightCode('{"a": 1, "b": true, "c": null}', 'json');
    expect(tokenKinds(html)).toEqual(expect.arrayContaining(['string', 'number', 'keyword']));
    expect(html).not.toContain('tok-comment');
  });

  it('css：块注释 / 字符串 / 数字', () => {
    const code = '/* 注释 */\n.a { color: red; width: 12px; content: "x"; }';
    const kinds = tokenKinds(highlightCode(code, 'css'));
    for (const kind of ['comment', 'string', 'number']) expect(kinds).toContain(kind);
  });

  it('bash：# 注释 / 关键字 / 字符串 / 数字', () => {
    const code = '# 注释\nif [ -n "$1" ]; then echo 42; fi';
    const kinds = tokenKinds(highlightCode(code, 'bash'));
    for (const kind of ['comment', 'keyword', 'string', 'number']) expect(kinds).toContain(kind);
    // a#b 不是注释
    expect(tokenKinds(highlightCode('echo a#b', 'bash'))).not.toContain('comment');
  });

  it('python：注释 / 关键字 / 字符串 / 数字', () => {
    const code = '# 注释\ndef f(x="默认"):\n    return 3.14';
    const kinds = tokenKinds(highlightCode(code, 'py'));
    for (const kind of ['comment', 'keyword', 'string', 'number']) expect(kinds).toContain(kind);
  });

  it('html：标签名 / 属性名 / 属性值 / 注释', () => {
    const html = highlightCode('<!-- 注释 --><a href="x" class="y">点</a>', 'html');
    const kinds = tokenKinds(html);
    for (const kind of ['comment', 'tag', 'attr', 'string']) expect(kinds).toContain(kind);
    expect(textOf(html)).toBe(escapeHtml('<!-- 注释 --><a href="x" class="y">点</a>'));
  });

  it('markdown：标题 / 引用 / 行内代码', () => {
    const md = '# 标题\n> 引用\n正文 `code` 与 **强调**';
    const kinds = tokenKinds(highlightCode(md, 'md'));
    for (const kind of ['keyword', 'comment', 'string', 'attr']) expect(kinds).toContain(kind);
  });
});

describe('highlightCode — 结构完整性（不丢字、不重复、不加标记外标签）', () => {
  const cases: Array<[string, string]> = [
    ['js', '// a\nconst s = `x${y}z`;\n/* b */\nlet n = 0x1f;'],
    ['ts', 'type T = { a?: string };\nconst x: T = { a: "q" };'],
    ['json', '{"k": [1, 2.5, true, null]}'],
    ['css', 'a:hover { background: url(x.png); }'],
    ['bash', 'for f in *.md; do echo "$f" # c\ndone'],
    ['py', 'def f(a, b=2):\n    """doc"""\n    return a + b'],
    ['html', '<!doctype html><div data-a="1">x</div>'],
    ['md', '## 标题\n- 列表 `a`\n1. 有序'],
    ['nonsense', 'whatever <tag> & stuff'],
  ];

  for (const [lang, code] of cases) {
    it(`${lang}：去标签后与转义原文一致`, () => {
      expect(textOf(highlightCode(code, lang))).toBe(escapeHtml(code));
    });
  }

  it('CRLF 换行不破坏结构', () => {
    const code = '// 注释\r\nconst a = 1;\r\nconst s = "x";\r\n';
    const html = highlightCode(code, 'js');
    expect(textOf(html)).toBe(escapeHtml(code));
    expect((html.match(/<span/g) ?? []).length).toBe((html.match(/<\/span>/g) ?? []).length);
    expect(html).not.toContain('<script');
  });

  it('未闭合字符串与块注释不会吞掉后续标签结构', () => {
    for (const code of ['const s = "abc', '/* abc', 'const t = `abc']) {
      const html = highlightCode(code, 'js');
      expect(textOf(html)).toBe(escapeHtml(code));
      expect((html.match(/<span/g) ?? []).length).toBe((html.match(/<\/span>/g) ?? []).length);
    }
  });
});
