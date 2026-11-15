/**
 * IndexedDB 仓储 —— 唯一允许碰数据库的地方。
 *
 * 与架构文档的一处务实偏差：设置仍存 localStorage（settings-store.ts）。
 * 原因：设置要在启动第一帧就同步生效，异步打开 DB 会造成一瞬间的字号跳动。
 * 文档 / 标注 / 任务这些"可能很大"的数据放 IndexedDB，设置放 localStorage，
 * 各取所长，不为一条文档里的表格形式牺牲实际体验。
 *
 * 表结构见 docs/ARCHITECTURE.md §4.5。
 */

import type { Doc, Mark, TaskState } from '../core/types';

const DB_NAME = 'mdlego';
const DB_VERSION = 1;

/** 打开（必要时创建/升级）数据库。多次调用复用同一个 Promise。 */
let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise !== null) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains('docs')) {
        const docs = db.createObjectStore('docs', { keyPath: 'id' });
        docs.createIndex('by_last_read', 'lastReadAt');
        docs.createIndex('by_imported', 'importedAt');
      }

      if (!db.objectStoreNames.contains('marks')) {
        const marks = db.createObjectStore('marks', { keyPath: 'id' });
        marks.createIndex('by_doc', 'docId');
        marks.createIndex('by_created', 'createdAt');
      }

      if (!db.objectStoreNames.contains('tasks')) {
        const tasks = db.createObjectStore('tasks', { keyPath: ['docId', 'bid', 'index'] });
        tasks.createIndex('by_doc', 'docId');
      }

      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('无法打开数据库'));
    req.onblocked = () => reject(new Error('数据库被其他标签页占用，请关闭后重试'));
  }).catch((error: unknown) => {
    // 失败时清缓存，允许下次重试，而不是永久卡在一个坏 Promise 上
    dbPromise = null;
    throw error;
  });

  return dbPromise;
}

/** 把 IDBRequest 包装成 Promise。 */
function asPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('数据库操作失败'));
  });
}

/** 等待一个事务完成（比单独等 request 更可靠）。 */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('事务被中止'));
  });
}

// ─────────────────────────────────────────────
// docs
// ─────────────────────────────────────────────

/** 读取全部文档。 */
export async function getAllDocs(): Promise<Doc[]> {
  const db = await openDb();
  const tx = db.transaction('docs', 'readonly');
  const req = tx.objectStore('docs').getAll() as IDBRequest<Doc[]>;
  return asPromise(req);
}

/** 写入（新增或覆盖）一篇文档。 */
export async function putDoc(doc: Doc): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('docs', 'readwrite');
  tx.objectStore('docs').put(doc);
  await txDone(tx);
}

/** 批量写入文档（一个事务，避免逐条提交）。 */
export async function putDocs(docs: readonly Doc[]): Promise<void> {
  if (docs.length === 0) return;
  const db = await openDb();
  const tx = db.transaction('docs', 'readwrite');
  const store = tx.objectStore('docs');
  for (const doc of docs) store.put(doc);
  await txDone(tx);
}

/**
 * 删除书架条目及其标注与任务。
 * 刻意不碰外部原文件 —— 误删也能从原文件重新导入。
 */
export async function deleteDoc(docId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['docs', 'marks', 'tasks'], 'readwrite');
  tx.objectStore('docs').delete(docId);

  const markIndex = tx.objectStore('marks').index('by_doc');
  const markKeys = await asPromise(markIndex.getAllKeys(IDBKeyRange.only(docId)));
  for (const key of markKeys) tx.objectStore('marks').delete(key);

  const taskIndex = tx.objectStore('tasks').index('by_doc');
  const taskKeys = await asPromise(taskIndex.getAllKeys(IDBKeyRange.only(docId)));
  for (const key of taskKeys) tx.objectStore('tasks').delete(key);

  await txDone(tx);
}

// ─────────────────────────────────────────────
// marks
// ─────────────────────────────────────────────

/** 读取全部标注。M2 阶段文档量小，一次载入比按 doc 查询更简单可靠。 */
export async function getAllMarks(): Promise<Mark[]> {
  const db = await openDb();
  const tx = db.transaction('marks', 'readonly');
  return asPromise(tx.objectStore('marks').getAll() as IDBRequest<Mark[]>);
}

export async function putMark(mark: Mark): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('marks', 'readwrite');
  tx.objectStore('marks').put(mark);
  await txDone(tx);
}

export async function deleteMark(markId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('marks', 'readwrite');
  tx.objectStore('marks').delete(markId);
  await txDone(tx);
}

// ─────────────────────────────────────────────
// tasks
// ─────────────────────────────────────────────

export async function getAllTasks(): Promise<TaskState[]> {
  const db = await openDb();
  const tx = db.transaction('tasks', 'readonly');
  return asPromise(tx.objectStore('tasks').getAll() as IDBRequest<TaskState[]>);
}

export async function putTask(task: TaskState): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('tasks', 'readwrite');
  tx.objectStore('tasks').put(task);
  await txDone(tx);
}

// ─────────────────────────────────────────────
// meta（迁移标记等）
// ─────────────────────────────────────────────

export async function getMeta(key: string): Promise<unknown> {
  const db = await openDb();
  const tx = db.transaction('meta', 'readonly');
  const row = await asPromise(tx.objectStore('meta').get(key) as IDBRequest<{ key: string; value: unknown } | undefined>);
  return row?.value;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  await txDone(tx);
}

/** 仅供测试：清空全部业务表。 */
export async function __clearAll(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['docs', 'marks', 'tasks', 'meta'], 'readwrite');
  for (const name of ['docs', 'marks', 'tasks', 'meta']) tx.objectStore(name).clear();
  await txDone(tx);
}
