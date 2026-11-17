/**
 * 标注（划词批注）的纯函数层 —— 阶段 E2。
 *
 * M3 已冻结锚点能力（core/anchors.ts 的 makeBid / captureAnchor / relocate），
 * 这里只做「围绕 Mark 的数据整理」：批量重定位、按文档过滤、按正文顺序排序、
 * 从选区构造标注、中文类型名、Markdown 导出。
 *
 * 全部纯函数：不碰 DOM、不读写数据库、不修改入参。
 * 重定位失败绝不静默丢弃 —— 原锚点原样保留，由调用方（视图/列表）显式标「失效」。
 */

import { captureAnchor, relocate } from './anchors';
import type { Anchor, HighlightColor, Mark, MarkType } from './types';

// ─────────────────────────────────────────────
// 重定位
// ─────────────────────────────────────────────

/** 一次批量重定位的结果。三个数组互斥：每条标注只会出现在 marks 之外的至多一个分组里。 */
export interface RelocatedMarks {
  /** 全部标注，顺序与输入一致：成功的是新对象（偏移变了）或原引用（没变），失效的是原对象。 */
  readonly marks: readonly Mark[];
  /** 偏移/锚点发生变化、需要写回数据库的标注（新对象）。 */
  readonly changed: readonly Mark[];
  /** 无法定位（块不存在 / 原文不存在 / 多处歧义）的标注，锚点保持原样。 */
  readonly orphans: readonly Mark[];
}

/**
 * 用最新的块文本批量重定位标注。
 *
 * 规则：
 *  - blockTexts 里没有该 bid            → 失效（block-missing 的语义）；
 *  - relocate 成功且 start/end 没变      → 原对象引用（零成本，不触发重绘/持久化）；
 *  - relocate 成功但偏移变了             → 用新位置重新 captureAnchor，生成新 Mark 放进 changed；
 *  - relocate 失败                       → 原对象放进 orphans，marks 里也保留原对象。
 *
 * @param marks      该文档的全部标注（顺序即输出顺序）
 * @param blockTexts 当前渲染产出的块文本（bid → 块纯文本，按文档顺序）
 */
export function relocateMarks(
  marks: readonly Mark[],
  blockTexts: ReadonlyMap<string, string>,
): RelocatedMarks {
  const next: Mark[] = [];
  const changed: Mark[] = [];
  const orphans: Mark[] = [];

  for (const mark of marks) {
    const text = blockTexts.get(mark.anchor.bid);
    if (text === undefined) {
      // 块整块没了：连锚点都没法校验，直接算失效。
      orphans.push(mark);
      next.push(mark);
      continue;
    }

    const result = relocate(mark.anchor, text);
    if (!result.ok) {
      // 原文被删 / 多处歧义：不猜位置，保留原锚点，交给界面标「失效」。
      orphans.push(mark);
      next.push(mark);
      continue;
    }

    if (result.start === mark.anchor.start && result.end === mark.anchor.end) {
      // 第 1 档命中：什么都不用改，保持引用让上层可以按 === 跳过持久化。
      next.push(mark);
      continue;
    }

    const moved: Mark = { ...mark, anchor: captureAnchor(mark.anchor.bid, text, result.start, result.end) };
    changed.push(moved);
    next.push(moved);
  }

  return { marks: next, changed, orphans };
}

// ─────────────────────────────────────────────
// 过滤与排序
// ─────────────────────────────────────────────

/** 取一篇文档的标注（顺序保持输入顺序）。 */
export function marksForDoc(marks: readonly Mark[], docId: string): Mark[] {
  return marks.filter((mark) => mark.docId === docId);
}

/** 已知块的排序键；缺失块统一用这个哨兵值排到最后。 */
const MISSING_BLOCK = Number.MAX_SAFE_INTEGER;

/**
 * 按正文顺序排序标注：块在 blockTexts 中的先后 → 同块内 start 升序。
 *
 * blockTexts 里没有的块（块被删了）排最后，块之间按 bid 稳定排序；
 * 所有排序键都相同时按输入顺序，保证结果稳定可测。
 */
export function orderMarks(marks: readonly Mark[], blockTexts: ReadonlyMap<string, string>): Mark[] {
  const blockIndex = new Map<string, number>();
  let index = 0;
  for (const bid of blockTexts.keys()) blockIndex.set(bid, index++);

  const decorated = marks.map((mark, inputIndex) => ({
    mark,
    inputIndex,
    block: blockIndex.get(mark.anchor.bid) ?? MISSING_BLOCK,
  }));

  decorated.sort((a, b) => {
    if (a.block !== b.block) return a.block - b.block;
    // 缺失块之间按块 id 聚拢；已知块不需要再比 bid（block 序号已唯一确定块）。
    if (a.block === MISSING_BLOCK && a.mark.anchor.bid !== b.mark.anchor.bid) {
      return a.mark.anchor.bid < b.mark.anchor.bid ? -1 : 1;
    }
    if (a.mark.anchor.start !== b.mark.anchor.start) return a.mark.anchor.start - b.mark.anchor.start;
    return a.inputIndex - b.inputIndex;
  });

  return decorated.map((item) => item.mark);
}

// ─────────────────────────────────────────────
// 构造
// ─────────────────────────────────────────────

/** 从一次选区（已归一化到块纯文本坐标）构造标注所需的信息。 */
export interface BuildMarkInput {
  readonly id: string;
  readonly docId: string;
  readonly bid: string;
  readonly blockText: string;
  readonly start: number;
  readonly end: number;
  readonly type: MarkType;
  readonly color: HighlightColor | null;
  readonly note: string | null;
  readonly createdAt: number;
}

/**
 * 构造一条标注。
 *
 * 锚点统一走 captureAnchor，因此 start/end 的越界与倒置会被自动夹到合法范围
 * （start ∈ [0, len]、end ∈ [start, len]），不会产生非法偏移。
 */
export function buildMark(input: BuildMarkInput): Mark {
  // captureAnchor 内部已做夹紧，这里不重复实现一套坐标规则。
  const anchor = captureAnchor(input.bid, input.blockText, input.start, input.end);
  const mark: Mark = {
    id: input.id,
    docId: input.docId,
    anchor,
    type: input.type,
    color: input.color,
    note: input.note,
    createdAt: input.createdAt,
  };
  return mark;
}

// ─────────────────────────────────────────────
// 展示
// ─────────────────────────────────────────────

/** 高亮类型的中文名（按颜色区分）；颜色缺失时退化成「高亮」。 */
const HIGHLIGHT_LABELS: Readonly<Record<HighlightColor, string>> = {
  yellow: '黄色高亮',
  green: '绿色高亮',
  blue: '蓝色高亮',
  pink: '粉色高亮',
};

/**
 * 标注类型的中文名。
 * 四种高亮按颜色分别命名，其余三种类型与颜色无关。
 */
export function markLabel(type: MarkType, color: HighlightColor | null): string {
  switch (type) {
    case 'highlight':
      return color === null ? '高亮' : HIGHLIGHT_LABELS[color];
    case 'underline':
      return '下划线';
    case 'strike':
      return '删除线';
    case 'note':
      return '批注';
  }
}

// ─────────────────────────────────────────────
// Markdown 导出
// ─────────────────────────────────────────────

/** 标题为空时的兜底显示名。 */
const UNTITLED = '未命名文档';
/** 失效标注在导出里的前缀。 */
const ORPHAN_LABEL = '失效';

/** 把可能含换行的文本压成单行（导出是给人看的，不需要保留原换行）。 */
function singleLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, ' ');
}

/**
 * 把一篇文档的标注导出成 Markdown（纯文本，供剪贴板）。
 *
 * 固定格式（后续 smoke 会断言关键字，不要随手改）：
 * ```
 * # <标题> · 批注（N 条）
 *
 * - [黄色高亮] 原文摘录
 *   - 备注：备注内容
 * - [失效] 原文摘录
 * ```
 *
 * 排序走 orderMarks（正文顺序）；orphanIds 里的条目标「失效」；
 * 备注另起一行、缩进两格。刻意不转义引号/反引号 —— 这是人读的导出，不是再解析。
 */
export function marksToMarkdown(
  title: string,
  marks: readonly Mark[],
  blockTexts: ReadonlyMap<string, string>,
  orphanIds?: ReadonlySet<string>,
): string {
  const safeTitle = title.trim().length === 0 ? UNTITLED : title.trim();
  const lines: string[] = [`# ${safeTitle} · 批注（${marks.length} 条）`];

  if (marks.length > 0) {
    lines.push('');
    for (const mark of orderMarks(marks, blockTexts)) {
      const label = orphanIds?.has(mark.id) === true ? ORPHAN_LABEL : markLabel(mark.type, mark.color);
      lines.push(`- [${label}] ${singleLine(mark.anchor.quote)}`);
      if (mark.note !== null && mark.note.length > 0) {
        lines.push(`  - 备注：${singleLine(mark.note)}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}
