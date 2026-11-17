import { describe, expect, it } from 'vitest';
import {
  applyUpgrade,
  DB_VERSION,
  STORE_SCHEMA,
  storesForVersion,
  type StoreSchema,
  type UpgradeDb,
} from './db';

function storeNames(version: number): string[] {
  return storesForVersion(version).map((store) => store.name);
}

function findStore(version: number, name: string): StoreSchema | undefined {
  return storesForVersion(version).find((store) => store.name === name);
}

interface CreatedIndex {
  readonly name: string;
  readonly keyPath: string | string[];
}

interface CreatedStore {
  readonly name: string;
  readonly keyPath: string | string[];
  readonly indexes: CreatedIndex[];
}

/**
 * 最小假数据库：只实现 applyUpgrade 需要的三个能力，不引任何新依赖。
 *
 * 两个刻意的「尖刺」，让错误迁移当场炸掉而不是悄悄通过：
 *  - createObjectStore 遇到已存在的仓库直接抛错（真实 IndexedDB 同样会抛）；
 *  - 假对象上**没有** deleteObjectStore —— 迁移代码若真去删表会 TypeError。
 *
 * `staleStoreNames: true` 模拟「升级事务中 objectStoreNames 不立即反映新建仓库」
 * 的实现差异，用来证明全新安装不会因为重复建表而中断。
 */
function fakeDb(
  existingStoreNames: readonly string[] = [],
  options: { readonly staleStoreNames?: boolean } = {},
) {
  const names = new Set(existingStoreNames);
  /** staleStoreNames 模式下的可见名字：升级开始时的快照，之后不再更新。 */
  const visibleAtStart = new Set(existingStoreNames);
  const created: CreatedStore[] = [];

  const db: UpgradeDb = {
    objectStoreNames: {
      contains: (name: string) =>
        options.staleStoreNames === true ? visibleAtStart.has(name) : names.has(name),
    },
    createObjectStore: (name, options) => {
      if (names.has(name)) throw new Error(`不能重建已存在的对象仓库: ${name}`);
      names.add(name);
      const record: CreatedStore = { name, keyPath: options.keyPath, indexes: [] };
      created.push(record);
      return {
        createIndex: (indexName, keyPath) => {
          if (record.indexes.some((index) => index.name === indexName)) {
            throw new Error(`不能重复创建索引: ${name}.${indexName}`);
          }
          record.indexes.push({ name: indexName, keyPath });
          return undefined;
        },
      };
    },
  };

  return { db, created, names };
}

describe('STORE_SCHEMA / storesForVersion：v1 与 v2 的仓库描述', () => {
  it('v1 是 docs/marks/tasks/meta 四张表，描述里没有 sessions', () => {
    expect(storeNames(1)).toEqual(['docs', 'marks', 'tasks', 'meta']);
    expect(storeNames(1)).not.toContain('sessions');
    expect(findStore(1, 'sessions')).toBeUndefined();
  });

  it('v2 在 v1 四张表之外只多 sessions，v1 的老表描述逐字段不变', () => {
    expect(storeNames(2)).toEqual(['docs', 'marks', 'tasks', 'meta', 'sessions']);

    // 老表的 keyPath / 索引与 v1 描述完全一致：升级不会重建或改坏它们。
    for (const v1Store of storesForVersion(1)) {
      expect(findStore(2, v1Store.name)).toEqual(v1Store);
    }
  });

  it('sessions：keyPath id，索引 by_started(startedAt)', () => {
    const sessions = findStore(2, 'sessions');
    expect(sessions).toBeDefined();
    expect(sessions?.keyPath).toBe('id');
    expect(sessions?.indexes).toEqual([{ name: 'by_started', keyPath: 'startedAt' }]);
  });

  it('DB_VERSION 是 2，且当前版本要建的表就是 v2 描述', () => {
    expect(DB_VERSION).toBe(2);
    expect(storesForVersion(DB_VERSION)).toEqual(storesForVersion(2));
    expect(Object.keys(STORE_SCHEMA)).toEqual(['1', '2']);
  });

  it('未知版本没有仓库描述（不会凭空建表）', () => {
    expect(storesForVersion(0)).toEqual([]);
    expect(storesForVersion(99)).toEqual([]);
  });
});

describe('applyUpgrade：按描述建表，只补缺失、不删不改已有仓库', () => {
  it('全新安装 0 → v2：按 v1、v2 描述建齐五张表，索引一并建好', () => {
    const { db, created } = fakeDb();
    applyUpgrade(db, 0, 2);

    expect(created.map((store) => store.name)).toEqual(['docs', 'marks', 'tasks', 'meta', 'sessions']);
    // 逐字段与描述比对：keyPath、索引名、索引 keyPath 都必须一致
    expect(created).toEqual(
      storesForVersion(2).map((store) => ({ name: store.name, keyPath: store.keyPath, indexes: store.indexes })),
    );
    const sessions = created.find((store) => store.name === 'sessions');
    expect(sessions?.indexes).toEqual([{ name: 'by_started', keyPath: 'startedAt' }]);
  });

  it('全新安装时不会重复建表 —— 即使 objectStoreNames 不反映刚建好的仓库', () => {
    const { db, created } = fakeDb([], { staleStoreNames: true });
    applyUpgrade(db, 0, 2);
    expect(created.map((store) => store.name)).toEqual(['docs', 'marks', 'tasks', 'meta', 'sessions']);
  });

  it('v1 老库 1 → v2：只补建 sessions，四张老表连碰都不碰（旧数据可读）', () => {
    const { db, created, names } = fakeDb(['docs', 'marks', 'tasks', 'meta']);
    applyUpgrade(db, 1, 2);

    // 只有 sessions 被创建。假对象的 createObjectStore 对已存在仓库会抛错，
    // 所以能走到这里本身就证明迁移没有尝试重建 docs/marks/tasks/meta。
    expect(created.map((store) => store.name)).toEqual(['sessions']);
    expect(created[0]?.keyPath).toBe('id');

    // 升级后五张表都在，老表一个不少
    expect([...names].sort()).toEqual(['docs', 'marks', 'meta', 'sessions', 'tasks']);
    // 迁移用到的假对象没有 deleteObjectStore：真删表的话上面这行之前就已经 TypeError 了
    expect('deleteObjectStore' in db).toBe(false);
  });

  it('已经是 v2 再打开（2 → 2）：什么也不建，幂等', () => {
    const { db, created } = fakeDb(['docs', 'marks', 'tasks', 'meta', 'sessions']);
    applyUpgrade(db, 2, 2);
    expect(created).toEqual([]);
  });

  it('旧库缺过表（只有 docs/marks，oldVersion=1）→ 只补 tasks/meta/sessions', () => {
    const { db, created } = fakeDb(['docs', 'marks']);
    applyUpgrade(db, 1, 2);

    expect(created.map((store) => store.name)).toEqual(['tasks', 'meta', 'sessions']);
    expect(created.find((store) => store.name === 'tasks')?.keyPath).toEqual(['docId', 'bid', 'index']);
  });
});
