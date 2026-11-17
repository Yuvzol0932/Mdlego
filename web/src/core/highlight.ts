/**
 * 轻量语法高亮 —— 纯函数、零依赖、单遍线性扫描。
 *
 * 安全模型：扫描器只把源码切成段，每段先 HTML 转义再包 span；
 * 原文永远不会被直接拼进 HTML，所以不存在注入面，语言名与代码内容都无需信任。
 * 未知语言 / 空语言 / text / plain 只做整体转义，不加任何标记。
 *
 * 规则表用 sticky（y）正则逐位置尝试，命中即整体消费；
 * 未命中的单个字符按转义输出。没有嵌套量词，不会出现灾难性回溯。
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** HTML 转义（全项目唯一实现，markdown.ts 从这里再导出）。 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

type Kind = 'comment' | 'string' | 'number' | 'keyword' | 'tag' | 'attr';

const span = (kind: Kind, text: string): string =>
  `<span class="tok-${kind}">${escapeHtml(text)}</span>`;

interface Rule {
  kind: Kind;
  re: RegExp;
}

const rule = (kind: Kind, source: string, flags = 'y'): Rule => ({ kind, re: new RegExp(source, flags) });

const words = (text: string): ReadonlySet<string> => new Set(text.split(' '));

const JS = 'break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield await async of from get set static';
const TS = `${JS} interface type enum implements namespace declare abstract readonly public private protected as satisfies keyof infer is asserts override`;
const PY = 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None';
const BASH = 'if then else elif fi for while until do done case esac in function select return local export declare readonly unset shift exit source alias';

// ── 通用词法片段（sticky：只在当前扫描位置匹配） ──────────────
const BLOCK_COMMENT = rule('comment', String.raw`/\*[\s\S]*?\*/`);
const LINE_COMMENT = rule('comment', String.raw`//[^\n]*`);
const HASH_COMMENT = rule('comment', String.raw`#[^\n]*`);
/** bash：a#b 不是注释，# 必须在行首或空白之后。 */
const SHELL_COMMENT = rule('comment', String.raw`(?<!\S)#[^\n]*`);
const DQ_STRING = rule('string', String.raw`"(?:[^"\\\n]|\\.)*"`);
const SQ_STRING = rule('string', String.raw`'(?:[^'\\\n]|\\.)*'`);
const TEMPLATE = rule('string', '`(?:[^`\\\\]|\\\\.)*`');
const AT_RULE = rule('keyword', String.raw`@[a-zA-Z-]+`);

// ── HTML/XML ──────────────────────────────────────────────────
const HTML_COMMENT = rule('comment', String.raw`<!--[\s\S]*?-->`);
const HTML_TAG = rule('tag', String.raw`<\/?[A-Za-z][\w:.-]*`);
const HTML_ATTR = rule('attr', String.raw`[A-Za-z_:@#-][\w:.@#-]*(?=\s*=)`);

// ── Markdown 源码 ─────────────────────────────────────────────
const MD_FENCE = rule('keyword', '^(?:```|~~~)[\\w-]*', 'my');
const MD_HEADING = rule('keyword', String.raw`^#{1,6}(?=\s)`, 'my');
const MD_QUOTE = rule('comment', String.raw`^>+\s?`, 'my');
const MD_LIST = rule('keyword', '^(?:[-*+]|\\d{1,3}\\.)\\s', 'my');
const MD_CODE = rule('string', '`[^`\\n]*`');
const MD_EMPHASIS = rule('attr', String.raw`\*\*|~~`);

interface LangSpec {
  kw: ReadonlySet<string>;
  rules: readonly Rule[];
}

const LANGS: Record<string, LangSpec> = {
  js: { kw: words(JS), rules: [BLOCK_COMMENT, LINE_COMMENT, DQ_STRING, SQ_STRING, TEMPLATE] },
  ts: { kw: words(TS), rules: [BLOCK_COMMENT, LINE_COMMENT, DQ_STRING, SQ_STRING, TEMPLATE] },
  json: { kw: words('true false null'), rules: [DQ_STRING] },
  css: { kw: words(''), rules: [BLOCK_COMMENT, DQ_STRING, SQ_STRING, AT_RULE] },
  bash: { kw: words(BASH), rules: [SHELL_COMMENT, DQ_STRING, SQ_STRING] },
  py: { kw: words(PY), rules: [HASH_COMMENT, DQ_STRING, SQ_STRING] },
  html: { kw: words(''), rules: [HTML_COMMENT, HTML_TAG, DQ_STRING, SQ_STRING, HTML_ATTR] },
  md: { kw: words(''), rules: [MD_FENCE, MD_HEADING, MD_QUOTE, MD_LIST, MD_CODE, MD_EMPHASIS] },
};

const NUMBER = /(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
const IDENT = /[A-Za-z_$][\w$]*/y;

/** 单遍扫描：规则命中 → 数字 → 标识符/关键字 → 单字符兜底。 */
function scan(src: string, spec: LangSpec): string {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    let hit = false;
    for (const { kind, re } of spec.rules) {
      re.lastIndex = i;
      const match = re.exec(src);
      if (match !== null && match[0].length > 0) {
        out.push(span(kind, match[0]));
        i += match[0].length;
        hit = true;
        break;
      }
    }
    if (hit) continue;

    NUMBER.lastIndex = i;
    const num = NUMBER.exec(src);
    if (num !== null) {
      out.push(span('number', num[0]));
      i += num[0].length;
      continue;
    }

    IDENT.lastIndex = i;
    const word = IDENT.exec(src);
    if (word !== null) {
      out.push(spec.kw.has(word[0]) ? span('keyword', word[0]) : escapeHtml(word[0]));
      i += word[0].length;
      continue;
    }

    out.push(escapeHtml(src[i] as string));
    i++;
  }
  return out.join('');
}

/** 语言别名 → 规则表键；未知语言 = text（只转义）。 */
const ALIASES = new Map<string, string>();
for (const [names, target] of [
  ['js javascript jsx mjs cjs', 'js'],
  ['ts typescript tsx', 'ts'],
  ['json jsonc', 'json'],
  ['css scss less', 'css'],
  ['bash sh shell zsh console', 'bash'],
  ['py python', 'py'],
  ['html xml htm svg', 'html'],
  ['markdown md mdx', 'md'],
] as const) {
  for (const name of names.split(' ')) ALIASES.set(name, target);
}

/**
 * 把源码高亮成已转义的 HTML。
 *
 * @param code 源码原文（不可信）
 * @param lang 围栏信息串里的语言（不可信）；未知语言 → 只转义
 */
export function highlightCode(code: string, lang: string): string {
  const spec = LANGS[ALIASES.get(lang.trim().toLowerCase()) ?? ''];
  return spec === undefined ? escapeHtml(code) : scan(code, spec);
}
