/**
 * 阅读统计 —— 纯函数，零副作用。
 *
 * 两条硬约束：
 *  1. **不读 `Date.now()`**：当前时刻由调用方作为 `now` 传入。同一份会话 +
 *     同一个 now 必然得到同一个快照，测试才可能用固定时间戳构造。
 *  2. **一律按本地时区归日**：用户心里的「今天」是手机上的今天。`DailyReading.day`
 *     是本地日期 `YYYY-MM-DD`，不是 UTC 日期 —— 否则东八区凌晨读的书会算到前一天。
 *
 * 归日规则：一次会话整段归属到 `startedAt` 所在的本地日（跨午夜的会话算在开始那天）。
 * 这条规则简单、可解释，也让「今天时长」不会因为用户读到 0 点而把半夜那段挪走。
 *
 * 数据诚实原则：没有任何会话就返回全零快照，**绝不拿文档数量冒充阅读量**
 * （docCount 也明确是「有会话记录的 docId 数」，而不是书架里的文档总数）。
 */

import type { DailyReading, Doc, ReadingSession, RecentDoc, StatsSnapshot } from './types';

/** 一周天数（含今天）。 */
const WEEK_DAYS = 7;

/** 「最近读过」列表上限。 */
const RECENT_LIMIT = 5;

/** 本地日期 `YYYY-MM-DD`。 */
function dayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 相对 `now` 偏移 offset 天的本地零点时间戳（offset 为负表示往前）。
 * 用「年月日分量」平移，而不是 `± offset * 86400000` —— 后者在有夏令时的时区会
 * 落到前一天的 23:00 或后一天的 01:00，日期就错了。
 */
function dayStart(now: number, offset: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset).getTime();
}

/**
 * 从会话与文档算出统计快照。
 *
 * @param sessions 全部阅读会话（顺序无关）
 * @param docs     当前书架里的文档（用于「最近读过」取标题；已删除的文档会被跳过）
 * @param now      当前时刻（毫秒）。由调用方传入，本函数不读系统时钟。
 */
export function computeStats(
  sessions: readonly ReadingSession[],
  docs: readonly Doc[],
  now: number,
): StatsSnapshot {
  // 最近 7 天的本地日期（旧 → 新，最后一条是今天）与按日累计的时长。
  const weekDays: string[] = [];
  const indexByDay = new Map<string, number>();
  for (let offset = -(WEEK_DAYS - 1); offset <= 0; offset += 1) {
    const key = dayKey(dayStart(now, offset));
    indexByDay.set(key, weekDays.length);
    weekDays.push(key);
  }
  const weekMs: number[] = weekDays.map(() => 0);

  /** 有会话的本地日（连续天数用）。 */
  const activeDays = new Set<string>();
  /** 有会话 docId（docCount 用；不同 docId 去重）。 */
  const docIds = new Set<string>();
  /** docId → 该文档最近一次会话结束时刻（「最近读过」的 lastReadAt）。 */
  const lastReadByDoc = new Map<string, number>();

  for (const session of sessions) {
    const startedDay = dayKey(session.startedAt);
    activeDays.add(startedDay);

    docIds.add(session.docId);
    // 最近读过的排序键取**结束时刻**：Doc.lastReadAt 的语义是「最后阅读时刻」，
    // 而会话结束才是用户真正合上这篇文档的时刻。
    const previous = lastReadByDoc.get(session.docId);
    if (previous === undefined || session.endedAt > previous) {
      lastReadByDoc.set(session.docId, session.endedAt);
    }

    // 跨天会话整段算在 startedAt 那天（见文件头注释）。
    const index = indexByDay.get(startedDay);
    if (index !== undefined) weekMs[index] = (weekMs[index] ?? 0) + session.ms;
  }

  const week: readonly DailyReading[] = weekDays.map((day, index) => ({
    day,
    ms: weekMs[index] ?? 0,
  }));

  const todayMs = weekMs[WEEK_DAYS - 1] ?? 0;
  const todayKey = weekDays[WEEK_DAYS - 1] ?? dayKey(now);

  return {
    todayMs,
    streakDays: computeStreakDays(activeDays, todayKey, now),
    docCount: docIds.size,
    week,
    recent: computeRecent(lastReadByDoc, docs),
  };
}

/**
 * 连续有阅读记录的天数。
 * 今天读过就从今天往前数；今天没读就从昨天往前数（今天还没结束，不该先判死刑）。
 * 都为零天返回 0。
 */
function computeStreakDays(activeDays: ReadonlySet<string>, todayKey: string, now: number): number {
  // 今天没读则从昨天开始数；昨天也没读时循环第一次就不成立，结果自然是 0。
  let offset = activeDays.has(todayKey) ? 0 : -1;
  let streak = 0;
  // activeDays 是有限集合，循环最多走「有记录的天数」次，必然终止。
  while (activeDays.has(dayKey(dayStart(now, offset)))) {
    streak += 1;
    offset -= 1;
  }
  return streak;
}

/**
 * 最近读过的文档：按最近会话结束时刻倒序、docId 去重、最多 5 条；
 * 只保留当前书架里还存在的文档（已删除的跳过）。
 */
function computeRecent(
  lastReadByDoc: ReadonlyMap<string, number>,
  docs: readonly Doc[],
): readonly RecentDoc[] {
  const docById = new Map<string, Doc>();
  for (const doc of docs) docById.set(doc.id, doc);

  const recent: RecentDoc[] = [];
  for (const [docId, lastReadAt] of lastReadByDoc) {
    const doc = docById.get(docId);
    if (doc === undefined) continue;
    recent.push({ docId, title: doc.title, lastReadAt });
  }

  // endedAt 相同时按 docId 排，保证输出稳定（纯函数不能靠 Map 插入顺序碰运气）。
  recent.sort((a, b) => b.lastReadAt - a.lastReadAt || compareText(a.docId, b.docId));
  return recent.slice(0, RECENT_LIMIT);
}

/** 字符串比较（不依赖 locale，保证跨环境结果一致）。 */
function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
