import MarkdownItDefault from 'markdown-it';
import type { MarkdownIt, Token } from 'markdown-it';
import { makeBid } from './anchors';
import type { RenderResult, TocEntry } from './types';
import { collapseWhitespace } from './text';

/**
 * 可标注块的类型白名单。
 * 只有这些标签会带 data-bid —— 其余标签（table、blockquote、ul 等容器）
 * 不带 bid，避免「容器与内容争夺同一锚点」。
 */
const BID_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'pre']);

/** 允许的 URL 协议。其余一律拒绝，防止 javascript: 之类注入。 */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'file:', 'data:']);

/**
 * markdown-it 的 token 结构。
 *
 * 刻意不 `import Token from 'markdown-it/lib/token.mjs'`：
 * markdown-it v15 的 exports 字段不再暴露内部路径，直接 import 会失败。
 * 这里用结构化类型描述我们实际用到的字段，既不依赖内部实现，也保持类型安全。
 */
interface TokenLike {
  type: string;
  tag: string;
  nesting: number;
  attrs: Array<[string, string]> | null;
  content: string;
  children: TokenLike[] | null;
  hidden: boolean;
  attrSet(name: string, value: string): void;
  attrGet(name: string): string | null;
}

/** Token 构造器签名，用于在运行时创建新 token。 */
type TokenCtorType = new (type: string, tag: string, nesting: number) => TokenLike;

/**
 * 创建一个配置好的 markdown-it 实例。
 *
 * 关键安全设置：
 *   - html: false  → 原文中的裸 HTML 一律转义，不执行、不透传
 *   - linkify: true → 裸链接自动成链（只生成 <a href>，不执行）
 *   - typographer: false → 不做智能引号替换，保持原文可复制
 */
function createParser(): MarkdownIt {
  const md = new MarkdownItDefault({
    html: false,
    linkify: true,
    breaks: false,
    typographer: false,
  });

  // ==高亮== 行内扩展：转成 <mark>
  md.inline.ruler.before('emphasis', 'mark_highlight', (state, silent) => {
    const start = state.pos;
    if (state.src.charCodeAt(start) !== 0x3d /* = */) return false;
    if (state.src.charCodeAt(start + 1) !== 0x3d /* = */) return false;

    const end = state.src.indexOf('==', start + 2);
    if (end < 0) return false;
    const content = state.src.slice(start + 2, end);
    if (content.length === 0 || content.includes('\n')) return false;

    if (!silent) {
      const open = state.push('mark_open', 'mark', 1);
      open.markup = '==';
      const text = state.push('text', '', 0);
      text.content = content;
      const close = state.push('mark_close', 'mark', -1);
      close.markup = '==';
    }
    state.pos = end + 2;
    return true;
  });

  // 链接安全过滤：只放行白名单协议
  const defaultValidate = md.validateLink.bind(md);
  md.validateLink = (url: string): boolean => {
    const trimmed = url.trim();
    // 相对链接、锚点、无协议的路径直接交给默认校验
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
      return defaultValidate(url);
    }
    try {
      const parsed = new URL(trimmed);
      return SAFE_PROTOCOLS.has(parsed.protocol) && defaultValidate(url);
    } catch {
      return false;
    }
  };

  return md;
}

let cachedParser: MarkdownIt | null = null;

function getParser(): MarkdownIt {
  if (cachedParser === null) cachedParser = createParser();
  return cachedParser;
}

/**
 * 渲染 Markdown 为 HTML，并为每个可标注块打上 data-bid。
 *
 * 做法：先用 markdown-it 解析成 token 流，再在 token 层注入属性，最后渲染。
 * 这样避免了对已渲染 HTML 做正则替换（那是最容易出错的路子）。
 */
export function renderMarkdown(source: string): RenderResult {
  const md = getParser();
  const tokens = md.parse(source, {}) as unknown as TokenLike[];

  // 每种 (tag + 前 24 字符) 组合的出现计数，用于消歧
  const ordinalByKey = new Map<string, number>();
  let blockCount = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (token.type !== 'heading_open' && token.type !== 'paragraph_open') continue;
    // hidden 的 paragraph_open（如列表项内部）不会渲染成 <p>，
    // 标记它会与 list_item_open 的 bid 重复。这类块交给 annotateListItemTokens。
    if (token.hidden) continue;
    if (!BID_TAGS.has(token.tag)) continue;

    const inline = tokens[i + 1];
    if (!inline || inline.type !== 'inline') continue;
    const text = inline.content;

    const key = token.tag;
    const ordinal = ordinalByKey.get(key) ?? 0;
    ordinalByKey.set(key, ordinal + 1);

    token.attrSet('data-bid', makeBid(token.tag, text, ordinal));
    token.attrSet('data-kind', token.tag);
    blockCount++;

    if (token.type === 'heading_open') token.attrSet('data-heading', 'true');
  }

  blockCount += annotateListItemTokens(tokens);
  blockCount += annotateTableCellTokens(tokens);
  blockCount += annotateFenceTokens(tokens);

  // 任务清单必须在 bid 标注之后，因为它依赖 list_item_open 上的 data-bid
  renderTaskCheckboxes(md, tokens);

  const toc = buildToc(tokens);
  const html = md.renderer.render(tokens as never, md.options, {});

  return { html, toc, blockCount };
}

/** 给列表项打 bid（列表项的 paragraph_open 是 hidden 的，不会输出 <p>）。 */
function annotateListItemTokens(tokens: TokenLike[]): number {
  const ordinalByText = new Map<string, number>();
  let count = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token || token.type !== 'list_item_open') continue;

    const inline = findItemInline(tokens, i);
    const text = inline?.content ?? '';

    const prefix = text.slice(0, 24);
    const ordinal = ordinalByText.get(prefix) ?? 0;
    ordinalByText.set(prefix, ordinal + 1);

    token.attrSet('data-bid', makeBid('li', text, ordinal));
    token.attrSet('data-kind', 'li');
    count++;
  }

  return count;
}

/** 找到列表项（起始索引 itemIndex）内部第一个 inline token。 */
function findItemInline(tokens: TokenLike[], itemIndex: number): TokenLike | null {
  for (let j = itemIndex + 1; j < tokens.length; j++) {
    const inner = tokens[j];
    if (!inner) continue;
    if (inner.type === 'list_item_close') break;
    if (inner.type === 'inline') return inner;
  }
  return null;
}

/** 给表格单元格打 bid。空单元格也生成 bid，保证索引稳定。 */
function annotateTableCellTokens(tokens: TokenLike[]): number {
  const ordinalByText = new Map<string, number>();
  let count = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (token.type !== 'td_open' && token.type !== 'th_open') continue;

    const tag = token.type === 'th_open' ? 'th' : 'td';
    // 单元格内容在其后的 inline token 里；可能是空的
    const next = tokens[i + 1];
    const text = next && next.type === 'inline' ? next.content : '';

    const key = `${tag}|${text.slice(0, 24)}`;
    const ordinal = ordinalByText.get(key) ?? 0;
    ordinalByText.set(key, ordinal + 1);

    token.attrSet('data-bid', makeBid(tag, text, ordinal));
    token.attrSet('data-kind', tag);
    count++;
  }

  return count;
}

/** 给围栏代码块打 bid，用其内容前若干字符作为指纹。 */
function annotateFenceTokens(tokens: TokenLike[]): number {
  const ordinalByText = new Map<string, number>();
  let count = 0;

  for (const token of tokens) {
    if (!token || token.type !== 'fence') continue;
    const key = token.content.slice(0, 24);
    const ordinal = ordinalByText.get(key) ?? 0;
    ordinalByText.set(key, ordinal + 1);

    token.attrSet('data-bid', makeBid('pre', token.content, ordinal));
    token.attrSet('data-kind', 'pre');
    count++;
  }

  return count;
}

/**
 * 把 GFM 任务清单语法渲染成真实复选框。
 *
 * markdown-it 核心不内置该语法，这里直接在 token 层处理：
 * 列表项内联内容的开头若是 `[ ] ` 或 `[x] `，去掉该前缀，
 * 并在行内 token 最前面插入一个 checkbox 的 html_inline token。
 *
 * 复选框携带 data-task-bid 与 data-task-checked，
 * 供勾选状态持久化时定位（状态只存 App 内，不回写原文）。
 */
function renderTaskCheckboxes(md: MarkdownIt, tokens: TokenLike[]): void {
  for (let i = 0; i < tokens.length; i++) {
    const itemOpen = tokens[i];
    if (!itemOpen || itemOpen.type !== 'list_item_open') continue;

    const bid = itemOpen.attrGet('data-bid');
    if (bid === null) continue;

    const inlineToken = findItemInline(tokens, i);
    if (inlineToken === null) continue;

    const match = /^\[([ xX])\]\s+/.exec(inlineToken.content);
    if (match === null) continue;

    const checked = (match[1] ?? ' ').toLowerCase() === 'x';
    const rest = inlineToken.content.slice(match[0].length);

    // 用剩余文本重新解析行内内容，避免手工剥离 children 出错。
    // 注意：parseInline 返回的是 [inline]，children 挂在 inline 上，
    // 不是 children[0] 上 —— 早期版本在这里取错了层，导致任务文字全丢。
    const reparsed = md.parseInline(rest, {}) as unknown as TokenLike[];
    const inlineRoot = reparsed[0];
    if (inlineRoot === undefined) continue;
    const newChildren = inlineRoot.children ?? [];

    // 通过已有 token 的构造函数取 Token 类，不依赖 markdown-it 内部模块路径
    const TokenCtor = (inlineToken as unknown as { constructor: TokenCtorType }).constructor;
    const boxToken = new TokenCtor('html_inline', '', 0);
    boxToken.content =
      `<input type="checkbox" class="task-box"` +
      ` data-task-bid="${bid}" data-task-checked="${checked ? '1' : '0'}"` +
      `${checked ? ' checked' : ''} />`;

    inlineToken.children = [boxToken, ...newChildren];
    inlineToken.content = rest;
    itemOpen.attrSet('data-task', 'true');
    itemOpen.attrSet('data-task-checked', checked ? '1' : '0');
  }
}

/** 从已标注的 token 流构建目录，bid 与正文严格一致。 */
function buildToc(tokens: TokenLike[]): TocEntry[] {
  const toc: TocEntry[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token || token.type !== 'heading_open') continue;

    const level = Number.parseInt(token.tag.slice(1), 10);
    const inline = tokens[i + 1];
    const text = inline && inline.type === 'inline' ? collapseWhitespace(inline.content) : '';
    const bid = token.attrGet('data-bid');
    if (bid === null) continue;

    toc.push({ level, text, bid });
  }

  return toc;
}

/** HTML 转义（供视图层拼字符串时使用）。 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 从 Markdown 源文本推断标题：首个一级标题，否则首个任意级标题，否则 null。
 * 用于导入时生成书架标题。
 */
export function extractTitle(source: string): string | null {
  const lines = source.split(/\r\n|\r|\n/);
  let firstAny: string | null = null;

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const level = match[1]?.length ?? 6;
    const text = collapseWhitespace(match[2] ?? '');
    if (text.length === 0) continue;
    if (level === 1) return text;
    if (firstAny === null) firstAny = text;
  }

  return firstAny;
}
