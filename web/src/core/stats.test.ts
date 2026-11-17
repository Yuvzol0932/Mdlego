import { describe, expect, it } from 'vitest';
import { computeStats } from './stats';
import type { DailyReading, Doc, ReadingSession } from './types';

const MIN = 60_000;

/**
 * 测试时间**全部**用「本地年月日时分」构造，不读系统时钟、也不依赖运行机器的时区：
 *   - `now` 是 computeStats 的入参，不用 `Date.now()`；
 *   - 构造与断言都走本地日期分量，被测实现同样按本地时区归日，
 *     所以无论 TZ=UTC 还是 Asia/Shanghai，`2026-06-15` 就是本地 2026-06-15。
 */
function localTs(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

/** 独立于实现的日期格式化，用来断言 week 的 day 标签。 */
function dayLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function session(id: string, docId: string, startedAt: number, endedAt: number, ms?: number): ReadingSession {
  return { id, docId, startedAt, endedAt, ms: ms ?? Math.max(0, endedAt - startedAt) };
}

function doc(id: string, title: string): Doc {
  return {
    id,
    title,
    text: '',
    encoding: 'utf-8',
    source: { kind: 'inline' },
    fingerprint: null,
    importedAt: 0,
    lastReadAt: null,
    progress: null,
  };
}

/** 越界时直接抛错，避免 noUncheckedIndexedAccess 下的 `week[i]!`。 */
function weekDay(week: readonly DailyReading[], index: number): DailyReading {
  const entry = week[index];
  if (entry === undefined) throw new Error(`week[${index}] 不存在`);
  return entry;
}

/** 固定的「今天」：2026-06-15（周一）中午。 */
const NOW = localTs(2026, 6, 15, 12);

/** 相对今天偏移 offset 天、当地 10:00 开始的 10 分钟阅读。 */
function readOn(offset: number, docId = 'a'): ReadingSession {
  const start = localTs(2026, 6, 15 + offset, 10);
  return session(`s${offset}`, docId, start, start + 10 * MIN);
}

describe('computeStats：没有任何记录时不伪造数据', () => {
  it('空会话 → 全零快照，week 仍是 7 条、旧 → 新、最后一条是今天', () => {
    const stats = computeStats([], [], NOW);

    expect(stats.todayMs).toBe(0);
    expect(stats.streakDays).toBe(0);
    expect(stats.docCount).toBe(0);
    expect(stats.recent).toEqual([]);

    expect(stats.week).toHaveLength(7);
    expect(stats.week.map((entry) => entry.day)).toEqual([
      '2026-06-09',
      '2026-06-10',
      '2026-06-11',
      '2026-06-12',
      '2026-06-13',
      '2026-06-14',
      '2026-06-15',
    ]);
    expect(stats.week.every((entry) => entry.ms === 0)).toBe(true);
  });

  it('有文档但从未读过 → docCount 0，不拿书架文档数量冒充阅读量', () => {
    const docs = [doc('a', '文档 A'), doc('b', '文档 B'), doc('c', '文档 C')];
    const stats = computeStats([], docs, NOW);

    expect(stats.docCount).toBe(0);
    expect(stats.todayMs).toBe(0);
    expect(stats.recent).toEqual([]);
  });

  it('不读系统时钟：同一条会话换个 now，统计跟着挪', () => {
    const sessions = [readOn(0)];
    const docs = [doc('a', '文档 A')];

    expect(computeStats(sessions, docs, NOW).todayMs).toBe(10 * MIN);

    // 把「现在」挪到明天：这条会话变成昨天的记录，今日归零。
    const tomorrow = computeStats(sessions, docs, localTs(2026, 6, 16, 12));
    expect(tomorrow.todayMs).toBe(0);
    expect(weekDay(tomorrow.week, 5).ms).toBe(10 * MIN);
  });

  it('同一输入两次调用结果完全一致（纯函数）', () => {
    const sessions = [readOn(0), readOn(-1), session('sx', 'a', localTs(2026, 6, 9, 9), localTs(2026, 6, 9, 9, 10))];
    const docs = [doc('a', '文档 A')];
    expect(computeStats(sessions, docs, NOW)).toEqual(computeStats(sessions, docs, NOW));
  });
});

describe('computeStats：今日时长与周内归日', () => {
  it('今日多段会话求和', () => {
    const sessions = [
      session('morning', 'a', localTs(2026, 6, 15, 8), localTs(2026, 6, 15, 8, 5), 5 * MIN),
      session('night', 'a', localTs(2026, 6, 15, 20), localTs(2026, 6, 15, 20, 25), 25 * MIN),
      // 昨天的不该混进今日
      session('yesterday', 'a', localTs(2026, 6, 14, 20), localTs(2026, 6, 14, 20, 30), 30 * MIN),
    ];
    const stats = computeStats(sessions, [doc('a', '文档 A')], NOW);

    expect(stats.todayMs).toBe(30 * MIN);
    expect(weekDay(stats.week, 6).ms).toBe(30 * MIN);
    expect(weekDay(stats.week, 5).ms).toBe(30 * MIN);
    expect(weekDay(stats.week, 6).day).toBe(dayLabel(NOW));
  });

  it('跨两天分别计入各自那一天', () => {
    const sessions = [
      session('d1', 'a', localTs(2026, 6, 14, 10), localTs(2026, 6, 14, 10, 10), 10 * MIN),
      session('d2', 'a', localTs(2026, 6, 15, 10), localTs(2026, 6, 15, 10, 20), 20 * MIN),
    ];
    const stats = computeStats(sessions, [doc('a', '文档 A')], NOW);

    expect(weekDay(stats.week, 5).ms).toBe(10 * MIN);
    expect(weekDay(stats.week, 6).ms).toBe(20 * MIN);
    expect(stats.todayMs).toBe(20 * MIN);
    expect(stats.week.slice(0, 5).every((entry) => entry.ms === 0)).toBe(true);
  });

  it('周界：今天-6 计入 week[0]，今天-7（第 8 天）不计入任何一天', () => {
    const sessions = [
      session('edge-in', 'a', localTs(2026, 6, 9, 12), localTs(2026, 6, 9, 12, 10), 10 * MIN),
      session('edge-out', 'a', localTs(2026, 6, 8, 12), localTs(2026, 6, 8, 12, 10), 10 * MIN),
    ];
    const stats = computeStats(sessions, [doc('a', '文档 A')], NOW);

    expect(weekDay(stats.week, 0).day).toBe('2026-06-09');
    expect(weekDay(stats.week, 0).ms).toBe(10 * MIN);
    // 8 天前的那条只存在于 activeDays（连续天数里也只是断档），不进周图
    expect(stats.week.reduce((sum, entry) => sum + entry.ms, 0)).toBe(10 * MIN);
    expect(stats.todayMs).toBe(0);
  });

  it('跨午夜会话整段归到 startedAt 那天，不算进今天', () => {
    const sessions = [
      session(
        'midnight',
        'a',
        localTs(2026, 6, 14, 23, 50),
        localTs(2026, 6, 15, 0, 10),
        20 * MIN,
      ),
    ];
    const stats = computeStats(sessions, [doc('a', '文档 A')], NOW);

    expect(weekDay(stats.week, 5).ms).toBe(20 * MIN);
    expect(weekDay(stats.week, 6).ms).toBe(0);
    expect(stats.todayMs).toBe(0);
    // 今天没记录、昨天有 → 连续天数从昨天算起
    expect(stats.streakDays).toBe(1);
  });

  it('周标签跨月/跨年仍然连续', () => {
    const now = localTs(2026, 1, 2, 12); // 2026-01-02
    const sessions = [
      session('newyear', 'a', localTs(2025, 12, 31, 23), localTs(2026, 1, 1, 0, 30), 30 * MIN),
    ];
    const stats = computeStats(sessions, [doc('a', '文档 A')], now);

    expect(stats.week.map((entry) => entry.day)).toEqual([
      '2025-12-27',
      '2025-12-28',
      '2025-12-29',
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
    ]);
    // 跨年会话按 startedAt 归到 2025-12-31（week[4]）
    expect(weekDay(stats.week, 4).ms).toBe(30 * MIN);
    expect(stats.todayMs).toBe(0);
  });
});

describe('computeStats：连续阅读天数', () => {
  const docs = [doc('a', '文档 A')];

  it('今天读了 → 从今天往前数', () => {
    const stats = computeStats([readOn(0), readOn(-1), readOn(-2)], docs, NOW);
    expect(stats.streakDays).toBe(3);
  });

  it('今天还没读 → 从昨天往前数（今天没结束，不该判死刑）', () => {
    const stats = computeStats([readOn(-1), readOn(-2)], docs, NOW);
    expect(stats.streakDays).toBe(2);
  });

  it('中间断档 → 只数到断口', () => {
    // 今天读了，前天也读了，昨天断档 → 只算今天 1 天
    expect(computeStats([readOn(0), readOn(-2)], docs, NOW).streakDays).toBe(1);
    // 昨天、前天、大前天连续，今天没读 → 3 天
    expect(computeStats([readOn(-1), readOn(-2), readOn(-3)], docs, NOW).streakDays).toBe(3);
  });

  it('只有很久以前读过、今天昨天都没读 → 0', () => {
    expect(computeStats([readOn(-10)], docs, NOW).streakDays).toBe(0);
    expect(computeStats([], docs, NOW).streakDays).toBe(0);
  });

  it('一天里多段会话只算一天', () => {
    const extra = session(
      'second',
      'a',
      localTs(2026, 6, 15, 21),
      localTs(2026, 6, 15, 21, 5),
      5 * MIN,
    );
    const stats = computeStats([readOn(0), extra, readOn(-1)], docs, NOW);
    expect(stats.streakDays).toBe(2);
  });
});

describe('computeStats：累计文档数 docCount', () => {
  it('按不同的 docId 计数，不看会话条数', () => {
    const sessions = [
      session('1', 'a', localTs(2026, 6, 13, 9), localTs(2026, 6, 13, 9, 10)),
      session('2', 'a', localTs(2026, 6, 14, 9), localTs(2026, 6, 14, 9, 10)),
      session('3', 'b', localTs(2026, 6, 15, 9), localTs(2026, 6, 15, 9, 10)),
    ];
    const stats = computeStats(sessions, [doc('a', '文档 A'), doc('b', '文档 B')], NOW);
    expect(stats.docCount).toBe(2);
  });

  it('累计语义：文档被删掉后，读过的历史仍然计数', () => {
    const sessions = [
      session('1', 'a', localTs(2026, 6, 14, 9), localTs(2026, 6, 14, 9, 10)),
      session('2', 'deleted', localTs(2026, 6, 14, 10), localTs(2026, 6, 14, 10, 10)),
    ];
    const stats = computeStats(sessions, [doc('a', '文档 A')], NOW);
    expect(stats.docCount).toBe(2);
  });
});

describe('computeStats：最近读过 recent', () => {
  const docs = [doc('a', '文档 A'), doc('b', '文档 B'), doc('c', '文档 C')];

  it('按最近一次会话结束时刻倒序，每个 docId 只出现一次', () => {
    const sessions = [
      session('a-old', 'a', localTs(2026, 6, 10, 9), localTs(2026, 6, 10, 9, 30)),
      session('b', 'b', localTs(2026, 6, 13, 9), localTs(2026, 6, 13, 9, 30)),
      session('a-new', 'a', localTs(2026, 6, 15, 9), localTs(2026, 6, 15, 9, 40)),
      session('c', 'c', localTs(2026, 6, 15, 8), localTs(2026, 6, 15, 8, 20)),
    ];
    const stats = computeStats(sessions, docs, NOW);

    expect(stats.recent.map((entry) => entry.docId)).toEqual(['a', 'c', 'b']);
    // lastReadAt 取该文档最近一次会话的结束时刻（而不是开始时刻）
    expect(stats.recent[0]).toEqual({
      docId: 'a',
      title: '文档 A',
      lastReadAt: localTs(2026, 6, 15, 9, 40),
    });
  });

  it('已删除的文档跳过，但它的会话仍算进 docCount', () => {
    const sessions = [
      session('gone', 'deleted-doc', localTs(2026, 6, 15, 10), localTs(2026, 6, 15, 10, 10)),
      session('a', 'a', localTs(2026, 6, 15, 9), localTs(2026, 6, 15, 9, 10)),
    ];
    const stats = computeStats(sessions, docs, NOW);

    expect(stats.recent.map((entry) => entry.docId)).toEqual(['a']);
    expect(stats.docCount).toBe(2);
  });

  it('最多 5 条，最近的排前面', () => {
    const six = [doc('a', '文档 A'), doc('b', '文档 B'), doc('c', '文档 C'), doc('d', '文档 D'), doc('e', '文档 E'), doc('f', '文档 F')];
    // a 最晚、f 最早
    const sessions = six.map((entry, index) =>
      session(
        `s-${entry.id}`,
        entry.id,
        localTs(2026, 6, 15, 10 - index),
        localTs(2026, 6, 15, 10 - index, 30),
      ),
    );
    const stats = computeStats(sessions, six, NOW);

    expect(stats.recent).toHaveLength(5);
    expect(stats.recent.map((entry) => entry.docId)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(stats.docCount).toBe(6);
  });

  it('会话都在、但对应文档全被删 → recent 为空数组，其它数字照算', () => {
    const sessions = [
      session('1', 'gone', localTs(2026, 6, 15, 9), localTs(2026, 6, 15, 9, 10), 10 * MIN),
    ];
    const stats = computeStats(sessions, [], NOW);

    expect(stats.recent).toEqual([]);
    expect(stats.todayMs).toBe(10 * MIN);
    expect(stats.docCount).toBe(1);
  });

  it('连续天数为 0 时 recent 仍然按时间倒序（两件事互不影响）', () => {
    const old = session('old', 'a', localTs(2026, 6, 1, 9), localTs(2026, 6, 1, 9, 10));
    const stats = computeStats([old], docs, NOW);
    expect(stats.streakDays).toBe(0);
    expect(stats.recent.map((entry) => entry.docId)).toEqual(['a']);
  });
});
