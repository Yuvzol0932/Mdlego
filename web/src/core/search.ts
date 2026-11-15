/**
 * 单篇搜索 —— 纯逻辑，零 DOM 依赖。
 *
 * 搜索基于渲染器在解析时顺带产出的 blockTexts（块 id → 块纯文本），
 * 命中位置用 bid + 块内偏移表示，点结果时能直接滚到对应块。
 *
 * 刻意不使用 DOMParser：core/ 必须能在 node 环境里直接测试，
 * 也避免「解析一遍 HTML 再解析一遍」的浪费。
 */

import type { RenderResult, SearchHit } from './types';

/** 生成命中上下文片段（关键词两侧各取若干字）。 */
function snippetAround(text: string, start: number, end: number, radius = 18): string {
  const from = Math.max(0, start - radius);
  const to = Math.min(text.length, end + radius);
  const before = from > 0 ? '…' : '';
  const after = to < text.length ? '…' : '';
  return before + text.slice(from, to) + after;
}

/**
 * 在渲染结果里搜索关键词，返回命中列表。
 *
 * 大小写不敏感（英文笔记常见）、空关键词返回空、不修改任何输入。
 * 结果按 blockTexts 的插入顺序（即文档顺序）排列。
 */
export function searchInRender(
  render: RenderResult,
  docId: string,
  query: string,
): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];

  const hits: SearchHit[] = [];

  for (const [bid, text] of render.blockTexts) {
    const lower = text.toLowerCase();
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      hits.push({
        docId,
        bid,
        start: at,
        end: at + needle.length,
        snippet: snippetAround(text, at, at + needle.length),
      });
      from = at + Math.max(1, needle.length);
      // 全局上限，避免超长文档里某个词反复出现拖垮列表
      if (hits.length >= 500) return hits;
    }
  }

  return hits;
}

/**
 * 按块在文档中出现的顺序排序命中。
 * blockTexts 本身已保序，此函数供外部在合并多来源结果时复用。
 */
export function orderHitsByBlocks(hits: readonly SearchHit[], render: RenderResult): SearchHit[] {
  const order = new Map<string, number>();
  let index = 0;
  for (const bid of render.blockTexts.keys()) {
    if (!order.has(bid)) order.set(bid, index++);
  }
  return [...hits].sort((a, b) => {
    const ai = order.get(a.bid) ?? Number.MAX_SAFE_INTEGER;
    const bi = order.get(b.bid) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi || a.start - b.start;
  });
}

/**
 * 从渲染结果里取出「块 id → 块纯文本」的映射。
 * 保留这个导出是为了让视图层与测试有一个明确入口，
 * 但实现只是返回渲染器已算好的数据，不再解析 HTML。
 */
export function extractBlockTexts(render: RenderResult): ReadonlyMap<string, string> {
  return render.blockTexts;
}
