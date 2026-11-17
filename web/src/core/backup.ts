/**
 * 备份文件的构造与校验（阶段 E3，纯函数）。
 *
 * 设计要点：
 *   - **自描述**：format + schemaVersion + appVersion + exportedAt，缺一不可；
 *   - **可校验**：checksum 覆盖 data 的规范 JSON（数组按 id 排序、键序固定），
 *     解包时重算并比对，损坏/手改能明确拒绝，而不是把半份数据写进本机；
 *   - **向前兼容**：schemaVersion 大于当前版本 → 明确提示「备份来自更新版本」，
 *     绝不做猜测式迁移；
 *   - 生词本（E4）当前还不存在：**不写空占位**，等数据结构落地后在 schemaVersion 2 里加。
 *
 * 本模块零 IO、零 DOM，可在 node 里直接测。
 */

import type { Doc, Mark, ReadingSession, Settings, TaskState } from './types';

/** 备份格式标识（写进文件，解析时校验）。 */
export const BACKUP_FORMAT = 'mdlego-backup';

/** 当前备份 schema 版本。加字段/改结构必须升版本并补迁移。 */
export const BACKUP_SCHEMA_VERSION = 1;

/** 备份里的业务数据。 */
export interface BackupData {
  readonly docs: readonly Doc[];
  readonly marks: readonly Mark[];
  readonly tasks: readonly TaskState[];
  readonly sessions: readonly ReadingSession[];
  readonly settings: Settings;
  readonly bookmarks: readonly string[];
}

/** 备份文件结构。 */
export interface BackupFile {
  readonly format: typeof BACKUP_FORMAT;
  readonly schemaVersion: number;
  readonly appVersion: string;
  readonly exportedAt: string;
  readonly checksum: string;
  readonly data: BackupData;
}

export interface BuildBackupOptions {
  readonly appVersion: string;
  /** ISO 时间串；测试可注入固定值。 */
  readonly exportedAt: string;
}

export interface BackupSummary {
  readonly docs: number;
  readonly marks: number;
  readonly tasks: number;
  readonly sessions: number;
  readonly bookmarks: number;
}

export type ParseBackupResult =
  | { readonly ok: true; readonly file: BackupFile; readonly summary: BackupSummary }
  | { readonly ok: false; readonly reason: string };

/** FNV-1a 32 位哈希：足够发现损坏/手改，且同步、无依赖。 */
export function checksumOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`;
}

/** 按 key 稳定排序（不改输入）。任务没有 id，用 docId+bid+index 做键。 */
function sortBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * 规范化数据：数组按 id 排序，保证同一份数据导出的字节稳定（便于 diff 与校验）。
 * settings 保持对象引用（JSON.stringify 的键序在解析回来时保持）。
 */
export function canonicalData(data: BackupData): BackupData {
  return {
    docs: sortBy(data.docs, (doc) => doc.id),
    marks: sortBy(data.marks, (mark) => mark.id),
    tasks: sortBy(data.tasks, (task) => `${task.docId}|${task.bid}|${String(task.index).padStart(4, '0')}`),
    sessions: sortBy(data.sessions, (session) => session.id),
    settings: data.settings,
    bookmarks: [...data.bookmarks].sort(),
  };
}

/** 生成备份文件（字符串，含校验和）。 */
export function buildBackup(data: BackupData, options: BuildBackupOptions): string {
  const canonical = canonicalData(data);
  const checksum = checksumOf(JSON.stringify(canonical));
  const file: BackupFile = {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion: options.appVersion,
    exportedAt: options.exportedAt,
    checksum,
    data: canonical,
  };
  return JSON.stringify(file, null, 2);
}

/** 统计一份备份里各数据的条数（恢复前给用户看）。 */
export function summarizeBackup(data: BackupData): BackupSummary {
  return {
    docs: data.docs.length,
    marks: data.marks.length,
    tasks: data.tasks.length,
    sessions: data.sessions.length,
    bookmarks: data.bookmarks.length,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArrayOf(value: unknown, key: string): value is readonly Record<string, unknown>[] {
  return Array.isArray(value) && value.every((item) => isRecord(item) && typeof item[key] === 'string');
}

/**
 * 解析并校验备份文本。失败必须给出人能看懂的原因，调用方直接 toast。
 * 校验顺序：JSON → format → schemaVersion → checksum → 基本结构。
 */
export function parseBackup(text: string): ParseBackupResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: '备份内容为空' };

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: '不是有效的 JSON，可能复制不完整' };
  }
  if (!isRecord(raw)) return { ok: false, reason: '备份格式不正确' };
  if (raw['format'] !== BACKUP_FORMAT) {
    return { ok: false, reason: '不是墨读的备份文件' };
  }
  const version = raw['schemaVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, reason: '备份缺少有效的版本号' };
  }
  if (version > BACKUP_SCHEMA_VERSION) {
    return { ok: false, reason: `备份来自更新版本的墨读（v${version}），请先升级应用` };
  }
  if (typeof raw['checksum'] !== 'string') return { ok: false, reason: '备份缺少校验和' };

  const data = raw['data'];
  if (!isRecord(data)) return { ok: false, reason: '备份缺少数据内容' };
  if (!isArrayOf(data['docs'], 'id')) return { ok: false, reason: '备份里的文档列表损坏' };
  if (!isArrayOf(data['marks'], 'id')) return { ok: false, reason: '备份里的批注列表损坏' };
  if (!Array.isArray(data['tasks'])) return { ok: false, reason: '备份里的任务列表损坏' };
  if (!Array.isArray(data['sessions'])) return { ok: false, reason: '备份里的阅读记录损坏' };
  if (!Array.isArray(data['bookmarks'])) return { ok: false, reason: '备份里的收藏列表损坏' };
  if (!isRecord(data['settings'])) return { ok: false, reason: '备份里的设置损坏' };

  const expected = checksumOf(JSON.stringify(data));
  if (expected !== raw['checksum']) {
    return { ok: false, reason: '备份校验失败（内容被修改或复制不完整）' };
  }

  const file: BackupFile = {
    format: BACKUP_FORMAT,
    schemaVersion: version,
    appVersion: typeof raw['appVersion'] === 'string' ? raw['appVersion'] : '未知',
    exportedAt: typeof raw['exportedAt'] === 'string' ? raw['exportedAt'] : '',
    checksum: raw['checksum'],
    data: data as unknown as BackupData,
  };
  return { ok: true, file, summary: summarizeBackup(file.data) };
}
