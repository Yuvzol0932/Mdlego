import MarkdownItDefault from 'markdown-it';
import type { MarkdownIt, Token } from 'markdown-it';
import { makeBid } from './anchors';
import { escapeHtml, highlightCode } from './highlight';
import type { ChunkBlockRange, RenderResult, TocEntry } from './types';
import { collapseWhitespace } from './text';

/**
 * 渲染过程中收集的「块 id → 块纯文本」。
 * 每次 renderMarkdown 开始时清空，避免跨文档串数据。
 */
let collectedBlockTexts = new Map<string, string>();

/**
 * 从 inline token 的子节点里递归取出纯文本。
 *
 * 不能用 inline.content —— 那是原始 Markdown 源，
 * 会带着 **、`` ` ``、[链接](url) 这些标记，
 * 搜索片段里就会出现星号，且搜索「重点」命中的实际是「**重点**」。
 */
function plainTextFromInline(inline: TokenLike | null): string {
  if (inline === null) return '';
  const parts: string[] = [];
  const walk = (token: TokenLike): void => {
    if (token.type === 'text' || token.type === 'code_inline') {
      parts.push(token.content);
    } else if (token.type === 'softbreak' || token.type === 'hardbreak') {
      // 软换行在渲染后是一个空格/换行，搜索文本里用空格连接
      parts.push(' ');
    } else if (token.type === 'html_inline') {
      // 复选框等原生注入的 html_inline 不带可见文字，跳过
      return;
    } else if (token.children !== null) {
      for (const child of token.children) walk(child);
    }
  };
  if (inline.children !== null) {
    for (const child of inline.children) walk(child);
  } else {
    parts.push(inline.content);
  }
  return collapseWhitespace(parts.join(''));
}

/** 记录一个块的纯文本（在标注 bid 时同步调用）。 */
function recordBlockText(bid: string, text: string): void {
  // 同一 bid 可能对应容器与内容，取更长的那个文本
  if (!collectedBlockTexts.has(bid) || text.length > (collectedBlockTexts.get(bid) ?? '').length) {
    collectedBlockTexts.set(bid, text);
  }
}

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
  level: number;
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
 * 用已有 token 的构造函数造一个 html_inline token。
 * 不依赖 markdown-it 的内部模块路径（v15 的 exports 字段不暴露 Token 类）。
 */
function htmlToken(from: TokenLike, content: string): TokenLike {
  const TokenCtor = (from as unknown as { constructor: TokenCtorType }).constructor;
  const token = new TokenCtor('html_inline', '', 0);
  token.content = content;
  return token;
}

/** 任务清单的勾线 SVG；描边动画（stroke-dashoffset）在 typography.css 里。 */
const TASK_CHECK_SVG =
  '<svg class="task-check" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M5 12.5l4.5 4.5L19 7.5" /></svg>';

/** 一级标题的章节前缀：「第 N 章 / 第 N 节」。 */
const CHAPTER_PREFIX = /^第\s*(\d{1,4}|[〇零一二三四五六七八九十百两]+)\s*([章节])\s*/;

/** 「N. / N、/ N．」形式的数字编号（要求分隔符后是空白，避免把 1.5 拆开）。 */
const NUMBER_PREFIX = /^(\d{1,4})\s*[.、．]\s+/;

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

  // 表格包裹规则在这里装一次即可。
  // 曾经过早地在 renderMarkdown 里调用，导致解析器被复用后规则被反复叠加，
  // 一个表格会被包成两层、单元格计数翻倍。
  wrapTables(md);

  // 围栏代码块：复制按钮 + 轻量高亮。
  // 和 wrapTables 一样只在解析器创建时装一次 —— 若在 renderMarkdown 里装，
  // 解析器复用会让规则层层叠加，同一块代码被包出两层外壳。
  highlightFences(md);

  return md;
}

/** 首屏同步渲染的块数（约一屏多一点）：动画期间正文只需要这么多。 */
export const FIRST_SCREEN_BLOCKS = 24;
/** 动画结束后空闲补齐时每批的块数。 */
export const LAZY_CHUNK_BLOCKS = 64;

/** 自闭合的顶层块（没有 `_close` 配对）。 */
const SELF_CLOSING_TOP_BLOCKS = new Set(['fence', 'code_block', 'html_block', 'hr']);

/** 是否是「顶层新块的开头」（只在块开头切分，保证每片 HTML 结构完整）。 */
function isTopLevelBlockStart(token: TokenLike): boolean {
  if (token.level !== 0) return false;
  if (token.type.endsWith('_open')) return true;
  return SELF_CLOSING_TOP_BLOCKS.has(token.type);
}

/**
 * 按顶层块把 token 流切成若干片：第一片 `firstBlocks` 块，其余每片 `chunkBlocks` 块。
 * 只在顶层块边界切分，列表/表格/引用块内部不会被切开。
 *
 * 同时算出每片覆盖的**块区间**（左闭右开）。转场改造 Step 1 需要
 * 「以目标 bid 为中心先挂哪几片」，只有 token 分组没有块区间就无从定位。
 */
function splitTopLevelChunks(
  tokens: TokenLike[],
  firstBlocks: number,
  chunkBlocks: number,
): { readonly groups: TokenLike[][]; readonly ranges: ChunkBlockRange[] } {
  const groups: TokenLike[][] = [];
  const ranges: ChunkBlockRange[] = [];
  let current: TokenLike[] = [];
  let blocks = 0;
  let target = firstBlocks;
  /** 当前片起始块在全文中的索引。 */
  let chunkStart = 0;
  const pushCurrent = (): void => {
    groups.push(current);
    ranges.push({ startIdx: chunkStart, endIdx: chunkStart + blocks });
    chunkStart += blocks;
  };
  for (const token of tokens) {
    if (current.length > 0 && blocks >= target && isTopLevelBlockStart(token)) {
      pushCurrent();
      current = [];
      blocks = 0;
      target = chunkBlocks;
    }
    current.push(token);
    if (token.attrGet('data-bid') !== null) blocks += 1;
  }
  if (current.length > 0) pushCurrent();
  if (groups.length === 0) {
    groups.push([]);
    ranges.push({ startIdx: 0, endIdx: 0 });
  }
  return { groups, ranges };
}

/**
 * 给「正文首段」打 `data-lede`，供排版规则做首行缩进。
 *
 * 必须是**内容级**标记，不能交给 CSS 的 `:first-of-type`：
 * 阅读页的分片窗口会在文档前段前插分片，DOM 里的「第一个 p」会随之滑动，
 * 导致缩进跑到中段段落上，并让原来的首段少一行 —— 前插补偿算不到这个
 * 高度变化，累积成数百像素的锚点漂移（实测 300px 量级）。
 *
 * 规则：文档里第一个「顶层段落」；它前面允许出现标题与 html 块
 * （脚注定义等），但一旦先出现了别的正文块就不再算首段。
 * 分隔线（hr）只是分隔符，不占首段名额。
 */
function markLeadingParagraph(tokens: TokenLike[]): void {
  for (const token of tokens) {
    if (token.type === 'paragraph_open' && !token.hidden && token.tag === 'p') {
      token.attrSet('data-lede', 'true');
      return;
    }
    // 注意不能只看 nesting：fence / code_block / hr 的 nesting 都是 0，
    // 用 nesting 过滤会漏掉「文档以代码块开头」这种真实情况。
    if (BLOCKS_BEFORE_LEDE.has(token.type)) return;
  }
}

/** 这些顶层块出现在段落之前时，说明它前面已经有正文内容，不再是首段。 */
const BLOCKS_BEFORE_LEDE = new Set([
  'blockquote_open',
  'table_open',
  'bullet_list_open',
  'ordered_list_open',
  'list_item_open',
  'fence',
  'code_block',
]);

/** 按文档顺序枚举全部块 id（每个携带 data-bid 的 token 恰好一个块）。 */
function collectBlockIds(tokens: TokenLike[]): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    const bid = token.attrGet('data-bid');
    if (bid !== null) out.push(bid);
  }
  return out;
}

let cachedParser: MarkdownIt | null = null;

function getParser(): MarkdownIt {
  if (cachedParser === null) cachedParser = createParser();
  return cachedParser;
}

/** `renderMarkdown` 的选项。 */
export interface RenderOptions {
  /**
   * 懒分片：首片只渲染约 `FIRST_SCREEN_BLOCKS` 块，其余 HTML 在
   * `nextHtmlChunk()` 被调用时才逐片渲染（阅读页用空闲时间分批挂载）。
   * `html` / `htmlChunks` 仍会按需补齐到全量，语义不变。
   */
  readonly lazy?: boolean;
}

/**
 * 渲染 Markdown 为 HTML，并为每个可标注块打上 data-bid。
 *
 * 做法：先用 markdown-it 解析成 token 流，再在 token 层注入属性，最后渲染。
 * 这样避免了对已渲染 HTML 做正则替换（那是最容易出错的路子）。
 */
export function renderMarkdown(source: string, options: RenderOptions = {}): RenderResult {
  const md = getParser();
  const tokens = md.parse(source, {}) as unknown as TokenLike[];
  collectedBlockTexts = new Map<string, string>();

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
    recordBlockText(token.attrGet('data-bid') ?? '', plainTextFromInline(inline));
    blockCount++;

    if (token.type === 'heading_open') token.attrSet('data-heading', 'true');
  }

  // 正文首段标记（转场改造 Step 1 的必需产物）：
  //
  // 排版规则「首段首行缩进两字」以前用 CSS 的 `.article > p:first-of-type`
  // 选中「DOM 里的第一个 p」。分片窗口直出会**在文档前段前插分片**，
  // 于是这个选择器指向的 p 会随着挂载区间滑动而改变：
  //   1. 缩进在中段段落上凭空出现（视觉错乱）；
  //   2. 旧首段丢掉缩进后少一行，块高 −34px，而前插补偿按「参考元素
  //      视口位移」计算，没算进这个高度变化 → 每批多滚 34px，
  //      八批累积 ≈300px，就是「重新打开偏出几行」的真凶。
  //
  // 改成在解析阶段一次性标出真正的正文首段，CSS 只认这个属性，
  // 与挂载区间完全解耦。
  markLeadingParagraph(tokens);

  blockCount += annotateListItemTokens(tokens);
  blockCount += annotateTableCellTokens(tokens);
  blockCount += annotateFenceTokens(tokens);

  // 任务清单必须在 bid 标注之后，因为它依赖 list_item_open 上的 data-bid
  renderTaskCheckboxes(md, tokens);

  // 一级标题章节眉标（只改渲染用 children，不动 bid / 目录 / 搜索文本）
  applyH1Eyebrows(md, tokens);

  // 表格需要外层包裹才能实现「窄屏横向滚动且不撑破页面」
  const toc = buildToc(tokens);
  const { groups, ranges } = splitTopLevelChunks(tokens, FIRST_SCREEN_BLOCKS, LAZY_CHUNK_BLOCKS);
  const blockIds = collectBlockIds(tokens);
  const renderGroup = (group: TokenLike[]): string => md.renderer.render(group as never, md.options, {});

  if (options.lazy !== true) {
    const htmlChunks = groups.map(renderGroup);
    return {
      html: htmlChunks.join(''),
      htmlChunks,
      firstHtmlChunk: htmlChunks[0] ?? '',
      toc,
      blockCount,
      blockTexts: collectedBlockTexts,
      blockIds,
      chunkBlockRanges: ranges,
      htmlChunkAt: (index: number): string | null => htmlChunks[index] ?? null,
    };
  }

  // 懒分片：首片立即渲染，其余等页面空闲时再逐片渲染。
  const chunks: (string | null)[] = Array.from({ length: groups.length }, () => null);
  chunks[0] = renderGroup(groups[0] ?? []);
  /** 按需渲染某一分片（已渲染的直接复用，不重复渲染）。 */
  const renderAt = (index: number): string | null => {
    const cached = chunks[index];
    if (cached !== null && cached !== undefined) return cached;
    const group = groups[index];
    if (group === undefined) return null;
    const html = renderGroup(group);
    chunks[index] = html;
    return html;
  };
  let nextGroup = 1;
  let htmlCache: string | null = null;
  const renderNext = (): string | null => {
    while (nextGroup < groups.length) {
      const index = nextGroup;
      nextGroup += 1;
      const html = renderAt(index);
      if (html !== null) return html;
    }
    return null;
  };
  const drain = (): void => {
    while (renderNext() !== null) {
      // 逐片补齐
    }
  };
  const result: RenderResult = {
    get html(): string {
      if (htmlCache === null) {
        drain();
        htmlCache = chunks.join('');
      }
      return htmlCache;
    },
    get htmlChunks(): readonly string[] {
      drain();
      return chunks as readonly string[];
    },
    firstHtmlChunk: chunks[0] ?? '',
    toc,
    blockCount,
    blockTexts: collectedBlockTexts,
    blockIds,
    chunkBlockRanges: ranges,
    // 转场改造 Step 1：以目标块为窗口时首屏要挂的可能是「中间某一批」分片，
    // 必须能按索引随机取片，而不只是从头顺序 nextHtmlChunk。
    htmlChunkAt: renderAt,
    nextHtmlChunk: renderNext,
  };
  return result;
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
    recordBlockText(token.attrGet('data-bid') ?? '', plainTextFromInline(inline));
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
    recordBlockText(
      token.attrGet('data-bid') ?? '',
      plainTextFromInline(next && next.type === 'inline' ? next : null),
    );
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
    recordBlockText(token.attrGet('data-bid') ?? '', collapseWhitespace(token.content));
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

    // 自绘勾线：SVG 由 CSS 用 stroke-dashoffset 做「从左到右画出」的动画，
    // 追加在 li 内、由 CSS 绝对定位叠在复选框上，不占正文流。
    const boxToken = htmlToken(
      inlineToken,
      `<input type="checkbox" class="task-box"` +
        ` data-task-bid="${bid}" data-task-checked="${checked ? '1' : '0'}"` +
        `${checked ? ' checked' : ''} />`,
    );
    const checkToken = htmlToken(inlineToken, TASK_CHECK_SVG);
    // 文字包一层 span：勾选后由 CSS 用 ::after 的 scaleX(0→1) 画「从左到右」的划线
    // （transform 动画合规；多行任务只画一条穿过首行的线，已在 MOTION.md 注明）。
    const textOpen = htmlToken(inlineToken, '<span class="task-text">');
    const textClose = htmlToken(inlineToken, '</span>');

    inlineToken.children = [boxToken, textOpen, ...newChildren, textClose, checkToken];
    inlineToken.content = rest;
    itemOpen.attrSet('data-task', 'true');
    itemOpen.attrSet('data-task-checked', checked ? '1' : '0');
  }
}

/**
 * 给表格加外层滚动容器。
 *
 * 覆盖 renderer 的 table_open / table_close：
 * 输出 <div class="table-wrap"><table>…</table></div>。
 * 这样窄屏或大字号时表格自身横向滚动，而不会把整页撑出横向滚动条。
 */
function wrapTables(md: MarkdownIt): void {
  const defaultTableOpen =
    md.renderer.rules['table_open'] ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  const defaultTableClose =
    md.renderer.rules['table_close'] ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

  md.renderer.rules['table_open'] = (tokens, idx, options, env, self) =>
    `<div class="table-wrap">${defaultTableOpen(tokens, idx, options, env, self)}`;

  md.renderer.rules['table_close'] = (tokens, idx, options, env, self) =>
    `${defaultTableClose(tokens, idx, options, env, self)}</div>`;
}

/**
 * 围栏代码块：外壳 + 复制按钮 + 轻量高亮。
 *
 * 只覆盖 renderer 规则，不碰 token 与 attrs：
 *   - data-bid / data-kind 由 renderAttrs 原样落在 <code> 上（可标注块仍是代码块本身）
 *   - 高亮函数返回的已是转义后的 HTML，这里绝不能再拼原文
 *   - 语言名来自围栏信息串（不可信），写进属性前一律转义
 */
function highlightFences(md: MarkdownIt): void {
  md.renderer.rules['fence'] = (tokens, idx, _options, _env, self) => {
    const token = tokens[idx];
    if (token === undefined) return '';
    const info = token.info.trim().split(/\s+/)[0] ?? '';
    const lang = info === '' ? 'text' : info.toLowerCase();
    const attrs = self.renderAttrs(token);
    return (
      `<div class="code-wrap" data-lang="${escapeHtml(lang)}">` +
      '<button type="button" class="code-copy" data-testid="code-copy" aria-label="复制代码">复制</button>' +
      `<pre><code class="lang-${escapeHtml(lang)}"${attrs}>` +
      `${highlightCode(token.content, lang)}</code></pre></div>\n`
    );
  };
}

/** 章节眉标文本：阿拉伯数字编号补空格，中文序数保持紧凑。 */
function eyebrowText(match: RegExpExecArray): string {
  const num = match[1] ?? '';
  const unit = match[2];
  if (unit === undefined) return num;
  return /^\d+$/.test(num) ? `第 ${num} ${unit}` : `第${num}${unit}`;
}

/**
 * 一级标题的章节眉标（任务书 §2.4）。
 *
 * 仅当 H1 原文以「第N章 / 第N节」或「N. / N、」开头时，把前缀拆成小字眉标，
 * 其余部分包进 h1-text；不匹配时保持原样 —— 不伪造章节号，也不给其它标题级别加眉标。
 *
 * 只改渲染用的 children：bid 与目录、blockTexts 都在标注阶段按原始完整标题生成，
 * 因此锚点不变、搜索仍能命中「第N章」与标题正文。
 */
function applyH1Eyebrows(md: MarkdownIt, tokens: TokenLike[]): void {
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    if (!open || open.type !== 'heading_open' || open.tag !== 'h1') continue;
    const inline = tokens[i + 1];
    if (!inline || inline.type !== 'inline') continue;

    const match = CHAPTER_PREFIX.exec(inline.content) ?? NUMBER_PREFIX.exec(inline.content);
    if (match === null) continue;
    const rest = inline.content.slice(match[0].length).replace(/^\s+/, '');
    if (rest.length === 0) continue;

    // 重新解析剩余标题文本，保留其中的行内格式（链接/强调等）
    const reparsed = md.parseInline(rest, {}) as unknown as TokenLike[];
    const restChildren = reparsed[0]?.children ?? [];
    inline.children = [
      htmlToken(
        inline,
        `<span class="h1-eyebrow">${escapeHtml(eyebrowText(match))}</span><span class="h1-text">`,
      ),
      ...restChildren,
      htmlToken(inline, '</span>'),
    ];
  }
}

/** 从已标注的 token 流构建目录，bid 与正文严格一致。 */function buildToc(tokens: TokenLike[]): TocEntry[] {
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

/**
 * HTML 转义（供视图层拼字符串时使用）。
 *
 * 实现集中在 highlight.ts（语法高亮的第一步也是转义，只留一份），
 * 这里原样转出，保持 `import { escapeHtml } from './markdown'` 的既有调用方不变。
 */
export { escapeHtml };

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
