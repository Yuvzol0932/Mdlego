/**
 * 备份数据的读写（阶段 E3，data 层 IO）。
 *
 * 收集：IndexedDB（文档/批注/任务/会话）+ localStorage 设置 + meta 里的收藏。
 * 恢复：清空四个仓库后一次性写入（单事务，避免写一半留下混合数据），
 *       再写回设置与收藏。
 *
 * 这里不碰 DOM、不弹提示；失败抛错由 main 统一 toast。
 * 校验与版本判断在 core/backup.ts，恢复前必须已经通过 parseBackup。
 */

import type { BackupData } from '../core/backup';
import { normalizeWords } from '../core/vocabulary';
import {
  getAllDocs,
  getAllMarks,
  getAllSessions,
  getAllTasks,
  getMeta,
  openDb,
  setMeta,
} from './db';
import { loadSettings, saveSettings } from './settings-store';

/** 从本机收集一份可备份的数据。 */
export async function collectBackupData(): Promise<BackupData> {
  const [docs, marks, tasks, sessions, rawBookmarks, rawWords] = await Promise.all([
    getAllDocs(),
    getAllMarks(),
    getAllTasks(),
    getAllSessions(),
    getMeta('bookmarks'),
    getMeta('wordbook'),
  ]);
  const bookmarks = Array.isArray(rawBookmarks)
    ? rawBookmarks.filter((value): value is string => typeof value === 'string')
    : [];
  return {
    docs,
    marks,
    tasks,
    sessions,
    settings: loadSettings(),
    bookmarks,
    vocabulary: normalizeWords(rawWords),
  };
}

/** 覆盖式恢复：清空四个仓库后写入备份数据（单事务）。 */
export async function applyBackupData(data: BackupData): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['docs', 'marks', 'tasks', 'sessions'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('恢复事务失败'));
    tx.onabort = () => reject(tx.error ?? new Error('恢复事务被中止'));
    const docs = tx.objectStore('docs');
    const marks = tx.objectStore('marks');
    const tasks = tx.objectStore('tasks');
    const sessions = tx.objectStore('sessions');
    docs.clear();
    marks.clear();
    tasks.clear();
    sessions.clear();
    for (const doc of data.docs) docs.put(doc);
    for (const mark of data.marks) marks.put(mark);
    for (const task of data.tasks) tasks.put(task);
    for (const session of data.sessions) sessions.put(session);
  });
  // 不要 close：openDb 是模块级缓存的连接，关掉会让后续读写全部报
  // "database connection is closing"（E3 smoke 抓到过）。连接复用由 db.ts 管。

  await setMeta('bookmarks', data.bookmarks);
  await setMeta('wordbook', data.vocabulary);
  saveSettings(data.settings);
}
