/**
 * 文件导入 —— 把外部字节流变成一篇 Doc。
 *
 * 两个真实的坑：
 *  1. 中文笔记常是 GBK。UTF-8 严格解码失败时必须回退 GBK，
 *     否则用户看到的就是乱码，而且回写时还会把乱码写回原文件。
 *  2. 同一份文件可能被反复导入（尤其从系统分享进来）。
 *     用内容 sha256 去重，而不是靠文件名 —— 文件名会改，内容不会。
 */

import { extractTitle } from '../core/markdown';
import type { Doc, FileFingerprint, TextEncoding } from '../core/types';

/** 导入上限。超过就明确拒绝，不让 WebView 被超大文件拖死。 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** 允许的扩展名。 */
const ALLOWED_EXT = /\.(md|markdown|txt)$/i;

/** 一个待导入的原始文件。 */
export interface IncomingFile {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly mtimeMs: number | null;
  /** 系统 content:// URI；浏览器里没有。 */
  readonly uri?: string;
}

/** 导入结果。失败时带明确原因，不静默跳过。 */
export type ImportResult =
  | { readonly ok: true; readonly doc: Doc; readonly duplicate: boolean }
  | { readonly ok: false; readonly name: string; readonly reason: string };

/** 计算字节数组的 SHA-256（十六进制小写）。 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 探测文本编码并解码。
 *
 * 顺序：UTF-8 BOM → 严格 UTF-8 → GBK → unknown（用 UTF-8 宽松解码，但明确标记）。
 * TextDecoder 的 fatal 模式是关键：不用它会把非法字节静默替换成 U+FFFD，
 * 我们就永远发现不了这其实是 GBK。
 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: TextEncoding } {
  // BOM
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return {
      text: new TextDecoder('utf-8').decode(bytes.subarray(3)),
      encoding: 'utf-8-bom',
    };
  }

  // 严格 UTF-8
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text, encoding: 'utf-8' };
  } catch {
    // 落到 GBK
  }

  // GBK（TextDecoder 的 'gbk' 在 Chromium / Android WebView 均可用）
  try {
    const text = new TextDecoder('gbk').decode(bytes);
    // 若解出大量替换字符，说明连 GBK 也不对
    const replacementRatio = (text.match(/\uFFFD/g) ?? []).length / Math.max(1, text.length);
    if (replacementRatio < 0.01) return { text, encoding: 'gbk' };
    return { text, encoding: 'unknown' };
  } catch {
    return {
      text: new TextDecoder('utf-8').decode(bytes),
      encoding: 'unknown',
    };
  }
}

/** 按编码把文本重新编码回字节（回写原文件时用）。 */
export function encodeText(text: string, encoding: TextEncoding): Uint8Array {
  if (encoding === 'gbk') {
    // TextEncoder 只支持 UTF-8；GBK 回写交给原生层用 Java 的 Charset 处理。
    // 这里抛出一个明确错误，避免静默用 UTF-8 写回导致原文件乱码。
    throw new Error('GBK 回写需由原生层处理');
  }
  const body = new TextEncoder().encode(text);
  if (encoding !== 'utf-8-bom') return body;

  const withBom = new Uint8Array(body.length + 3);
  withBom.set([0xef, 0xbb, 0xbf]);
  withBom.set(body, 3);
  return withBom;
}

/** 从文件名推出可用标题（取路径最后一段、去扩展名）。 */
export function titleFromFilename(name: string): string {
  // 先取路径最后一段，否则 "Download/笔记.md" 会变成 "Download笔记"
  const segments = name.split(/[\\/]/);
  const leaf = segments[segments.length - 1] ?? name;
  const base = leaf.replace(/\.[^.]+$/, '');
  return base.trim().length > 0 ? base.trim() : '未命名文档';
}

/**
 * 把 IncomingFile 解析成 Doc。
 * 传入 existingHashes 用于内容去重；由调用方决定是否真的写入。
 */
export async function parseIncomingFile(
  file: IncomingFile,
  existingHashes: ReadonlySet<string>,
  now: number,
): Promise<ImportResult> {
  if (!ALLOWED_EXT.test(file.name)) {
    return { ok: false, name: file.name, reason: '只支持 .md / .markdown / .txt' };
  }
  if (file.bytes.byteLength === 0) {
    return { ok: false, name: file.name, reason: '文件是空的' };
  }
  if (file.bytes.byteLength > MAX_FILE_BYTES) {
    return { ok: false, name: file.name, reason: `超过 10 MB 上限（${(file.bytes.byteLength / 1048576).toFixed(1)} MB）` };
  }

  const { text, encoding } = decodeText(file.bytes);
  const sha256 = await sha256Hex(file.bytes);
  const duplicate = existingHashes.has(sha256);

  const fingerprint: FileFingerprint = {
    size: file.size,
    mtimeMs: file.mtimeMs,
    sha256,
  };

  const doc: Doc = {
    id: `doc-${sha256.slice(0, 16)}`,
    title: extractTitle(text) ?? titleFromFilename(file.name),
    text,
    encoding,
    source: file.uri !== undefined ? { kind: 'file', uri: file.uri } : { kind: 'inline' },
    fingerprint,
    importedAt: now,
    lastReadAt: null,
    progress: null,
  };

  return { ok: true, doc, duplicate };
}

/** 按最近阅读排序：读过的在前、越近越前；没读过的按导入时间。 */
export function sortByRecent(docs: readonly Doc[]): Doc[] {
  return [...docs].sort((a, b) => {
    const aTime = a.lastReadAt ?? a.importedAt;
    const bTime = b.lastReadAt ?? b.importedAt;
    if (aTime !== bTime) return bTime - aTime;
    return a.title.localeCompare(b.title, 'zh-CN');
  });
}
