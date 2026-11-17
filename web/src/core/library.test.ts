/**
 * 书架数据纯函数单测（阶段 E1）。
 *
 * 覆盖：标签/文件夹归一化（空白、大小写去重、长度与数量上限）、
 * 筛选（全部/收藏/标签/文件夹）、收藏计数只算现存文档、
 * 三态计算、批量加/减标签与移动文件夹的「未变化文档保持引用」。
 */

import { describe, expect, it } from 'vitest';
import type { Doc } from './types';
import {
  FOLDER_MAX_LEN,
  TAG_MAX_COUNT,
  TAG_MAX_LEN,
  addTagToDocs,
  collectFacets,
  filterDocs,
  folderOf,
  isFiltering,
  normalizeFolder,
  normalizeLibraryDoc,
  normalizeTag,
  normalizeTags,
  removeTagFromDocs,
  setFolderForDocs,
  tagSelectionState,
  tagsAmongDocs,
  tagsOf,
} from './library';

function doc(id: string, patch: Partial<Doc> = {}): Doc {
  return {
    id,
    title: id,
    text: '# ' + id,
    encoding: 'utf-8',
    source: { kind: 'inline' },
    fingerprint: null,
    importedAt: 1,
    lastReadAt: null,
    progress: null,
    ...patch,
  };
}

describe('标签归一化', () => {
  it('去首尾空白、折叠内部空白；空白返回 null', () => {
    expect(normalizeTag('  考研  ')).toBe('考研');
    expect(normalizeTag('a  b\tc')).toBe('a b c');
    expect(normalizeTag('   ')).toBeNull();
    expect(normalizeTag(42)).toBeNull();
  });

  it('超长标签截断到上限', () => {
    expect(normalizeTag('x'.repeat(100))?.length).toBe(TAG_MAX_LEN);
  });

  it('列表去重（大小写不敏感、保留首次大小写）并限数量', () => {
    expect(normalizeTags(['Deep Work', 'deep work', '阅读', ' 阅读 '])).toEqual(['Deep Work', '阅读']);
    const many = Array.from({ length: TAG_MAX_COUNT + 5 }, (_, i) => `t${i}`);
    expect(normalizeTags(many)).toHaveLength(TAG_MAX_COUNT);
    expect(normalizeTags('not-array')).toEqual([]);
  });

  it('文件夹名归一化，空白为 null', () => {
    expect(normalizeFolder('  课程  ')).toBe('课程');
    expect(normalizeFolder('')).toBeNull();
    expect(normalizeFolder(null)).toBeNull();
    expect(normalizeFolder('x'.repeat(100))?.length).toBe(FOLDER_MAX_LEN);
  });

  it('旧文档（没有 tags/folder 字段）读取时补默认值', () => {
    const old = doc('a');
    expect(tagsOf(old)).toEqual([]);
    expect(folderOf(old)).toBeNull();
    const normalized = normalizeLibraryDoc(old);
    expect(normalized.tags).toEqual([]);
    expect(normalized.folder).toBeNull();
  });

  it('已归一化的文档返回原对象（避免无谓重绘）', () => {
    const clean = doc('a', { tags: ['阅读'], folder: '课程' });
    expect(normalizeLibraryDoc(clean)).toBe(clean);
    // 脏数据（重复/空白标签）会被重建成新对象
    const dirty = doc('b', { tags: [' 阅读 ', '阅读'] });
    expect(normalizeLibraryDoc(dirty)).not.toBe(dirty);
    expect(normalizeLibraryDoc(dirty).tags).toEqual(['阅读']);
  });
});

describe('筛选维度统计', () => {
  const docs = [
    doc('a', { tags: ['考研', '阅读'], folder: '课程' }),
    doc('b', { tags: ['考研'], folder: '课程' }),
    doc('c', { folder: '项目' }),
  ];

  it('标签/文件夹按使用次数降序，次数相同按名称', () => {
    const facets = collectFacets(docs, []);
    expect(facets.total).toBe(3);
    expect(facets.tags).toEqual([
      { value: '考研', count: 2 },
      { value: '阅读', count: 1 },
    ]);
    expect(facets.folders).toEqual([
      { value: '课程', count: 2 },
      { value: '项目', count: 1 },
    ]);
  });

  it('收藏计数只算仍存在的文档（书签可能残留已删除 id）', () => {
    const facets = collectFacets(docs, ['a', 'deleted-id', 'c']);
    expect(facets.favorites).toBe(2);
  });
});

describe('筛选', () => {
  const docs = [
    doc('a', { tags: ['考研'], folder: '课程' }),
    doc('b', { tags: ['阅读'], folder: null }),
    doc('c'),
  ];

  it('全部 / 收藏 / 标签（大小写不敏感）/ 文件夹', () => {
    expect(filterDocs(docs, { kind: 'all' }, []).map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(filterDocs(docs, { kind: 'favorites' }, ['b']).map((d) => d.id)).toEqual(['b']);
    expect(filterDocs(docs, { kind: 'tag', tag: 'kaoyan' }, []).map((d) => d.id)).toEqual([]);
    expect(filterDocs(docs, { kind: 'tag', tag: '考研' }, []).map((d) => d.id)).toEqual(['a']);
    expect(filterDocs(docs, { kind: 'folder', folder: '课程' }, []).map((d) => d.id)).toEqual(['a']);
  });

  it('是否处于筛选态', () => {
    expect(isFiltering({ kind: 'all' })).toBe(false);
    expect(isFiltering({ kind: 'favorites' })).toBe(true);
    expect(isFiltering({ kind: 'tag', tag: 'x' })).toBe(true);
  });
});

describe('标签三态', () => {
  it('全部有 / 部分有 / 都没有；空选择为 none', () => {
    const a = doc('a', { tags: ['考研'] });
    const b = doc('b', { tags: ['考研', '阅读'] });
    const c = doc('c');
    expect(tagSelectionState([a, b], '考研')).toBe('all');
    expect(tagSelectionState([a, c], '考研')).toBe('some');
    expect(tagSelectionState([c], '考研')).toBe('none');
    expect(tagSelectionState([], '考研')).toBe('none');
  });
});

describe('批量变更', () => {
  it('加标签：只影响选中项，已有跳过，未选中保持引用', () => {
    const a = doc('a');
    const b = doc('b');
    const next = addTagToDocs([a, b], ['a'], '考研');
    expect(next[0]?.tags).toEqual(['考研']);
    expect(next[1]).toBe(b);
    // 再加一次不重复，且文档本身不变
    const again = addTagToDocs(next, ['a'], ' 考研 ');
    expect(again[0]).toBe(next[0]);
  });

  it('移除标签大小写不敏感；没变化时保持引用', () => {
    const a = doc('a', { tags: ['Deep Work', '阅读'] });
    const same = removeTagFromDocs([a], ['a'], '不存在');
    expect(same[0]).toBe(a);
    const next = removeTagFromDocs([a], ['a'], 'deep work');
    expect(next[0]?.tags).toEqual(['阅读']);
  });

  it('移动/移出文件夹；相同值不产生新对象', () => {
    const a = doc('a', { folder: '课程' });
    const same = setFolderForDocs([a], ['a'], '课程');
    expect(same[0]).toBe(a);
    const moved = setFolderForDocs([a], ['a'], '项目');
    expect(moved[0]?.folder).toBe('项目');
    const removed = setFolderForDocs([a], ['a'], null);
    expect(removed[0]?.folder).toBeNull();
  });

  it('从一组文档收集标签（面板候选）', () => {
    const docs = [doc('a', { tags: ['考研', '阅读'] }), doc('b', { tags: ['考研'] })];
    expect(tagsAmongDocs(docs)).toEqual([
      { value: '考研', count: 2 },
      { value: '阅读', count: 1 },
    ]);
  });
});
