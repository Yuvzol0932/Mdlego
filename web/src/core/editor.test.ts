/**
 * 编辑纯逻辑单测（阶段 E5）。
 */

import { describe, expect, it } from 'vitest';
import type { Doc } from './types';
import {
  decideSave,
  isTextChanged,
  normalizeEditedText,
  titleFromText,
  updatedFingerprint,
  type OriginalSnapshot,
} from './editor';

const FILE_DOC: Pick<Doc, 'source' | 'fingerprint'> = {
  source: { kind: 'file', uri: 'content://doc/1' },
  fingerprint: { size: 10, mtimeMs: 1, sha256: 'aaa' },
};

const INLINE_DOC: Pick<Doc, 'source' | 'fingerprint'> = {
  source: { kind: 'inline' },
  fingerprint: null,
};

function snapshot(patch: Partial<OriginalSnapshot> = {}): OriginalSnapshot {
  return { exists: true, sha256: 'aaa', size: 10, mtimeMs: 1, ...patch };
}

describe('文本与标题', () => {
  it('去 BOM、统一换行；只有换行差异不算修改', () => {
    expect(normalizeEditedText('\uFEFFa\r\nb\rc')).toBe('a\nb\nc');
    expect(isTextChanged('a\nb', 'a\r\nb')).toBe(false);
    expect(isTextChanged('a', 'a ')).toBe(true);
  });

  it('标题取第一个一级标题，没有则回退原标题', () => {
    expect(titleFromText('前言\n\n# 新标题\n\n正文', '旧')).toBe('新标题');
    expect(titleFromText('## 二级不算', '旧标题')).toBe('旧标题');
    expect(titleFromText('', '旧标题')).toBe('旧标题');
  });
});

describe('保存路径决策', () => {
  it('内部文档（无外部文件）→ 只能存副本', () => {
    expect(decideSave(INLINE_DOC, null)).toBe('no-original');
  });

  it('原文件不见了 → missing', () => {
    expect(decideSave(FILE_DOC, snapshot({ exists: false }))).toBe('missing');
  });

  it('原文件内容变了 → conflict；没变 → write', () => {
    expect(decideSave(FILE_DOC, snapshot({ sha256: 'bbb' }))).toBe('conflict');
    expect(decideSave(FILE_DOC, snapshot())).toBe('write');
  });

  it('浏览器无法读原文件（读不到 sha）时不误判冲突，按尺寸都不匹配 → conflict 仍靠 sha 判断为 null 时放行? ', () => {
    // 契约：sha 为 null 说明读不到内容，不能断言冲突；此时按 write 放行，
    // 真正写文件失败会在写回阶段报 failed（调用方提示），不会静默成功。
    expect(decideSave(FILE_DOC, snapshot({ sha256: null }))).toBe('write');
  });
});

describe('指纹更新', () => {
  it('新指纹用新的字节数/哈希/时间', () => {
    expect(updatedFingerprint(20, 'ccc', 5)).toEqual({ size: 20, sha256: 'ccc', mtimeMs: 5 });
  });
});
