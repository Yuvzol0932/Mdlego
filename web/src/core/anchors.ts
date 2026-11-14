import type { Anchor, RelocateResult } from './types';
import { shortHash } from './text';

/** 生成锚点 id 时使用的前缀字符数。用块的开头做指纹，比整块哈希稳定。 */
const BID_PREFIX_LEN = 24;

/** quote 的最大保存长度。 */
export const QUOTE_MAX = 80;

/** 前后文保存长度。 */
export const CONTEXT_LEN = 16;

/**
 * 生成块标识。
 *
 * 设计要点：用「块的开头 24 个字符 + 序号」而不是整块内容哈希。
 * 整块哈希的问题是一改字就失效；而块的开头通常不会变，
 * 因此小幅编辑后 bid 仍然稳定，标注也跟着稳定。
 *
 * @param kind    块类型（p / h1 / li / td ...）
 * @param text    块内纯文本
 * @param ordinal 同类型同前缀块的出现序号，用于消除碰撞
 */
export function makeBid(kind: string, text: string, ordinal: number): string {
  const prefix = text.slice(0, BID_PREFIX_LEN);
  return `${kind}-${shortHash(prefix)}-${ordinal}`;
}

/** 从一个块文本中截取锚点需要的四元信息。 */
export function captureAnchor(
  bid: string,
  blockText: string,
  start: number,
  end: number,
): Anchor {
  const safeStart = Math.max(0, Math.min(start, blockText.length));
  const safeEnd = Math.max(safeStart, Math.min(end, blockText.length));
  return {
    bid,
    start: safeStart,
    end: safeEnd,
    quote: blockText.slice(safeStart, Math.min(safeEnd, safeStart + QUOTE_MAX)),
    prefix: blockText.slice(Math.max(0, safeStart - CONTEXT_LEN), safeStart),
    suffix: blockText.slice(safeEnd, safeEnd + CONTEXT_LEN),
  };
}

/**
 * 在给定的块文本中重新定位锚点。
 *
 * 三档策略，逐档收紧：
 *   1. 原文仍在原偏移处        → 直接用（最常见，零成本）
 *   2. prefix+quote+suffix 唯一 → 用组合串定位
 *   3. quote 唯一              → 只靠原文定位
 *
 * 三档全失败就返回失败原因，由调用方显式提示用户。
 * **绝不猜测位置** —— 静默错位比丢失更糟。
 */
export function relocate(anchor: Anchor, blockText: string): RelocateResult {
  const { start, end, quote, prefix, suffix } = anchor;

  if (quote.length === 0) {
    return { ok: false, reason: 'quote-missing' };
  }

  // 第 1 档：原偏移处的文本仍然吻合
  if (blockText.slice(start, end) === quote) {
    return { ok: true, start, end };
  }

  // 第 2 档：前后文夹住原文，唯一匹配
  if (prefix.length > 0 || suffix.length > 0) {
    const needle = prefix + quote + suffix;
    const from = findUnique(blockText, needle);
    if (from >= 0) {
      const quoteStart = from + prefix.length;
      return { ok: true, start: quoteStart, end: quoteStart + quote.length };
    }
  }

  // 第 3 档：只靠原文，唯一匹配
  const occurrences = countOccurrences(blockText, quote);
  if (occurrences === 0) {
    return { ok: false, reason: 'quote-missing' };
  }
  if (occurrences > 1) {
    // 出现多次且前后文也没帮上忙 —— 无法确定是哪一处，明确拒绝
    return { ok: false, reason: 'ambiguous' };
  }

  const at = blockText.indexOf(quote);
  return { ok: true, start: at, end: at + quote.length };
}

/** 若 needle 在 haystack 中恰好出现一次，返回其下标；否则返回 -1。 */
function findUnique(haystack: string, needle: string): number {
  if (needle.length === 0) return -1;
  const first = haystack.indexOf(needle);
  if (first < 0) return -1;
  const second = haystack.indexOf(needle, first + 1);
  return second < 0 ? first : -1;
}

/** 统计子串出现次数（不重叠）。 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    count++;
    from = at + needle.length;
  }
  return count;
}
