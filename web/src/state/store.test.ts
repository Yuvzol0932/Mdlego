import { describe, expect, it } from 'vitest';
import { createInitialState, reduce, selectCurrentDoc, selectCurrentMarks, selectCurrentTasks } from './store';
import type { Doc, Mark, State } from '../core/types';
import { DEFAULT_SETTINGS } from '../data/settings-store';

function makeDoc(id: string): Doc {
  return {
    id,
    title: `文档 ${id}`,
    text: `# 文档 ${id}`,
    encoding: 'utf-8',
    source: { kind: 'inline' },
    fingerprint: null,
    importedAt: 1000,
    lastReadAt: null,
    progress: null,
  };
}

function makeMark(id: string, docId: string): Mark {
  return {
    id,
    docId,
    anchor: { bid: 'p-1', start: 0, end: 3, quote: 'abc', prefix: '', suffix: '' },
    type: 'highlight',
    color: 'yellow',
    note: null,
    createdAt: 1000,
  };
}

describe('createInitialState', () => {
  it('默认状态各字段为空', () => {
    const s = createInitialState();
    expect(s.docs).toEqual([]);
    expect(s.currentDocId).toBeNull();
    expect(s.readerStatus).toBe('idle');
    expect(s.overlay).toBe('none');
  });

  it('接受注入的设置', () => {
    const s = createInitialState({ ...DEFAULT_SETTINGS, typeScale: 6 });
    expect(s.settings.typeScale).toBe(6);
  });
});

describe('reduce — 文档', () => {
  it('导入文档追加到列表', () => {
    const s0 = createInitialState();
    const s1 = reduce(s0, { type: 'doc/imported', doc: makeDoc('a') });
    expect(s1.docs).toHaveLength(1);
    expect(s0.docs).toHaveLength(0); // 原状态未被修改
  });

  it('更新文档只替换对应项', () => {
    let s = createInitialState();
    s = reduce(s, { type: 'doc/imported', doc: makeDoc('a') });
    s = reduce(s, { type: 'doc/imported', doc: makeDoc('b') });
    s = reduce(s, { type: 'doc/updated', doc: { ...makeDoc('a'), title: '改过' } });
    expect(s.docs.find((d) => d.id === 'a')?.title).toBe('改过');
    expect(s.docs.find((d) => d.id === 'b')?.title).toBe('文档 b');
  });

  it('删除文档时连带清理标注与任务', () => {
    let s = createInitialState();
    s = reduce(s, { type: 'doc/imported', doc: makeDoc('a') });
    s = reduce(s, { type: 'marks/loaded', marks: [makeMark('m1', 'a')] });
    s = reduce(s, {
      type: 'tasks/loaded',
      tasks: [{ docId: 'a', bid: 'li-1', index: 0, checked: true }],
    });
    s = reduce(s, { type: 'doc/deleted', docId: 'a' });
    expect(s.docs).toHaveLength(0);
    expect(s.marks).toHaveLength(0);
    expect(s.tasks).toHaveLength(0);
  });

  it('删除当前打开的文档会关闭阅读器', () => {
    let s = createInitialState();
    s = reduce(s, { type: 'doc/imported', doc: makeDoc('a') });
    s = reduce(s, { type: 'doc/opened', docId: 'a' });
    s = reduce(s, { type: 'doc/deleted', docId: 'a' });
    expect(s.currentDocId).toBeNull();
  });

  it('打开文档进入 loading 并清空上一次渲染', () => {
    let s = createInitialState();
    s = reduce(s, {
      type: 'reader/ready',
      render: { html: '<p>x</p>', toc: [], blockCount: 1, blockTexts: new Map() },
    });
    s = reduce(s, { type: 'doc/opened', docId: 'a' });
    expect(s.readerStatus).toBe('loading');
    expect(s.render).toBeNull();
  });

  it('关闭文档回到 idle', () => {
    let s = createInitialState();
    s = reduce(s, { type: 'doc/opened', docId: 'a' });
    s = reduce(s, { type: 'doc/closed' });
    expect(s.currentDocId).toBeNull();
    expect(s.readerStatus).toBe('idle');
  });
});

describe('reduce — 标注', () => {
  it('添加标注', () => {
    let s = createInitialState();
    s = reduce(s, { type: 'mark/added', mark: makeMark('m1', 'a') });
    expect(s.marks).toHaveLength(1);
  });

  it('移除标注按 id 精确删除', () => {
    let s = createInitialState();
    s = reduce(s, { type: 'mark/added', mark: makeMark('m1', 'a') });
    s = reduce(s, { type: 'mark/added', mark: makeMark('m2', 'a') });
    s = reduce(s, { type: 'mark/removed', markId: 'm1' });
    expect(s.marks.map((m) => m.id)).toEqual(['m2']);
  });
});

describe('reduce — 任务勾选', () => {
  it('首次勾选插入新记录', () => {
    let s = createInitialState();
    s = reduce(s, {
      type: 'task/toggled',
      task: { docId: 'a', bid: 'li-1', index: 0, checked: true },
    });
    expect(s.tasks).toHaveLength(1);
    expect(s.tasks[0]?.checked).toBe(true);
  });

  it('再次勾选更新而非追加', () => {
    let s = createInitialState();
    s = reduce(s, { type: 'task/toggled', task: { docId: 'a', bid: 'li-1', index: 0, checked: true } });
    s = reduce(s, { type: 'task/toggled', task: { docId: 'a', bid: 'li-1', index: 0, checked: false } });
    expect(s.tasks).toHaveLength(1);
    expect(s.tasks[0]?.checked).toBe(false);
  });

  it('不同文档的同一 bid 互不影响', () => {
    let s = createInitialState();
    s = reduce(s, { type: 'task/toggled', task: { docId: 'a', bid: 'li-1', index: 0, checked: true } });
    s = reduce(s, { type: 'task/toggled', task: { docId: 'b', bid: 'li-1', index: 0, checked: false } });
    expect(s.tasks).toHaveLength(2);
  });
});

describe('reduce — 设置', () => {
  it('部分更新保留其他字段', () => {
    let s = createInitialState();
    s = reduce(s, { type: 'settings/changed', patch: { typeScale: 6 } });
    expect(s.settings.typeScale).toBe(6);
    expect(s.settings.lineScale).toBe(DEFAULT_SETTINGS.lineScale);
    expect(s.settings.theme).toBe(DEFAULT_SETTINGS.theme);
  });

  it('越界档位被 reducer 夹紧', () => {
    let s = createInitialState();
    s = reduce(s, { type: 'settings/changed', patch: { typeScale: 999 } });
    expect(s.settings.typeScale).toBe(7);
  });

  it('负数档位被夹到下限', () => {
    let s = createInitialState();
    s = reduce(s, { type: 'settings/changed', patch: { lineScale: -5 } });
    expect(s.settings.lineScale).toBe(1);
  });

  it('切换主题不改动字号', () => {
    let s = createInitialState();
    s = reduce(s, { type: 'settings/changed', patch: { typeScale: 5 } });
    s = reduce(s, { type: 'settings/changed', patch: { theme: 'night' } });
    expect(s.settings.typeScale).toBe(5);
    expect(s.settings.theme).toBe('night');
  });
});

describe('reduce — 面板开关', () => {
  it('打开面板', () => {
    const s = reduce(createInitialState(), { type: 'overlay/opened', overlay: 'toc' });
    expect(s.overlay).toBe('toc');
  });

  it('再次打开同一面板即关闭（toggle 语义）', () => {
    let s = createInitialState();
    s = reduce(s, { type: 'overlay/opened', overlay: 'toc' });
    s = reduce(s, { type: 'overlay/opened', overlay: 'toc' });
    expect(s.overlay).toBe('none');
  });
});

describe('reduce — 搜索', () => {
  it('保存查询与结果', () => {
    const s = reduce(createInitialState(), {
      type: 'search/queried',
      query: 'spect',
      results: [{ docId: 'a', bid: 'p-1', start: 0, end: 5, snippet: 'spect 词根' }],
    });
    expect(s.searchQuery).toBe('spect');
    expect(s.searchResults).toHaveLength(1);
  });
});

describe('reduce — 不可变性', () => {
  it('每次变更都产生新对象', () => {
    const s0 = createInitialState();
    const s1 = reduce(s0, { type: 'docs/loaded', docs: [makeDoc('a')] });
    expect(s1).not.toBe(s0);
    expect(s0.docs).toHaveLength(0);
  });

  it('未知 action 返回原状态引用（不崩溃）', () => {
    const s0 = createInitialState();
    const s1 = reduce(s0, { type: 'unknown/action' } as never);
    expect(s1).toBe(s0);
  });
});

describe('选择器', () => {
  const base: State = (() => {
    let s = createInitialState();
    s = reduce(s, { type: 'doc/imported', doc: makeDoc('a') });
    s = reduce(s, { type: 'doc/imported', doc: makeDoc('b') });
    s = reduce(s, { type: 'marks/loaded', marks: [makeMark('m1', 'a'), makeMark('m2', 'b')] });
    s = reduce(s, {
      type: 'tasks/loaded',
      tasks: [
        { docId: 'a', bid: 'li-1', index: 0, checked: true },
        { docId: 'b', bid: 'li-2', index: 0, checked: false },
      ],
    });
    return s;
  })();

  it('未打开文档时当前文档为 null', () => {
    expect(selectCurrentDoc(base)).toBeNull();
  });

  it('打开后能取到当前文档', () => {
    const s = reduce(base, { type: 'doc/opened', docId: 'a' });
    expect(selectCurrentDoc(s)?.id).toBe('a');
  });

  it('只返回当前文档的标注', () => {
    const s = reduce(base, { type: 'doc/opened', docId: 'a' });
    expect(selectCurrentMarks(s).map((m) => m.id)).toEqual(['m1']);
  });

  it('只返回当前文档的任务', () => {
    const s = reduce(base, { type: 'doc/opened', docId: 'b' });
    expect(selectCurrentTasks(s)).toHaveLength(1);
    expect(selectCurrentTasks(s)[0]?.docId).toBe('b');
  });
});
