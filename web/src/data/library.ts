/**
 * 导入编排 —— 把外部文件变成书架上的文档。
 *
 * 这一层负责串联：原生桥 → 解码/去重 → IndexedDB → toast 反馈。
 * 它是 data 层里唯一允许同时调多个 IO 模块的地方。
 */

import type { Doc } from '../core/types';
import { normalizeLibraryDoc } from '../core/library';
import { deleteDoc, getAllDocs, putDocs } from './db';
import {
  parseIncomingFile,
  sha256Hex,
  sortByRecent,
  type IncomingFile,
} from './import';
import {
  base64ToBytes,
  clearPendingUris,
  onFilesReceived,
  peekPendingUris,
  pickFiles,
  readNativeFiles,
  type NativeFile,
} from './native';

/** 一次导入的汇总结果。 */
export interface ImportSummary {
  readonly imported: readonly Doc[];
  readonly skippedDuplicates: number;
  readonly failures: ReadonlyArray<{ name: string; reason: string }>;
}

/** NativeFile → IncomingFile（带 base64 解码）。 */
function toIncoming(file: NativeFile): IncomingFile {
  return {
    name: file.name,
    bytes: base64ToBytes(file.base64),
    size: file.size > 0 ? file.size : file.base64.length * 3 / 4,
    mtimeMs: file.mtimeMs !== null && file.mtimeMs > 0 ? file.mtimeMs : null,
    ...(file.uri.length > 0 ? { uri: file.uri } : {}),
  };
}

/** 收集当前书架上所有文档的内容哈希，用于去重。 */
function existingHashes(docs: readonly Doc[]): Set<string> {
  const set = new Set<string>();
  for (const doc of docs) {
    if (doc.fingerprint !== null) set.add(doc.fingerprint.sha256);
  }
  return set;
}

/**
 * 导入一批文件。返回真正新增的文档、被跳过的重复数、失败原因。
 * 重复项不会覆盖已有文档（否则会丢掉已有标注）。
 */
export async function importFiles(files: readonly NativeFile[]): Promise<ImportSummary> {
  const docs = await getAllDocs();
  const hashes = existingHashes(docs);
  const now = Date.now();

  const imported: Doc[] = [];
  const failures: Array<{ name: string; reason: string }> = [];
  let skippedDuplicates = 0;

  for (const file of files) {
    const incoming = toIncoming(file);
    const result = await parseIncomingFile(incoming, hashes, now);
    if (!result.ok) {
      failures.push({ name: result.name, reason: result.reason });
      continue;
    }
    if (result.duplicate) {
      skippedDuplicates++;
      continue;
    }
    imported.push(result.doc);
    hashes.add(result.doc.fingerprint?.sha256 ?? '');
  }

  if (imported.length > 0) {
    await putDocs(imported);
  }

  return { imported, skippedDuplicates, failures };
}

/** 读取排序后的书架列表。旧文档的 tags/folder 在这里补默认值（阶段 E1）。 */
export async function loadShelf(): Promise<Doc[]> {
  const docs = await getAllDocs();
  return sortByRecent(docs.map(normalizeLibraryDoc));
}

/** 从书架移除（不删外部原文件）。 */
export async function removeFromShelf(docId: string): Promise<void> {
  await deleteDoc(docId);
}

/** 更新一篇文档（阅读进度、编辑后的正文等）。 */
export async function saveDoc(doc: Doc): Promise<void> {
  await putDocs([doc]);
}

/**
 * 冷启动与 onNewIntent 事件可能几乎同时触发两次取 URI。
 * 用一把进程内锁串行化，避免同一次分享被导入两遍（第二遍会命中去重，
 * 但仍会多一次无意义的原生读取与 toast）。
 */
let pendingShareInFlight: Promise<ImportSummary> | null = null;

/**
 * 已经失败过一次的 URI 集合（进程内）。
 *
 * 为什么需要它：原生侧的待处理 URI 只有在「导入成功」后才被清空，
 * 读取失败时会刻意保留以便重试 —— 这是对的，否则一次权限失败就永久吞掉分享。
 * 但副作用是：同一条坏 URI 会在每次冷启动时被重新读取、重新失败、重新弹同一条 toast，
 * 用户看到的是「什么都没做，每次开 App 都报同一个错」。
 *
 * 处置：第一次失败照常提示；把 URI 记进这个集合，同一进程内不再重复读取，
 * 也不再重复弹提示。进程重启后（用户可能刚修好权限）会再试一次 ——
 * 既不静默吞掉重试机会，也不会无限骚扰。
 */
const failedPendingUris = new Set<string>();

/**
 * 处理启动 Intent 里待处理的分享/打开文件。
 *
 * 顺序刻意设计成「peek → 读 → 导入成功才 clear」：
 *   - peek 不清空：读取失败时 URI 保留，用户下次再打开还能重试；
 *     旧实现「取出即清空」会让一次权限/时序失败永久吞掉这份分享。
 *   - 读取异常不再吞：转成 failures，上层给出可见 toast。
 *   - 只有真正导入成功（含全是重复项）才清空；失败保留待重试。
 */
async function consumePendingShareOnce(): Promise<ImportSummary> {
  const empty: ImportSummary = { imported: [], skippedDuplicates: 0, failures: [] };
  const allUris = await peekPendingUris();
  if (allUris.length === 0) return empty;

  // 之前已经失败过的 URI 不再重试、不再重复提示（见 failedPendingUris 注释）
  const uris = allUris.filter((uri) => !failedPendingUris.has(uri));
  if (uris.length === 0) return empty;

  let files: NativeFile[];
  try {
    files = await readNativeFiles(uris);
  } catch (error) {
    // 不清空原生侧的 pendingUris：留给下次（用户可能刚修好权限）。
    // 但把这一批记进 failedPendingUris，本进程内不再重复读取与提示。
    for (const uri of uris) failedPendingUris.add(uri);
    // 原生消息多为英文系统异常，翻成用户能懂的话，别把 Permission Denial 甩给读者。
    const raw = error instanceof Error ? error.message : String(error);
    const reason = /permission|denial|access|EACCES/i.test(raw)
      ? '没有读取该文件的权限，请从文件管理器重新「用墨读打开」'
      : `读取失败：${raw}`;
    return { imported: [], skippedDuplicates: 0, failures: [{ name: '系统分享', reason }] };
  }

  if (files.length === 0) {
    // 插件返回空（provider 拒绝但未抛错）：同样记为已失败，避免每次启动重试同一个文件
    for (const uri of uris) failedPendingUris.add(uri);
    return {
      imported: [],
      skippedDuplicates: 0,
      failures: [{ name: '系统分享', reason: '未能读取到文件内容' }],
    };
  }

  const summary = await importFiles(files);

  // 只要解析/落库阶段没有把全部文件判为失败，就认为这批 URI 已消费。
  // 个别文件失败（如格式不支持）不应让整批 URI 反复重试；重复项也算消费成功。
  const allFailed = files.length > 0 && summary.failures.length === files.length;
  if (!allFailed) await clearPendingUris();

  return summary;
}

/** 处理启动 Intent 里待处理的分享/打开文件（带并发锁）。 */
export function consumePendingShare(): Promise<ImportSummary> {
  if (pendingShareInFlight !== null) return pendingShareInFlight;
  const task = consumePendingShareOnce().finally(() => {
    pendingShareInFlight = null;
  });
  pendingShareInFlight = task;
  return task;
}

/** 调起文件选择器并导入。 */
export async function importViaPicker(): Promise<ImportSummary> {
  const files = await pickFiles();
  if (files.length === 0) {
    return { imported: [], skippedDuplicates: 0, failures: [] };
  }
  return importFiles(files);
}

/** 订阅系统分享（App 在后台时被再次唤起）。 */
export function subscribeToShares(onImport: (summary: ImportSummary) => void): () => void {
  let dispose: (() => void) | null = null;

  void onFilesReceived(() => {
    void consumePendingShare().then(onImport);
  }).then((fn) => {
    dispose = fn;
  });

  return () => { dispose?.(); };
}

/** 导出给测试用的工具。 */
export const __importInternals = { toIncoming, existingHashes, sha256Hex };
