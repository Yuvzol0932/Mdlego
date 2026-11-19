/**
 * 正文分片窗口计算（转场改造 Step 1）—— 纯函数，无 DOM 依赖。
 *
 * 背景：阅读页原来「首屏只挂文档开头的第一片」，打开一本读到 30%–80% 的书时
 * 必须先露出文档开头，再靠逐帧 `mdlego:mount-next` 追上目标块 —— 用户看到的是
 * 「先露第一屏，再瞬移」。这里把「该先挂哪一段」变成一次纯计算：以目标 `bid`
 * 为中心取一个固定大小的窗口，首屏直接呈现用户上次读到的位置。
 *
 * 分两层概念，避免混淆：
 *   - **块（block）**：带 `data-bid` 的可标注块，文档顺序编号 0..total-1；
 *   - **分片（chunk）**：渲染器按顶层块边界切出的 HTML 片段，
 *     每个分片覆盖一段连续的块区间。
 *
 * 窗口在「块」空间里按计划书的公式计算（可单测），
 * 落地挂载时再映射到「分片」空间（DOM 插入的最小粒度）。
 */

/** 阅读进度锚点：块 id + 块内相对位置（0=块顶，1=块底）。 */
export interface AnchorPoint {
  readonly bid: string;
  readonly ratio: number;
}

/** 首屏窗口（块索引，左闭右开）。 */
export interface BlockWindow {
  /** 窗口首块索引（含）。 */
  readonly startIdx: number;
  /** 窗口末块索引（不含）。 */
  readonly endIdx: number;
  /** 目标块索引；未命中时为 0。 */
  readonly targetIdx: number;
  /** 窗口之上还有块（需要向上补齐）。 */
  readonly hasHead: boolean;
  /** 窗口之下还有块（需要向下补齐）。 */
  readonly hasTail: boolean;
}

/** 一个分片覆盖的块区间（左闭右开）。 */
export interface ChunkBlockRange {
  readonly startIdx: number;
  readonly endIdx: number;
}

/** 默认窗口块数。 */
export const WINDOW_SIZE = 64;

/**
 * **首屏**块窗口大小（1.2.1 #C）。
 *
 * 为什么不是一个常量：块窗口按「块」算，但 DOM 插入的最小粒度是「分片」
 * （首片 24 块，其余每片 64 块）。窗口 64 块跨到 2–3 个分片时，
 * 实际挂载量会膨胀到 400+ 块 —— 真机实测 481 块，首帧 40.8ms（中位）/
 * 48.6ms（最慢），超过 30ms 红线。
 *
 * 所以首屏只取「够填满一屏 + 少量上方缓冲」：
 *   - 一屏在手机上约 8–12 个块；
 *   - 加上向上 LEAD_BLOCKS 的缓冲，24 块足够；
 *   - 落在分片边界上时最多跨 2 片（首片 24 块 + 下一片 64 块 = 88 块），
 *     仍然远小于原来的 481。
 *
 * 转场结束后由 scheduleRemainder 用 WINDOW_SIZE 的粒度继续补齐，
 * 所以用户滚动不会缺内容。
 */
export const FIRST_WINDOW_BLOCKS = 24;
/** 目标块之前保留的块数（让用户能往上滑一点，不必立刻触发补齐）。 */
export const LEAD_BLOCKS = 12;
/** 向上前插时每批的块数。 */
export const HEAD_BATCH_BLOCKS = 48;
/** 向上滚动距离顶部多少像素以内时，不再等空闲、立即补一批。 */
export const HEAD_URGENT_PX = 240;
/** 向下滚动距离顶部超过该像素值时，才认为可以安全地做「向上前插」。 */
export const HEAD_IDLE_PX = 600;

/** 在块 id 列表里查目标块索引；找不到返回 -1。 */
export function findBlockIndex(blockIds: readonly string[], bid: string): number {
  if (bid.length === 0) return -1;
  for (let i = 0; i < blockIds.length; i++) {
    if (blockIds[i] === bid) return i;
  }
  return -1;
}

const clampInt = (n: number, min: number, max: number): number => {
  if (!Number.isFinite(n)) return min;
  const v = Math.trunc(n);
  return v < min ? min : v > max ? max : v;
};

/**
 * 计算首屏窗口（块索引）。
 *
 * 公式来自改造计划书 Step 1：
 *   targetIdx = 匹配 anchor.bid 的索引；未提供或未命中 → 0
 *   startIdx  = max(0, targetIdx - leadBlocks)
 *   endIdx    = min(total, startIdx + windowSize)
 *   靠近文末导致不足 windowSize 时，再向前修正 startIdx = max(0, endIdx - windowSize)
 *
 * @param total 块总数
 * @param anchor 阅读进度锚点；null/未命中 → 从文档开头取窗口
 * @param blockIds 文档顺序的块 id 列表（用于定位 anchor）
 */
export function computeBlockWindow(
  total: number,
  anchor: AnchorPoint | null,
  blockIds: readonly string[],
  windowSize: number = WINDOW_SIZE,
  leadBlocks: number = LEAD_BLOCKS,
): BlockWindow {
  const count = clampInt(total, 0, Number.MAX_SAFE_INTEGER);
  if (count === 0) {
    return { startIdx: 0, endIdx: 0, targetIdx: 0, hasHead: false, hasTail: false };
  }

  const size = clampInt(windowSize, 1, count);
  const lead = clampInt(leadBlocks, 0, count);

  const hit = anchor === null ? -1 : findBlockIndex(blockIds, anchor.bid);
  const targetIdx = hit >= 0 && hit < count ? hit : 0;

  let startIdx = Math.max(0, targetIdx - lead);
  let endIdx = Math.min(count, startIdx + size);
  // 靠近文末时窗口会被截短：再向前修正，保证首屏块数稳定
  if (endIdx - startIdx < size) startIdx = Math.max(0, endIdx - size);
  // 文档尾部对齐后仍可能不足（size 已按 count 收敛，这里只是防御）
  endIdx = Math.min(count, Math.max(endIdx, startIdx));

  return {
    startIdx,
    endIdx,
    targetIdx,
    hasHead: startIdx > 0,
    hasTail: endIdx < count,
  };
}

/**
 * 窗口（块索引）→ 需要同步挂载的分片区间（分片索引，左闭右开）。
 *
 * 分片区间可能完全不相交（如块总数为 0），此时返回 `firstChunk = -1`。
 */
export function chunksForBlockWindow(
  ranges: readonly ChunkBlockRange[],
  window: BlockWindow,
): { readonly firstChunk: number; readonly lastChunk: number } {
  if (ranges.length === 0 || window.endIdx <= window.startIdx) {
    return { firstChunk: -1, lastChunk: -1 };
  }
  let firstChunk = -1;
  let lastChunk = -1;
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    if (range === undefined) continue;
    // 该分片与本窗口有交集
    if (range.endIdx > window.startIdx && range.startIdx < window.endIdx) {
      if (firstChunk < 0) firstChunk = i;
      lastChunk = i;
    }
  }
  if (firstChunk < 0) return { firstChunk: -1, lastChunk: -1 };
  return { firstChunk, lastChunk };
}

/** 该分片覆盖的块数（渲染器给的区间可能为空片）。 */
export function blocksInRange(range: ChunkBlockRange): number {
  return Math.max(0, range.endIdx - range.startIdx);
}

/** 下一批向上前插的块区间（左闭右开），贴着当前头游标逆序前插。 */
export function headBatch(headCursor: number, batchSize: number = HEAD_BATCH_BLOCKS): ChunkBlockRange | null {
  if (headCursor <= 0) return null;
  const size = Math.max(1, Math.trunc(batchSize));
  return { startIdx: Math.max(0, headCursor - size), endIdx: headCursor };
}

/** 下一批向下追加的块区间（左闭右开）。 */
export function tailBatch(
  tailCursor: number,
  total: number,
  batchSize: number = WINDOW_SIZE,
): ChunkBlockRange | null {
  if (tailCursor >= total) return null;
  const size = Math.max(1, Math.trunc(batchSize));
  return { startIdx: tailCursor, endIdx: Math.min(total, tailCursor + size) };
}

/**
 * 向上前插时的高度差补偿量。
 *
 * `overflow-anchor: none` 关掉浏览器原生滚动锚定后再手动补：
 * 插入后容器变高了 delta 像素，把 scrollTop 加回去，用户看到的正文位置不动。
 */
export function scrollCompensation(prevScrollHeight: number, nextScrollHeight: number): number {
  const delta = nextScrollHeight - prevScrollHeight;
  return Number.isFinite(delta) && delta > 0 ? delta : 0;
}

/** 恢复滚动位置：原位置 + 头部新增高度（不小于 0）。 */
export function compensatedScrollTop(prevScrollTop: number, delta: number): number {
  const base = Number.isFinite(prevScrollTop) ? prevScrollTop : 0;
  const add = Number.isFinite(delta) && delta > 0 ? delta : 0;
  return Math.max(0, base + add);
}
