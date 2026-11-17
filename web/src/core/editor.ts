/**
 * 编辑原文的纯逻辑（阶段 E5）。
 *
 * 这里只负责「编辑后的文本/标题」与「能不能直接写回」的判断；
 * 读文件、比指纹、写文件、建副本全部在 main + data 层做。
 */

import type { Doc, FileFingerprint } from './types';

/** 编辑文本归一化：去 BOM、CRLF/CR → LF（避免回写后原文件出现混合换行）。 */
export function normalizeEditedText(raw: string): string {
  return raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** 从正文推导标题：第一个一级标题；没有则保留原标题。 */
export function titleFromText(text: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(text);
  const title = match?.[1]?.trim() ?? '';
  return title.length > 0 ? title.slice(0, 80) : fallback;
}

/** 编辑是否真的改了内容（归一化后比较；只有 BOM/换行差异不算修改）。 */
export function isTextChanged(original: string, next: string): boolean {
  return normalizeEditedText(original) !== normalizeEditedText(next);
}

/** 保存前对原文件的一次快照。 */
export interface OriginalSnapshot {
  /** 原文件是否还存在/可读；浏览器里无法读原文件时为 false。 */
  readonly exists: boolean;
  /** 当前原文件内容的 sha256（读不到为 null）。 */
  readonly sha256: string | null;
  readonly size: number;
  readonly mtimeMs: number | null;
}

/**
 * 决定保存路径：
 *   - no-original：这篇没有可回写的外部文件（粘贴/示例/浏览器导入），只能存应用内副本；
 *   - missing：原文件不见了（被移动/删除），不能写回；
 *   - conflict：原文件内容与导入时不同（外部改过），必须让用户选择；
 *   - write：原文件没变，可以安全写回。
 */
export type SaveDecision = 'no-original' | 'missing' | 'conflict' | 'write';

export function decideSave(
  doc: Pick<Doc, 'source' | 'fingerprint'>,
  snapshot: OriginalSnapshot | null,
): SaveDecision {
  if (doc.source.kind !== 'file') return 'no-original';
  if (snapshot === null || !snapshot.exists) return 'missing';
  const base: FileFingerprint | null = doc.fingerprint;
  if (base === null) return 'no-original';
  if (snapshot.sha256 !== null && snapshot.sha256 !== base.sha256) return 'conflict';
  return 'write';
}

/** 写回成功后更新文档的指纹（大小/时间/哈希全部按新内容）。 */
export function updatedFingerprint(bytesLength: number, sha256: string, mtimeMs: number | null): FileFingerprint {
  return { size: bytesLength, mtimeMs, sha256 };
}
