/**
 * IndexedDB 仓储 —— 唯一允许碰数据库的地方。
 *
 * 与架构文档的一处务实偏差：设置仍存 localStorage（settings-store.ts）。
 * 原因：设置要在启动第一帧就同步生效，异步打开 DB 会造成一瞬间的字号跳动。
 * 文档 / 标注 / 任务这些"可能很大"的数据放 IndexedDB，设置放 localStorage，
 * 各取所长，不为一条文档里的表格形式牺牲实际体验。
 *
 * 表结构（DB_VERSION = 2）：
 *   docs      keyPath `id`                文档正文与元数据，by_last_read / by_imported
 *   marks     keyPath `id`                标注，by_doc / by_created
 *   tasks     keyPath `[docId,bid,index]` 任务勾选，by_doc
 *   meta      keyPath `key`               迁移标记等
 *   sessions  keyPath `id`                阅读会话，by_started（阶段 C6 统计）
 *
 * 迁移策略（v1 → v2）：升级时**只补建缺失的对象仓库**，从不删除或重建已有仓库，
 * 因此老用户的 docs/marks/tasks/meta 及其数据原样可读。"每个版本该有哪些仓库与索引"
 * 写成本文件下方的纯描述（STORE_SCHEMA / storesForVersion）；onupgradeneeded 只把
 * 这份描述交给 applyUpgrade() 执行。迁移逻辑因此不需要真实 IndexedDB 也能测
 * （见 web/src/data/db-migration.test.ts）。
 *
 * 详细说明见 docs/ARCHITECTURE.md §4.5。
 */

import type { Doc, Mark, ReadingSession, TaskState } from '../core/types';

const DB_NAME = 'mdlego';
/** 数据库结构版本。v1 = docs/marks/tasks/meta；v2 新增 sessions（阅读统计）。 */
export const DB_VERSION = 2;

// ─────────────────────────────────────────────
// 表结构纯描述（迁移的可测事实源）
// ─────────────────────────────────────────────

/** 一个索引的纯描述。 */
export interface IndexSchema {
  readonly name: string;
  /** 索引键路径；复合索引用字符串数组。 */
  readonly keyPath: string | string[];
}

/** 一个对象仓库的纯描述（只描述形状，不含数据）。 */
export interface StoreSchema {
  readonly name: string;
  /** 主键路径；复合主键用字符串数组。 */
  readonly keyPath: string | string[];
  readonly indexes: readonly IndexSchema[];
}

/** v1 的四张业务表。 */
const V1_STORES: readonly StoreSchema[] = [
  {
    name: 'docs',
    keyPath: 'id',
    indexes: [
      { name: 'by_last_read', keyPath: 'lastReadAt' },
      { name: 'by_imported', keyPath: 'importedAt' },
    ],
  },
  {
    name: 'marks',
    keyPath: 'id',
    indexes: [
      { name: 'by_doc', keyPath: 'docId' },
      { name: 'by_created', keyPath: 'createdAt' },
    ],
  },
  {
    name: 'tasks',
    keyPath: ['docId', 'bid', 'index'],
    indexes: [{ name: 'by_doc', keyPath: 'docId' }],
  },
  { name: 'meta', keyPath: 'key', indexes: [] },
];

/**
 * v2 的五张表。
 *
 * 刻意把 v1 的四张表重写一遍（而不是 `...V1_STORES` 复用同一引用）：
 * 这样 db-migration.test.ts 能真的逐字段比对两版描述，谁改坏了 v2 里某张老表的
 * keyPath / 索引，测试就会红 —— 那正是「升级会不会把旧库重建」这个风险点。
 */
const V2_STORES: readonly StoreSchema[] = [
  {
    name: 'docs',
    keyPath: 'id',
    indexes: [
      { name: 'by_last_read', keyPath: 'lastReadAt' },
      { name: 'by_imported', keyPath: 'importedAt' },
    ],
  },
  {
    name: 'marks',
    keyPath: 'id',
    indexes: [
      { name: 'by_doc', keyPath: 'docId' },
      { name: 'by_created', keyPath: 'createdAt' },
    ],
  },
  {
    name: 'tasks',
    keyPath: ['docId', 'bid', 'index'],
    indexes: [{ name: 'by_doc', keyPath: 'docId' }],
  },
  { name: 'meta', keyPath: 'key', indexes: [] },
  {
    name: 'sessions',
    keyPath: 'id',
    indexes: [{ name: 'by_started', keyPath: 'startedAt' }],
  },
];

/**
 * 版本 → 该版本结束时**应当存在**的全部仓库（累进描述，不是增量差异）。
 * 比较两个版本的描述，就能证明「升级只多了一张表」而不是把旧库推倒重建。
 */
export const STORE_SCHEMA: Readonly<Record<number, readonly StoreSchema[]>> = {
  1: V1_STORES,
  2: V2_STORES,
};

/** 取某个数据库版本应有仓库的纯描述；未知版本返回空数组。 */
export function storesForVersion(version: number): readonly StoreSchema[] {
  return STORE_SCHEMA[version] ?? [];
}

// ─────────────────────────────────────────────
// 升级执行（只依赖最小 IDB 能力，方便用假对象测试）
// ─────────────────────────────────────────────

/** `applyUpgrade` 需要的最小对象仓库能力。 */
export interface UpgradeStore {
  createIndex(name: string, keyPath: string | string[]): unknown;
}

/** `applyUpgrade` 需要的最小数据库能力；真实 IDBDatabase 在结构上满足它。 */
export interface UpgradeDb {
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, options: { keyPath: string | string[] }): UpgradeStore;
}

/**
 * 把数据库从 oldVersion 建到 newVersion。
 *
 * 只做一件事：为**缺失**的仓库建表、建索引。已存在的仓库（连同其中的旧数据）
 * 一律不碰 —— 所以 v1 → v2 升级不会丢任何记录，也不会因为重建而触发删除。
 * 全新安装（oldVersion = 0）则按 v1、v2 的描述依次建齐。
 */
export function applyUpgrade(db: UpgradeDb, oldVersion: number, newVersion: number): void {
  // 本次升级里已经确保存在的仓库。不能只靠 db.objectStoreNames 判重：它是否
  // 立即反映升级事务中刚 createObjectStore 出来的仓库，取决于实现细节；
  // 全新安装（0 → 2）会先后按 v1、v2 描述走一遍，靠这个集合保证不重复建表。
  const ensured = new Set<string>();

  for (let version = oldVersion + 1; version <= newVersion; version += 1) {
    for (const store of storesForVersion(version)) {
      if (ensured.has(store.name) || db.objectStoreNames.contains(store.name)) {
        ensured.add(store.name);
        continue;
      }
      const created = db.createObjectStore(store.name, { keyPath: store.keyPath });
      ensured.add(store.name);
      for (const index of store.indexes) created.createIndex(index.name, index.keyPath);
    }
  }
}

// ─────────────────────────────────────────────
// 打开数据库
// ─────────────────────────────────────────────

/** 打开（必要时创建/升级）数据库。多次调用复用同一个 Promise。 */
let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise !== null) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event: IDBVersionChangeEvent) => {
      // 按纯描述建表：只补缺失的仓库，不删除、不重建已有仓库。
      applyUpgrade(req.result, event.oldVersion, DB_VERSION);
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
 * 也刻意保留 sessions：阅读统计是「累计读过」的事实，删文档不该抹掉读过的时长。
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
// sessions（阅读统计；由 main.ts 在关文档时写入）
// ─────────────────────────────────────────────

/** 写入（新增或覆盖）一次阅读会话。 */
export async function putSession(session: ReadingSession): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('sessions', 'readwrite');
  tx.objectStore('sessions').put(session);
  await txDone(tx);
}

/** 读取全部阅读会话（统计要全量算，表只会随阅读次数线性增长）。 */
export async function getAllSessions(): Promise<ReadingSession[]> {
  const db = await openDb();
  const tx = db.transaction('sessions', 'readonly');
  return asPromise(tx.objectStore('sessions').getAll() as IDBRequest<ReadingSession[]>);
}

/** 清空全部阅读会话（调试/测试用）。 */
export async function clearSessions(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('sessions', 'readwrite');
  tx.objectStore('sessions').clear();
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
  const names = ['docs', 'marks', 'tasks', 'meta', 'sessions'];
  const tx = db.transaction(names, 'readwrite');
  for (const name of names) tx.objectStore(name).clear();
  await txDone(tx);
}
