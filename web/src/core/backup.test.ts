/**
 * 备份文件单测（阶段 E3）。
 *
 * 覆盖：生成/解析往返、校验和损坏、格式/版本/结构拒绝、排序稳定性、
 * 以及「不写生词本占位」这类契约（schema 里就没有该字段）。
 */

import { describe, expect, it } from 'vitest';
import type { Doc, Mark, ReadingSession, Settings, TaskState } from './types';
import {
  BACKUP_FORMAT,
  BACKUP_SCHEMA_VERSION,
  buildBackup,
  canonicalData,
  checksumOf,
  parseBackup,
  summarizeBackup,
} from './backup';

const NOW = '2026-11-17T12:00:00.000Z';

function doc(id: string, patch: Partial<Doc> = {}): Doc {
  return {
    id,
    title: `标题 ${id}`,
    text: `# ${id}`,
    encoding: 'utf-8',
    source: { kind: 'inline' },
    fingerprint: null,
    importedAt: 1,
    lastReadAt: null,
    progress: null,
    ...patch,
  };
}

function mark(id: string): Mark {
  return {
    id,
    docId: 'd1',
    anchor: { bid: 'p-1', start: 0, end: 2, quote: '原文', prefix: '', suffix: '' },
    type: 'highlight',
    color: 'yellow',
    note: null,
    createdAt: 1,
  };
}

const SETTINGS = {
  schemaVersion: 4,
  theme: 'warm-paper',
  fontSize: 18,
} as unknown as Settings;

function task(id: string): TaskState {
  return { docId: id, bid: 'p-1', index: 0, checked: true } as TaskState;
}

function session(id: string): ReadingSession {
  return { id, docId: 'd1', startedAt: 1, endedAt: 2, ms: 1 } as ReadingSession;
}

function data() {
  return {
    docs: [doc('b'), doc('a')],
    marks: [mark('m2'), mark('m1')],
    tasks: [task('d2'), task('d1')],
    sessions: [session('s2'), session('s1')],
    settings: SETTINGS,
    bookmarks: ['d2', 'd1'],
    vocabulary: [
      { word: 'prospect', phonetic: 'prɒspekt', translation: 'n. 前景', addedAt: 5 },
      { word: 'inspect', phonetic: "in'spekt", translation: 'vt. 检查', addedAt: 3 },
    ],
  };
}

describe('备份生成', () => {
  it('包含格式/版本/校验和，数组按 id 稳定排序', () => {
    const text = buildBackup(data(), { appVersion: '0.8.0', exportedAt: NOW });
    const file = JSON.parse(text) as Record<string, unknown>;
    expect(file['format']).toBe(BACKUP_FORMAT);
    expect(file['schemaVersion']).toBe(BACKUP_SCHEMA_VERSION);
    expect(file['appVersion']).toBe('0.8.0');
    expect(file['exportedAt']).toBe(NOW);
    expect((file['data'] as { docs: Array<{ id: string }> }).docs.map((d) => d.id)).toEqual(['a', 'b']);
    expect((file['data'] as { bookmarks: string[] }).bookmarks).toEqual(['d1', 'd2']);
  });

  it('同一数据两次导出字节一致（便于 diff）', () => {
    const a = buildBackup(data(), { appVersion: 'x', exportedAt: NOW });
    const shuffled = {
      ...data(),
      docs: [doc('a'), doc('b')],
      marks: [mark('m1'), mark('m2')],
      vocabulary: [...data().vocabulary].reverse(),
    };
    const b = buildBackup(shuffled, { appVersion: 'x', exportedAt: NOW });
    expect(a).toBe(b);
  });

  it('校验和覆盖 data，改动内容会变', () => {
    const text = buildBackup(data(), { appVersion: 'x', exportedAt: NOW });
    const file = JSON.parse(text) as { checksum: string; data: unknown };
    expect(checksumOf(JSON.stringify(file.data))).toBe(file.checksum);
    const changed = buildBackup({ ...data(), bookmarks: ['d1'] }, { appVersion: 'x', exportedAt: NOW });
    expect(JSON.parse(changed).checksum).not.toBe(file.checksum);
  });

  it('canonicalData 不改输入', () => {
    const input = data();
    canonicalData(input);
    expect(input.docs.map((d) => d.id)).toEqual(['b', 'a']);
  });
});

describe('备份解析', () => {
  it('往返成功并给出统计', () => {
    const text = buildBackup(data(), { appVersion: '0.8.0', exportedAt: NOW });
    const parsed = parseBackup(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.summary).toEqual({ docs: 2, marks: 2, tasks: 2, sessions: 2, bookmarks: 2, vocabulary: 2 });
    expect(parsed.file.data.vocabulary.map((w) => w.word)).toEqual(['inspect', 'prospect']);
    expect(parsed.file.appVersion).toBe('0.8.0');
    expect(parsed.file.data.docs[0]?.id).toBe('a');
  });

  it('空内容 / 非 JSON / 非本应用格式被拒绝', () => {
    expect(parseBackup('')).toMatchObject({ ok: false });
    expect(parseBackup('  ')).toMatchObject({ ok: false });
    expect(parseBackup('{oops')).toMatchObject({ ok: false });
    const other = JSON.stringify({ format: 'other-app', schemaVersion: 1, data: {} });
    expect(parseBackup(other)).toMatchObject({ ok: false, reason: expect.stringContaining('不是墨读') });
  });

  it('未来版本明确拒绝（不做猜测迁移）', () => {
    const text = buildBackup(data(), { appVersion: 'x', exportedAt: NOW });
    const file = JSON.parse(text) as Record<string, unknown>;
    file['schemaVersion'] = BACKUP_SCHEMA_VERSION + 1;
    const parsed = parseBackup(JSON.stringify(file));
    expect(parsed).toMatchObject({ ok: false, reason: expect.stringContaining('更新版本') });
  });

  it('内容被改动 → 校验失败', () => {
    const text = buildBackup(data(), { appVersion: 'x', exportedAt: NOW });
    const file = JSON.parse(text) as { data: { bookmarks: string[] } };
    file.data.bookmarks.push('tampered');
    const parsed = parseBackup(JSON.stringify(file));
    expect(parsed).toMatchObject({ ok: false, reason: expect.stringContaining('校验失败') });
  });

  it('结构损坏（缺列表/设置）被拒绝', () => {
    const text = buildBackup(data(), { appVersion: 'x', exportedAt: NOW });
    const base = JSON.parse(text) as Record<string, unknown> & { data: Record<string, unknown> };
    for (const key of ['docs', 'marks', 'tasks', 'sessions', 'bookmarks', 'settings', 'vocabulary']) {
      const copy = JSON.parse(JSON.stringify(base)) as { data: Record<string, unknown> };
      delete copy.data[key];
      const parsed = parseBackup(JSON.stringify(copy));
      expect(parsed.ok).toBe(false);
    }
  });

  it('统计函数对空数据返回 0', () => {
    expect(
      summarizeBackup({
        docs: [],
        marks: [],
        tasks: [],
        sessions: [],
        settings: SETTINGS,
        bookmarks: [],
        vocabulary: [],
      }),
    ).toEqual({ docs: 0, marks: 0, tasks: 0, sessions: 0, bookmarks: 0, vocabulary: 0 });
  });

  it('schemaVersion 1 的旧备份可恢复：没有生词本字段 → 视为空', () => {
    // 手工构造一份 v1 备份：data 里没有 vocabulary，checksum 按 v1 的 data 算
    const data = {
      docs: [doc('a')],
      marks: [],
      tasks: [],
      sessions: [],
      settings: SETTINGS,
      bookmarks: ['a'],
    };
    const checksum = checksumOf(JSON.stringify(data));
    const text = JSON.stringify({
      format: BACKUP_FORMAT,
      schemaVersion: 1,
      appVersion: '0.7.0',
      exportedAt: NOW,
      checksum,
      data,
    });
    const parsed = parseBackup(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.data.vocabulary).toEqual([]);
    expect(parsed.summary).toMatchObject({ docs: 1, vocabulary: 0 });
  });

  it('v2 备份的生词本损坏时拒绝', () => {
    const text = buildBackup(data(), { appVersion: 'x', exportedAt: NOW });
    const file = JSON.parse(text) as { data: Record<string, unknown> };
    file.data['vocabulary'] = 'not-an-array';
    const parsed = parseBackup(JSON.stringify(file));
    expect(parsed).toMatchObject({ ok: false, reason: expect.stringContaining('生词本') });
  });
});
