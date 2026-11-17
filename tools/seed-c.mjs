#!/usr/bin/env node
/**
 * 阶段 C 验收 —— 往页面里的 IndexedDB 写夹具数据。
 *
 * 边界：
 *   · 只在页面上下文里用原生 IndexedDB API，不 import web/src 的任何模块
 *     （构建产物是打包后的代码，浏览器里拿不到源码模块）。
 *   · 打开数据库时不带版本号，沿用应用已经建好的结构；
 *     若应用还没建库，本函数会明确报错，而不是自己造一套可能对不上的 schema。
 *   · `sessions` 表是阶段 C6（统计）才需要的：存在就写 7 天阅读会话，不存在就静默跳过，
 *     这样脚本在 C6 落地前也能跑，落地后不用改 seed 逻辑。
 */
import { FIXTURE_DOCS } from './fixtures/docs.mjs';

/** 7 天会话的时长范围（毫秒）：4~34 分钟，看起来像真实阅读。 */
const SESSION_MS_MIN = 4 * 60_000;
const SESSION_MS_STEP = 3 * 60_000;
const SESSION_MS_STEPS = 11;

const DAY = 86_400_000;

/**
 * 生成 7 天阅读会话。
 *
 * 每天两段：早上 8:10 左右一段、晚上 21:30 左右一段；文档在夹具里轮转。
 * 只在 `sessions` 表存在时才会被写入。
 *
 * @param {readonly string[]} docIds 夹具文档 id
 * @param {number} now 当前时间（毫秒）
 * @returns {Array<{id: string, docId: string, startedAt: number, endedAt: number, ms: number}>}
 */
export function buildReadingSessions(docIds, now = Date.now()) {
  if (docIds.length === 0) return [];
  const sessions = [];
  // 以「今天 0 点」为锚，避免跨天边界导致某些天没有记录
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const dayStart = today.getTime();

  for (let day = 0; day < 7; day++) {
    const base = dayStart - day * DAY;
    const slots = [
      { hour: 8, minute: 10 + (day % 5) * 3 },
      { hour: 21, minute: 30 + (day % 7) * 2 },
    ];
    for (let slot = 0; slot < slots.length; slot++) {
      const { hour, minute } = slots[slot];
      const startedAt = base + hour * 3_600_000 + minute * 60_000;
      // 固定算式而不是随机：每次运行的数据完全一致，便于对比截图
      const ms =
        SESSION_MS_MIN + ((day * 7 + slot * 5) % SESSION_MS_STEPS) * SESSION_MS_STEP;
      // 只保留已经结束的会话，避免今天还没到的时段留下未来时间戳
      if (startedAt + ms > now) continue;
      sessions.push({
        id: `fixture-session-d${day}-s${slot}`,
        docId: docIds[(day + slot) % docIds.length],
        startedAt,
        endedAt: startedAt + ms,
        ms,
      });
    }
  }
  return sessions;
}

/**
 * 把夹具文档写入页面的 IndexedDB。
 *
 * 调用前页面必须已经启动过一次（应用建好 `mdlego` 库）。
 *
 * @param {{send: (method: string, params?: object, sessionId?: string) => Promise<unknown>}} cdp CDP 客户端
 * @param {string} sid CDP 会话 id
 * @param {ReadonlyArray<object>} [docs] 夹具文档（字段见 web/src/core/types.ts Doc）
 * @returns {Promise<{docs: number, sessions: number, hadSessionsStore: boolean, sessionsError: string|null}>}
 */
export async function seedDocs(cdp, sid, docs = FIXTURE_DOCS) {
  const docIds = docs.map((d) => d.id);
  const sessions = buildReadingSessions(docIds);

  const expression = `(async () => {
    const DOCS = ${JSON.stringify(docs)};
    const SESSIONS = ${JSON.stringify(sessions)};

    const openDatabase = () => new Promise((resolve, reject) => {
      const req = indexedDB.open('mdlego'); // 不带版本号：沿用应用已建好的结构
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('打开 mdlego 失败'));
      req.onblocked = () => reject(new Error('数据库被占用'));
    });

    const txDone = (tx) => new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('事务失败'));
      tx.onabort = () => reject(tx.error ?? new Error('事务被中止'));
    });

    const db = await openDatabase();
    try {
      if (!db.objectStoreNames.contains('docs')) {
        throw new Error('docs 表不存在：应用还没建库，或表名变了');
      }

      // 文档：一个事务写完，保证 reload 时要么全在要么全不在
      const docsTx = db.transaction('docs', 'readwrite');
      const store = docsTx.objectStore('docs');
      for (const doc of DOCS) store.put(doc);
      await txDone(docsTx);

      // 会话：仅当应用已经建了 sessions 表（C6 统计）才写
      const hadSessionsStore = db.objectStoreNames.contains('sessions');
      let wroteSessions = 0;
      let sessionsError = null;
      if (hadSessionsStore) {
        try {
          const sessionsTx = db.transaction('sessions', 'readwrite');
          const sessionsStore = sessionsTx.objectStore('sessions');
          for (const session of SESSIONS) sessionsStore.put(session);
          await txDone(sessionsTx);
          wroteSessions = SESSIONS.length;
        } catch (error) {
          sessionsError = error instanceof Error ? error.message : String(error);
        }
      }

      return {
        docs: DOCS.length,
        sessions: wroteSessions,
        hadSessionsStore,
        sessionsError,
      };
    } finally {
      db.close();
    }
  })()`;

  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sid,
  );
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`写入夹具失败：${detail}`);
  }
  return result.result.value;
}
