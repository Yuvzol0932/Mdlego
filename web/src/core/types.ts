/**
 * 全应用类型契约 —— 先写这里，再写实现。
 *
 * 规则（见 docs/CONVENTIONS.md）：
 *  1. 任何跨层传递的数据都必须在这里有具名类型。
 *  2. core/ 不得 import data/ 或 views/；data/ 不得 import views/。
 *  3. 状态变更只经过 StateAction 联合类型，视图不得直接改 State。
 */

// ─────────────────────────────────────────────
// 文档
// ─────────────────────────────────────────────

/** 文档来源：决定「能否回写原文」与「是否可持久访问」。 */
export type DocSource =
  /** 通过系统文件选择器 / 分享进来的原始文件，持有可持久化 URI。 */
  | { readonly kind: 'file'; readonly uri: string }
  /** 仅在应用内存在（粘贴、示例文档），无外部原文可回写。 */
  | { readonly kind: 'inline' };

/**
 * 原始文件的磁盘指纹，用于「回写前检测外部改动」。
 * 只在 kind === 'file' 时有值。
 */
export interface FileFingerprint {
  /** 导入时的字节数。 */
  readonly size: number;
  /** 导入时的最后修改时间（毫秒）。取不到时为 null。 */
  readonly mtimeMs: number | null;
  /** 导入时原文内容的 sha256（十六进制小写）。 */
  readonly sha256: string;
}

/** 文本编码探测结果。中文笔记常见 GBK，必须记录以便原样回写。 */
export type TextEncoding = 'utf-8' | 'utf-8-bom' | 'gbk' | 'unknown';

/** 一篇文档的元数据与正文（存于 IndexedDB `docs` 表）。 */
export interface Doc {
  /** 稳定主键，导入时生成，永不复用。 */
  readonly id: string;
  /** 显示标题：优先首个一级标题，否则文件名（去扩展名）。 */
  readonly title: string;
  /** 原始 Markdown 全文（已解码为 JS 字符串，不含 BOM）。 */
  readonly text: string;
  /** 原文编码，回写时按此编码回去，避免中文乱码。 */
  readonly encoding: TextEncoding;
  readonly source: DocSource;
  /** 外部文件的磁盘指纹；inline 来源为 null。 */
  readonly fingerprint: FileFingerprint | null;
  /** 导入时刻（毫秒）。 */
  readonly importedAt: number;
  /** 最后阅读时刻（毫秒）；从未打开为 null。 */
  readonly lastReadAt: number | null;
  /**
   * 阅读进度：可见区域顶部所在块的 bid 与该块内 0..1 的比例。
   * 记 bid 而非像素，字号改变后仍能回到同一位置。
   */
  readonly progress: ReadProgress | null;
}

/** 阅读位置。 */
export interface ReadProgress {
  readonly bid: string;
  /** 该块内相对偏移，0 表示块顶部。 */
  readonly ratio: number;
}

// ─────────────────────────────────────────────
// Markdown 渲染
// ─────────────────────────────────────────────

/** 目录条目。 */
export interface TocEntry {
  readonly level: number;
  readonly text: string;
  /** 对应的块锚点 id，点击后滚动到该块。 */
  readonly bid: string;
}

/** 一次渲染的结果。 */
export interface RenderResult {
  readonly html: string;
  readonly toc: readonly TocEntry[];
  /** 可标注块总数，用于自检与测试断言。 */
  readonly blockCount: number;
}

// ─────────────────────────────────────────────
// 标注
// ─────────────────────────────────────────────

export type MarkType = 'highlight' | 'underline' | 'strike' | 'note';

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';

/**
 * 标注锚点：四元组。
 * bid 定位到块，start/end 是块内字符偏移，quote + 前后文用于失效后重定位。
 */
export interface Anchor {
  readonly bid: string;
  readonly start: number;
  readonly end: number;
  /** 被标注原文（截断到 80 字符）。 */
  readonly quote: string;
  /** 锚点前 16 字符。 */
  readonly prefix: string;
  /** 锚点后 16 字符。 */
  readonly suffix: string;
}

/** 一条标注（存于 IndexedDB `marks` 表）。 */
export interface Mark {
  readonly id: string;
  readonly docId: string;
  readonly anchor: Anchor;
  readonly type: MarkType;
  /** 仅 highlight 类型有颜色。 */
  readonly color: HighlightColor | null;
  /** 批注正文；type === 'note' 或用户附加批注时非空。 */
  readonly note: string | null;
  readonly createdAt: number;
}

/** 重定位结果。 */
export type RelocateResult =
  | { readonly ok: true; readonly start: number; readonly end: number }
  /** 原文已改动到无法定位，调用方必须显式提示用户，绝不静默丢弃。 */
  | { readonly ok: false; readonly reason: 'quote-missing' | 'ambiguous' | 'block-missing' };

// ─────────────────────────────────────────────
// 选区（唯一需要 DOM 的 core 模块）
// ─────────────────────────────────────────────

/** 一次选区在单个块内的切片。 */
export interface SelectionPart {
  readonly bid: string;
  readonly start: number;
  readonly end: number;
  readonly quote: string;
}

/** 一次用户选区解析后的结果，可能跨多个块。 */
export interface SelectionInfo {
  readonly parts: readonly SelectionPart[];
  /** 全部选中文本（按文档顺序拼接，块间以 \n 连接）。 */
  readonly text: string;
  /** 选区包围盒（用于定位浮动工具条）。 */
  readonly rect: { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number };
}

// ─────────────────────────────────────────────
// 任务清单
// ─────────────────────────────────────────────

/**
 * 任务勾选状态。
 * 按设计只存应用内，不改写原文 —— 因此可随时安全撤销。
 */
export interface TaskState {
  readonly docId: string;
  readonly bid: string;
  /** 该块内第几个任务项（从 0 开始）。 */
  readonly index: number;
  readonly checked: boolean;
}

// ─────────────────────────────────────────────
// 设置
// ─────────────────────────────────────────────

/** 主题名。magazine 为默认；night 是同一排版骨架的深色版；paper 为备选极简风。 */
export type ThemeName = 'magazine' | 'night' | 'paper';

export interface Settings {
  readonly theme: ThemeName;
  /**
   * 字号档位 1..7（3 为默认）。
   * 存档位而非像素：像素值与主题曲线耦合，档位才不会互相打架。
   * 映射见 core/typography.ts 与 styles/tokens.css。
   */
  readonly typeScale: number;
  /** 行高档位 1..5（3 为默认）。 */
  readonly lineScale: number;
  /** 段落间距档位 1..3（2 为默认）。 */
  readonly paraScale: number;
  /** 字体族：系统黑体 / 系统衬线。 */
  readonly fontFamily: 'sans' | 'serif';
  /** 聚焦模式：未标注内容淡化。 */
  readonly focusMode: boolean;
  /** 长按查词开关。 */
  readonly lookupEnabled: boolean;
}

// ─────────────────────────────────────────────
// 状态树与动作
// ─────────────────────────────────────────────

/** 阅读器的就绪状态机。 */
export type ReaderStatus = 'idle' | 'loading' | 'ready' | 'error';

/** 应用全局状态。只读快照，变更一律经过 StateAction。 */
export interface State {
  readonly docs: readonly Doc[];
  readonly currentDocId: string | null;
  readonly marks: readonly Mark[];
  readonly tasks: readonly TaskState[];
  readonly settings: Settings;
  readonly readerStatus: ReaderStatus;
  readonly readerError: string | null;
  /** 当前渲染结果；无文档时为 null。 */
  readonly render: RenderResult | null;
  /** 全库搜索关键词；空串表示未搜索。 */
  readonly searchQuery: string;
  readonly searchResults: readonly SearchHit[];
  /** 当前打开的面板。 */
  readonly overlay: OverlayKind;
}

export type OverlayKind = 'none' | 'toc' | 'marks' | 'settings' | 'search' | 'font';

/** 全库搜索结果中的一条命中。 */
export interface SearchHit {
  readonly docId: string;
  readonly bid: string;
  readonly start: number;
  readonly end: number;
  /** 命中处上下文片段（用于列表展示）。 */
  readonly snippet: string;
}

/** 状态变更动作。视图只 dispatch，不直接改 state。 */
export type StateAction =
  | { readonly type: 'docs/loaded'; readonly docs: readonly Doc[] }
  | { readonly type: 'doc/opened'; readonly docId: string }
  | { readonly type: 'doc/closed' }
  | { readonly type: 'doc/imported'; readonly doc: Doc }
  | { readonly type: 'doc/deleted'; readonly docId: string }
  | { readonly type: 'doc/updated'; readonly doc: Doc }
  | { readonly type: 'reader/loading' }
  | { readonly type: 'reader/ready'; readonly render: RenderResult }
  | { readonly type: 'reader/error'; readonly message: string }
  | { readonly type: 'marks/loaded'; readonly marks: readonly Mark[] }
  | { readonly type: 'mark/added'; readonly mark: Mark }
  | { readonly type: 'mark/removed'; readonly markId: string }
  | { readonly type: 'tasks/loaded'; readonly tasks: readonly TaskState[] }
  | { readonly type: 'task/toggled'; readonly task: TaskState }
  | { readonly type: 'settings/changed'; readonly patch: Partial<Settings> }
  | { readonly type: 'search/queried'; readonly query: string; readonly results: readonly SearchHit[] }
  | { readonly type: 'overlay/opened'; readonly overlay: OverlayKind };

// ─────────────────────────────────────────────
// 词库
// ─────────────────────────────────────────────

/** 一条词条。 */
export interface DictEntry {
  readonly word: string;
  /** 音标，可能为空串。 */
  readonly phonetic: string;
  /** 中文释义（多行，以 \n 分隔）。 */
  readonly translation: string;
}

/** 查词结果。 */
export type LookupResult =
  | { readonly hit: true; readonly entry: DictEntry; readonly matchedBy: 'exact' | 'lemma' }
  /** 查不到时静默返回，调用方不弹窗 —— 这是刻意设计。 */
  | { readonly hit: false };
