/**
 * 首屏窗口计算单测（转场改造 Step 1）。
 *
 * 覆盖计划书里点名的三件事：
 *   ① 锚点窗口 [startIdx, endIdx] 的边界（开头/中间/文末/未命中/空文档）
 *   ② 向上前插分片时 scrollTop 差值补偿零跳动
 *   ③ 窗口 → 分片区间的映射
 */

import { describe, expect, it } from 'vitest';
import {
  HEAD_BATCH_BLOCKS,
  WINDOW_SIZE,
  LEAD_BLOCKS,
  blocksInRange,
  chunksForBlockWindow,
  compensatedScrollTop,
  computeBlockWindow,
  findBlockIndex,
  headBatch,
  scrollCompensation,
  tailBatch,
  type ChunkBlockRange,
} from './window';

/** 造 n 个形如 `b0..b(n-1)` 的块 id。 */
function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `b${i}`);
}

describe('findBlockIndex', () => {
  it('命中返回索引，未命中返回 -1', () => {
    const list = ids(5);
    expect(findBlockIndex(list, 'b0')).toBe(0);
    expect(findBlockIndex(list, 'b3')).toBe(3);
    expect(findBlockIndex(list, 'nope')).toBe(-1);
  });

  it('空 bid 不进扫描', () => {
    expect(findBlockIndex(ids(3), '')).toBe(-1);
  });
});

describe('computeBlockWindow：锚点窗口边界', () => {
  it('无锚点 → 从文档开头取窗口', () => {
    const w = computeBlockWindow(500, null, ids(500));
    expect(w.startIdx).toBe(0);
    expect(w.endIdx).toBe(WINDOW_SIZE);
    expect(w.targetIdx).toBe(0);
    expect(w.hasHead).toBe(false);
    expect(w.hasTail).toBe(true);
  });

  it('锚点未命中 → 回退到开头', () => {
    const w = computeBlockWindow(500, { bid: 'ghost', ratio: 0.5 }, ids(500));
    expect(w.startIdx).toBe(0);
    expect(w.targetIdx).toBe(0);
  });

  it('目标块在中间 → 目标落在窗口内，头部留 LEAD_BLOCKS 缓冲', () => {
    const total = 500;
    const w = computeBlockWindow(total, { bid: 'b300', ratio: 0.4 }, ids(total));
    expect(w.targetIdx).toBe(300);
    expect(w.startIdx).toBe(300 - LEAD_BLOCKS);
    expect(w.endIdx).toBe(300 - LEAD_BLOCKS + WINDOW_SIZE);
    expect(w.startIdx).toBeLessThanOrEqual(300);
    expect(w.endIdx).toBeGreaterThan(300);
    expect(w.hasHead).toBe(true);
    expect(w.hasTail).toBe(true);
  });

  it('窗口长度恒为 windowSize（文档足够长时）', () => {
    for (const target of [0, 1, 12, 13, 100, 400, 499, 500 - 1]) {
      const w = computeBlockWindow(500, { bid: `b${target}`, ratio: 0 }, ids(500));
      expect(w.endIdx - w.startIdx).toBe(WINDOW_SIZE);
    }
  });

  it('靠近文末 → 向前修正 startIdx，窗口仍然满长且不越界', () => {
    const total = 100;
    const w = computeBlockWindow(total, { bid: 'b99', ratio: 1 }, ids(total));
    expect(w.endIdx).toBe(total);
    expect(w.endIdx - w.startIdx).toBe(WINDOW_SIZE);
    expect(w.startIdx).toBe(total - WINDOW_SIZE);
    expect(w.hasTail).toBe(false);
    expect(w.hasHead).toBe(true);
  });

  it('文档比窗口还短 → 全量窗口，两端都没有剩余', () => {
    const w = computeBlockWindow(10, { bid: 'b9', ratio: 0 }, ids(10), 64, 12);
    expect(w.startIdx).toBe(0);
    expect(w.endIdx).toBe(10);
    expect(w.hasHead).toBe(false);
    expect(w.hasTail).toBe(false);
  });

  it('空文档 → 全零且两端无剩余', () => {
    const w = computeBlockWindow(0, null, []);
    expect(w).toEqual({ startIdx: 0, endIdx: 0, targetIdx: 0, hasHead: false, hasTail: false });
  });

  it('leadBlocks=0 → 目标块恰为窗口首块', () => {
    const w = computeBlockWindow(500, { bid: 'b100', ratio: 0 }, ids(500), 64, 0);
    expect(w.startIdx).toBe(100);
    expect(w.targetIdx).toBe(100);
    expect(w.hasHead).toBe(true);
  });

  it('目标正好等于 total（越界）→ 视为未命中', () => {
    const w = computeBlockWindow(100, { bid: 'b100', ratio: 0 }, [...ids(100), 'b100']);
    expect(w.targetIdx).toBe(0);
  });
});

describe('chunksForBlockWindow：窗口 → 分片区间', () => {
  /** 每片 24/64/64… 块（与渲染器 FIRST_SCREEN_BLOCKS / LAZY_CHUNK_BLOCKS 同构）。 */
  function chunkedRanges(total: number, first = 24, chunk = 64): ChunkBlockRange[] {
    const out: ChunkBlockRange[] = [];
    let cursor = 0;
    let size = first;
    while (cursor < total) {
      const end = Math.min(total, cursor + size);
      out.push({ startIdx: cursor, endIdx: end });
      cursor = end;
      size = chunk;
    }
    return out;
  }

  it('窗口跨多个分片时取首尾区间', () => {
    const ranges = chunkedRanges(1000);
    const w = computeBlockWindow(1000, { bid: 'b300', ratio: 0 }, ids(1000));
    const span = chunksForBlockWindow(ranges, w);
    expect(span.firstChunk).toBeGreaterThanOrEqual(0);
    expect(span.lastChunk).toBeGreaterThanOrEqual(span.firstChunk);
    // 首片必须覆盖窗口起点所在块
    const first = ranges[span.firstChunk];
    expect(first).toBeDefined();
    expect(first!.startIdx).toBeLessThanOrEqual(w.startIdx);
    expect(first!.endIdx).toBeGreaterThan(w.startIdx);
    // 末片必须覆盖窗口末尾前一块
    const last = ranges[span.lastChunk];
    expect(last).toBeDefined();
    expect(last!.startIdx).toBeLessThan(w.endIdx);
    expect(last!.endIdx).toBeGreaterThanOrEqual(w.endIdx <= 1000 ? w.endIdx - 1 : w.endIdx);
  });

  it('窗口在文档开头 → 从第 0 片开始', () => {
    const ranges = chunkedRanges(500);
    const w = computeBlockWindow(500, null, ids(500));
    const span = chunksForBlockWindow(ranges, w);
    expect(span.firstChunk).toBe(0);
  });

  it('空窗口或空分片 → -1（不挂任何片）', () => {
    const w = computeBlockWindow(0, null, []);
    expect(chunksForBlockWindow([], w)).toEqual({ firstChunk: -1, lastChunk: -1 });
    expect(chunksForBlockWindow([{ startIdx: 0, endIdx: 10 }], w)).toEqual({ firstChunk: -1, lastChunk: -1 });
  });

  it('每片块数汇总等于总块数', () => {
    const ranges = chunkedRanges(1000);
    const sum = ranges.reduce((acc, r) => acc + blocksInRange(r), 0);
    expect(sum).toBe(1000);
  });
});

describe('headBatch / tailBatch', () => {
  it('头游标为 0 时没有可前插的批', () => {
    expect(headBatch(0)).toBeNull();
  });

  it('向上前插严格贴着当前头游标逆序', () => {
    expect(headBatch(100)).toEqual({ startIdx: 100 - HEAD_BATCH_BLOCKS, endIdx: 100 });
    expect(headBatch(10)).toEqual({ startIdx: 0, endIdx: 10 });
  });

  it('尾部追加到文末为止', () => {
    expect(tailBatch(0, 100)).toEqual({ startIdx: 0, endIdx: WINDOW_SIZE });
    expect(tailBatch(90, 100)).toEqual({ startIdx: 90, endIdx: 100 });
    expect(tailBatch(100, 100)).toBeNull();
  });
});

describe('头部前插的零跳动滚动补偿', () => {
  it('容器变高多少就补多少 scrollTop', () => {
    expect(scrollCompensation(5000, 5320)).toBe(320);
    expect(compensatedScrollTop(1200, 320)).toBe(1520);
  });

  it('高度没变或变小 → 不补偿（避免向上跳）', () => {
    expect(scrollCompensation(5000, 5000)).toBe(0);
    expect(scrollCompensation(5000, 4800)).toBe(0);
  });

  it('非法输入不产生 NaN / 负 scrollTop', () => {
    expect(scrollCompensation(Number.NaN, 100)).toBe(0);
    expect(compensatedScrollTop(10, Number.NaN)).toBe(10);
    // 负的 prevScrollTop 在真机上不会出现；这里只保证结果被夹在 >= 0，不产生负数
    expect(compensatedScrollTop(-50, 100)).toBe(50);
    expect(compensatedScrollTop(-500, 100)).toBe(0);
  });

  it('连续前插两批后视口内容位置不变（等价于补偿累积）', () => {
    // 模拟：初始 scrollTop=900，两批各新增 300px 高度
    let top = 900;
    let height = 5000;
    for (let i = 0; i < 2; i++) {
      const nextHeight = height + 300;
      top = compensatedScrollTop(top, scrollCompensation(height, nextHeight));
      height = nextHeight;
    }
    expect(top).toBe(1500);
    // 视口对应的内容位置（top 相对头部插入点）保持恒定
    expect(top - (height - 5000)).toBe(900);
  });
});
