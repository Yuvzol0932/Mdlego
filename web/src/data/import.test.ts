import { describe, expect, it } from 'vitest';
import {
  decodeText,
  encodeText,
  MAX_FILE_BYTES,
  parseIncomingFile,
  sha256Hex,
  sortByRecent,
  titleFromFilename,
  type IncomingFile,
} from './import';
import type { Doc } from '../core/types';

/** 构造 GBK 字节：用预置的中文字节序列（"中文笔记" 的 GBK 编码）。 */
const GBK_SAMPLE = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xb1, 0xca, 0xbc, 0xc7]);

function incoming(overrides: Partial<IncomingFile> = {}): IncomingFile {
  return {
    name: 'note.md',
    bytes: new TextEncoder().encode('# 标题\n\n内容'),
    size: 0,
    mtimeMs: null,
    ...overrides,
  };
}

function makeDoc(id: string, lastReadAt: number | null, importedAt: number): Doc {
  return {
    id,
    title: `文档${id}`,
    text: '内容',
    encoding: 'utf-8',
    source: { kind: 'inline' },
    fingerprint: null,
    importedAt,
    lastReadAt,
    progress: null,
  };
}

describe('decodeText — 编码探测', () => {
  it('普通 UTF-8', () => {
    const bytes = new TextEncoder().encode('# 中文标题\n\n正文');
    const r = decodeText(bytes);
    expect(r.encoding).toBe('utf-8');
    expect(r.text).toContain('中文标题');
  });

  it('UTF-8 BOM 被剥离且标记为 utf-8-bom', () => {
    const body = new TextEncoder().encode('# 标题');
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
    const r = decodeText(bytes);
    expect(r.encoding).toBe('utf-8-bom');
    expect(r.text).toBe('# 标题');
    expect(r.text.startsWith('\uFEFF')).toBe(false);
  });

  it('纯 ASCII 仍是 UTF-8', () => {
    expect(decodeText(new TextEncoder().encode('hello world')).encoding).toBe('utf-8');
  });

  it('GBK 中文被正确识别并解出汉字', () => {
    const r = decodeText(GBK_SAMPLE);
    expect(r.encoding).toBe('gbk');
    expect(r.text).toBe('中文笔记');
  });

  it('GBK 字节不会被误当 UTF-8 输出乱码', () => {
    const r = decodeText(GBK_SAMPLE);
    expect(r.text).not.toContain('\uFFFD');
  });

  it('空字节得到空文本', () => {
    const r = decodeText(new Uint8Array(0));
    expect(r.text).toBe('');
    expect(r.encoding).toBe('utf-8');
  });
});

describe('encodeText — 回写对称', () => {
  it('UTF-8 编码可逆', () => {
    const text = '# 中文\n\n内容';
    const bytes = encodeText(text, 'utf-8');
    expect(new TextDecoder().decode(bytes)).toBe(text);
  });

  it('带 BOM 时重新写出 BOM', () => {
    const bytes = encodeText('abc', 'utf-8-bom');
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('utf-8-bom 编码后再解码能还原（BOM 被剥）', () => {
    const text = '# 标题';
    const r = decodeText(encodeText(text, 'utf-8-bom'));
    expect(r.encoding).toBe('utf-8-bom');
    expect(r.text).toBe(text);
  });

  it('GBK 回写在 Web 层明确拒绝（避免静默写坏原文件）', () => {
    expect(() => encodeText('中文', 'gbk')).toThrow(/原生层/);
  });
});

describe('sha256Hex', () => {
  it('相同内容得到相同哈希', async () => {
    const a = await sha256Hex(new TextEncoder().encode('abc'));
    const b = await sha256Hex(new TextEncoder().encode('abc'));
    expect(a).toBe(b);
  });

  it('不同内容得到不同哈希', async () => {
    const a = await sha256Hex(new TextEncoder().encode('abc'));
    const b = await sha256Hex(new TextEncoder().encode('abd'));
    expect(a).not.toBe(b);
  });

  it('返回 64 位小写十六进制', async () => {
    const h = await sha256Hex(new TextEncoder().encode('x'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('空内容也有哈希', async () => {
    const h = await sha256Hex(new Uint8Array(0));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('titleFromFilename', () => {
  it('去掉 .md 扩展名', () => {
    expect(titleFromFilename('考研笔记.md')).toBe('考研笔记');
  });

  it('去掉 .markdown', () => {
    expect(titleFromFilename('read.markdown')).toBe('read');
  });

  it('去掉 .txt', () => {
    expect(titleFromFilename('note.txt')).toBe('note');
  });

  it('去掉路径部分', () => {
    expect(titleFromFilename('Download/笔记.md')).toBe('笔记');
  });

  it('空文件名回落', () => {
    expect(titleFromFilename('.md')).toBe('未命名文档');
  });

  it('多点的文件名只去最后一个扩展', () => {
    expect(titleFromFilename('2026.11.笔记.md')).toBe('2026.11.笔记');
  });
});

describe('parseIncomingFile', () => {
  it('正常导入并推断标题', async () => {
    const r = await parseIncomingFile(incoming(), new Set(), 1000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.doc.title).toBe('标题');
      expect(r.duplicate).toBe(false);
      expect(r.doc.encoding).toBe('utf-8');
    }
  });

  it('无标题时用文件名', async () => {
    const r = await parseIncomingFile(
      incoming({ name: '我的笔记.md', bytes: new TextEncoder().encode('只有正文') }),
      new Set(),
      1000,
    );
    expect(r.ok && r.doc.title).toBe('我的笔记');
  });

  it('带 uri 时记录 file 来源', async () => {
    const r = await parseIncomingFile(
      incoming({ uri: 'content://com.example/note.md' }),
      new Set(),
      1000,
    );
    expect(r.ok && r.doc.source).toEqual({ kind: 'file', uri: 'content://com.example/note.md' });
  });

  it('记录文件指纹', async () => {
    const r = await parseIncomingFile(incoming({ size: 123, mtimeMs: 999 }), new Set(), 1000);
    expect(r.ok && r.doc.fingerprint).toEqual({
      size: 123,
      mtimeMs: 999,
      sha256: expect.any(String),
    });
  });

  it('相同内容被标记为重复', async () => {
    const bytes = new TextEncoder().encode('# 标题\n\n内容');
    const hash = await sha256Hex(bytes);
    const r = await parseIncomingFile(incoming({ bytes }), new Set([hash]), 1000);
    expect(r.ok && r.duplicate).toBe(true);
  });

  it('内容不同不算重复', async () => {
    const r = await parseIncomingFile(incoming(), new Set(['0'.repeat(64)]), 1000);
    expect(r.ok && r.duplicate).toBe(false);
  });

  it('重复内容得到相同 docId（幂等）', async () => {
    const bytes = new TextEncoder().encode('# 标题');
    const a = await parseIncomingFile(incoming({ bytes }), new Set(), 1000);
    const b = await parseIncomingFile(incoming({ bytes, name: '改名.md' }), new Set(), 2000);
    expect(a.ok && b.ok && a.doc.id).toBe(b.ok ? b.doc.id : '');
  });

  it('拒绝不支持的扩展名', async () => {
    const r = await parseIncomingFile(incoming({ name: 'photo.png' }), new Set(), 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('.md');
  });

  it('拒绝空文件', async () => {
    const r = await parseIncomingFile(incoming({ bytes: new Uint8Array(0) }), new Set(), 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('空');
  });

  it('拒绝超过上限的文件', async () => {
    const r = await parseIncomingFile(
      incoming({ bytes: new Uint8Array(MAX_FILE_BYTES + 1) }),
      new Set(),
      1000,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('10 MB');
  });

  it('GBK 文件导入后仍是可读中文', async () => {
    const r = await parseIncomingFile(
      incoming({ name: 'gbk.md', bytes: GBK_SAMPLE }),
      new Set(),
      1000,
    );
    expect(r.ok && r.doc.encoding).toBe('gbk');
    expect(r.ok && r.doc.text).toBe('中文笔记');
  });

  it('BOM 文件导入后标题正确', async () => {
    const body = new TextEncoder().encode('# 带BOM的标题');
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
    const r = await parseIncomingFile(incoming({ bytes }), new Set(), 1000);
    expect(r.ok && r.doc.title).toBe('带BOM的标题');
  });
});

describe('sortByRecent — 按最近阅读排序', () => {
  it('最近读过的排最前', () => {
    const docs = [makeDoc('a', null, 1000), makeDoc('b', 5000, 1000), makeDoc('c', 3000, 1000)];
    expect(sortByRecent(docs).map((d) => d.id)).toEqual(['b', 'c', 'a']);
  });

  it('都没读过时按导入时间倒序', () => {
    const docs = [makeDoc('a', null, 1000), makeDoc('b', null, 3000), makeDoc('c', null, 2000)];
    expect(sortByRecent(docs).map((d) => d.id)).toEqual(['b', 'c', 'a']);
  });

  it('排序纯粹看「最后活动时间」，久未读的会沉到新导入的后面', () => {
    // 这符合「每天反复翻」的用法：最近碰过的在最上面，
    // 不会让一篇三个月前读过的文档永远霸占第一位。
    const docs = [makeDoc('fresh', null, 99999), makeDoc('old', 1, 1)];
    expect(sortByRecent(docs)[0]?.id).toBe('fresh');
  });

  it('读过且读得更近的排在刚导入但没读过的前面', () => {
    const docs = [makeDoc('new', null, 5000), makeDoc('read', 6000, 1000)];
    expect(sortByRecent(docs)[0]?.id).toBe('read');
  });

  it('不修改原数组', () => {
    const docs = [makeDoc('a', null, 1000), makeDoc('b', 5000, 1000)];
    sortByRecent(docs);
    expect(docs[0]?.id).toBe('a');
  });

  it('空数组安全', () => {
    expect(sortByRecent([])).toEqual([]);
  });
});
