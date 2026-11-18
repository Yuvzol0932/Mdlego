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
  /**
   * 用户标签（阶段 E1）。旧数据没有该字段，读取时归一化为空数组；
   * 归一化与上限见 core/library.ts。
   */
  readonly tags?: readonly string[];
  /** 单层文件夹名（阶段 E1）；null/缺省表示未归档。 */
  readonly folder?: string | null;
}

/** 阅读位置。 */
export interface ReadProgress {
  readonly bid: string;
  /** 该块内相对偏移，0 表示块顶部。 */
  readonly ratio: number;
  /**
   * 全文阅读百分比（0..100，按滚动位置算）。
   * 旧数据没有这个字段：书架/继续阅读卡在这种情况下不显示百分比，而不是猜一个。
   */
  readonly percent?: number;
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

/** 一个分片覆盖的块区间（左闭右开，块按文档顺序编号 0..blockCount-1）。 */
export interface ChunkBlockRange {
  readonly startIdx: number;
  readonly endIdx: number;
}

/** 一次渲染的结果。 */
export interface RenderResult {
  /** 全量 HTML；懒分片结果在首次访问时把剩余分片补齐（语义与一次性渲染相同）。 */
  readonly html: string;
  /**
   * HTML 分片：首片约 `FIRST_SCREEN_BLOCKS` 块，其余每片约 `LAZY_CHUNK_BLOCKS` 块。
   * 拼接后等于 `html`；没有分块需求时就是 `[html]`。
   */
  readonly htmlChunks: readonly string[];
  /** 首片 HTML（阅读页首屏只挂这一片；不受懒补齐影响）。 */
  readonly firstHtmlChunk: string;
  /** 懒分片：取下一片 HTML；没有剩余返回 null。非懒渲染时 undefined。 */
  readonly nextHtmlChunk?: () => string | null;
  /**
   * 按索引取某一片 HTML（懒渲染时按需渲染该片，已渲染的复用）。
   *
   * 转场改造 Step 1：首屏窗口以目标 `bid` 为中心，要挂的可能是文档中间的一批分片，
   * 只靠顺序 `nextHtmlChunk` 无法直接取到。索引越界返回 null。
   */
  readonly htmlChunkAt: (index: number) => string | null;
  /**
   * 按文档顺序排列的全部块 id（与 `blockCount` 等长）。
   * 纯数据，供 `core/window.ts` 的纯函数定位锚点块，不需要碰 DOM。
   */
  readonly blockIds: readonly string[];
  /** 每个分片覆盖的块区间，长度与 `htmlChunks` 相同。 */
  readonly chunkBlockRanges: readonly ChunkBlockRange[];
  readonly toc: readonly TocEntry[];
  /** 可标注块总数，用于自检与测试断言。 */
  readonly blockCount: number;
  /**
   * 块 id → 块纯文本，按文档顺序。
   * 由渲染器在生成 token 时顺带产出，供搜索使用。
   * 刻意不让 core 事后用 DOMParser 解析 HTML —— 那会让 core 依赖 DOM，
   * 也无法在 node 环境里测试。
   */
  readonly blockTexts: ReadonlyMap<string, string>;
}

// ─────────────────────────────────────────────
// 生词本 / 查词历史（阶段 E4）
// ─────────────────────────────────────────────

export interface WordEntry {
  readonly word: string;
  readonly phonetic: string;
  readonly translation: string;
  readonly addedAt: number;
}

export interface LookupHistoryEntry {
  readonly word: string;
  readonly at: number;
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
export type ThemeName =
  | 'warm-night'
  | 'warm-paper'
  | 'forest'
  | 'slate'
  | 'magazine'
  | 'night'
  | 'paper';

/** 用户选择：具体主题，或跟随系统明暗。 */
export type ThemeChoice = ThemeName | 'system';

/** 强调色预设。 */
export type AccentName = 'amber' | 'rust' | 'jade' | 'sky' | 'rose' | 'violet' | 'olive' | 'slate';

/** 材质：玻璃 / 柔和半透明（无模糊）/ 纯色。 */
export type MaterialName = 'glass' | 'soft' | 'solid';

/** 动效强度。 */
export type MotionLevel = 'off' | 'simple' | 'full';

export interface Settings {
  readonly theme: ThemeChoice;
  /** 强调色；'theme' = 跟随主题默认。 */
  readonly accent: AccentName | 'theme';
  readonly material: MaterialName;
  /** 玻璃强度档 1..3（弱/标准/强）。 */
  readonly glassLevel: number;
  readonly motion: MotionLevel;
  /** 是否已经提示过「建议切柔和半透明」（只提示一次）。 */
  readonly materialHinted: boolean;
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
  /**
   * 自定义横幅背景图（data URL）；null 表示用主题渐变 + 噪点。
   * 存在 localStorage 里，所以导入时已经缩图压到 ~200KB 以内（见 data/banner.ts）。
   */
  readonly bannerImage: string | null;
  /**
   * 横幅「今日一句」的语录列表。空数组表示用内置默认语录。
   * 用户在设置里一行一句编辑；不伪造内容，默认只放几句通用阅读语录。
   */
  readonly quotes: readonly string[];
  /**
   * 阅读时保持屏幕常亮（阶段 C5）。
   * 走浏览器 Screen Wake Lock API，不支持的环境静默降级（设置照存，只是不生效）。
   */
  readonly keepAwake: boolean;
  /**
   * 护眼模式（阶段 E6）：整页叠一层暖色、降低蓝光。
   * 只影响观感，不改排版/批注坐标；实现是固定覆盖层，不影响滚动与选择。
   */
  readonly eyeCare: boolean;
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
  /** 生词本（阶段 E4）。 */
  readonly words: readonly WordEntry[];
  /** 查词历史（阶段 E4）。 */
  readonly lookupHistory: readonly LookupHistoryEntry[];
  readonly tasks: readonly TaskState[];
  readonly settings: Settings;
  readonly readerStatus: ReaderStatus;
  readonly readerError: string | null;
  /** 当前渲染结果；无文档时为 null。 */
  readonly render: RenderResult | null;
  /** 全库搜索关键词；空串表示未搜索。 */
  readonly searchQuery: string;
  readonly searchResults: readonly SearchHit[];
  /** 阅读统计快照；尚未加载或没有数据时为 null。 */
  readonly stats: StatsSnapshot | null;
  /** 收藏（书签）的文档 id 列表。存 IndexedDB meta 表，跨启动保留。 */
  readonly bookmarks: readonly string[];
  /** 当前打开的面板。 */
  readonly overlay: OverlayKind;
  /** 页面栈 + 浮层栈（见 core/nav.ts）。 */
  readonly nav: NavState;
}

/** 一级 tab（书架 / 搜索 / 统计 / 设置；kit 仅开发构建可见）。 */
export type Tab = 'shelf' | 'search' | 'stats' | 'settings' | 'kit';

/** 页面栈里的一页：一级 tab 或二级阅读页。 */
export type Page =
  | { readonly kind: 'tab'; readonly tab: Tab }
  | { readonly kind: 'reader'; readonly docId: string }
  | { readonly kind: 'editor'; readonly docId: string };

/**
 * 挂在页面之上的浮层。
 *
 * toc     目录抽屉
 * search  单篇搜索
 * lookup  长按查词卡片
 * menu    锚定菜单（书架排序/视图、阅读「更多」）—— 内容不进 state
 * typeset 阅读排版面板（Aa）
 * image   正文图片全屏查看
 */
export type LayerKind = 'toc' | 'search' | 'lookup' | 'menu' | 'typeset' | 'image' | 'collection' | 'marks' | 'note' | 'wordbook';

/** 导航状态。 */
export interface NavState {
  /** 页面栈，栈底在前；永不为空。 */
  readonly pages: readonly Page[];
  /** 浮层栈，栈底在前。 */
  readonly layers: readonly LayerKind[];
}

export type OverlayKind = 'none' | 'toc' | 'marks' | 'settings' | 'search';

/** 全库搜索结果中的一条命中。 */
export interface SearchHit {
  readonly docId: string;
  readonly bid: string;
  readonly start: number;
  readonly end: number;
  /** 命中处上下文片段（用于列表展示）。 */
  readonly snippet: string;
}

// ─────────────────────────────────────────────
// 阅读统计（阶段 C6）
// ─────────────────────────────────────────────

/** 一次阅读会话（存于 IndexedDB `sessions` 表）。 */
export interface ReadingSession {
  readonly id: string;
  readonly docId: string;
  /** 开始 / 结束时刻（毫秒）。 */
  readonly startedAt: number;
  readonly endedAt: number;
  /** 净阅读时长（毫秒），不含后台挂起时间。 */
  readonly ms: number;
}

/** 某一天（本地时区 YYYY-MM-DD）的阅读时长。 */
export interface DailyReading {
  readonly day: string;
  readonly ms: number;
}

/** 最近读过的文档（统计页列表用）。 */
export interface RecentDoc {
  readonly docId: string;
  readonly title: string;
  readonly lastReadAt: number;
}

/**
 * 统计快照：由 `core/stats.ts` 从会话与文档纯函数算出，main.ts 在启动/关文档时刷新。
 * 没读过任何东西时为 null，页面显示空状态而不是伪造数字。
 */
export interface StatsSnapshot {
  readonly todayMs: number;
  /** 连续阅读天数（今天没读则从昨天算起）。 */
  readonly streakDays: number;
  /** 累计读过的文档数。 */
  readonly docCount: number;
  /** 最近 7 天（旧 → 新，含今天）。 */
  readonly week: readonly DailyReading[];
  readonly recent: readonly RecentDoc[];
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
  | { readonly type: 'words/loaded'; readonly words: readonly WordEntry[] }
  | { readonly type: 'lookup-history/loaded'; readonly history: readonly LookupHistoryEntry[] }
  | { readonly type: 'mark/added'; readonly mark: Mark }
  | { readonly type: 'mark/removed'; readonly markId: string }
  | { readonly type: 'mark/updated'; readonly mark: Mark }
  | { readonly type: 'tasks/loaded'; readonly tasks: readonly TaskState[] }
  | { readonly type: 'task/toggled'; readonly task: TaskState }
  | { readonly type: 'settings/changed'; readonly patch: Partial<Settings> }
  | { readonly type: 'search/queried'; readonly query: string; readonly results: readonly SearchHit[] }
  | { readonly type: 'stats/loaded'; readonly stats: StatsSnapshot | null }
  | { readonly type: 'bookmarks/loaded'; readonly bookmarks: readonly string[] }
  | { readonly type: 'bookmark/toggled'; readonly docId: string }
  | { readonly type: 'overlay/opened'; readonly overlay: OverlayKind }
  | { readonly type: 'nav/tab'; readonly tab: Tab }
  | { readonly type: 'nav/push'; readonly page: Page }
  | { readonly type: 'nav/back' }
  | { readonly type: 'layer/opened'; readonly layer: LayerKind }
  | { readonly type: 'layer/closed'; readonly layer: LayerKind };

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
  | {
      readonly hit: true;
      readonly entry: DictEntry;
      readonly matchedBy: 'exact' | 'lemma';
      /**
       * 这个词在 lemma 索引里的原形（lookup #7 的词形行用）。
       *
       * 为什么精确命中也要带：词库里 49626 个变形词（persisted / better / went…）
       * 自己就有独立条目，查它们走的是 exact，但用户在正文里长按的是变形形态，
       * 能查到原形就该告诉他（`persisted → persist`）。
       * 与 entry.word 相同或索引里没有这个词时为空。
       */
      readonly lemmaOf?: string;
    }
  /** 查不到时静默返回，调用方不弹窗 —— 这是刻意设计。 */
  | { readonly hit: false };
