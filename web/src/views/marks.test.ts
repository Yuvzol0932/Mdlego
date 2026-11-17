// @vitest-environment jsdom
/**
 * 批注列表面板（阶段 E2）：按块顺序、失效标记、删除/重挂/导出回调。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mark } from '../core/types';
import { createMarksSheet, type MarksInput } from './marks';

function mark(id: string, patch: Partial<Mark> = {}): Mark {
  return {
    id,
    docId: 'd1',
    anchor: { bid: 'p-1', start: 0, end: 5, quote: `原文 ${id}`, prefix: '', suffix: '' },
    type: 'highlight',
    color: 'yellow',
    note: null,
    createdAt: 1,
    ...patch,
  };
}

function render(input: MarksInput) {
  const calls: Array<[string, string]> = [];
  const sheet = createMarksSheet(input, {
    jump: () => calls.push(['jump', '']),
    remove: (id) => calls.push(['remove', id]),
    reanchor: (id) => calls.push(['reanchor', id]),
    exportMarkdown: () => calls.push(['export', '']),
  });
  document.body.append(sheet.el);
  return { sheet, calls };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

const BLOCKS = new Map([
  ['p-1', 'AAAAA'],
  ['p-2', 'BBBBB'],
]);

describe('批注列表', () => {
  it('按块顺序列出，显示类型与备注', () => {
    const input: MarksInput = {
      title: '文档',
      marks: [mark('b', { anchor: { bid: 'p-2', start: 0, end: 5, quote: '后面', prefix: '', suffix: '' } }), mark('a')],
      orphans: new Set(),
      blockTexts: BLOCKS,
    };
    render(input);
    const rows = document.querySelectorAll('[data-testid="mark-item"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute('data-mark-id')).toBe('a');
    expect(rows[0]?.textContent).toContain('黄色高亮');
  });

  it('失效标注显示「失效」并给「重新挂载」入口', () => {
    const { calls } = render({
      title: '文档',
      marks: [mark('gone')],
      orphans: new Set(['gone']),
      blockTexts: BLOCKS,
    });
    expect(document.querySelector('[data-testid="mark-item"]')?.textContent).toContain('失效');
    document.querySelector<HTMLElement>('[data-testid="mark-reanchor-item"]')?.click();
    expect(calls).toEqual([['reanchor', 'gone']]);
  });

  it('删除与导出回调', () => {
    const { calls } = render({ title: '文档', marks: [mark('a')], orphans: new Set(), blockTexts: BLOCKS });
    document.querySelector<HTMLElement>('[data-testid="mark-remove"]')?.click();
    document.querySelector<HTMLElement>('[data-testid="marks-export"]')?.click();
    expect(calls).toEqual([['remove', 'a'], ['export', '']]);
  });

  it('没有标注时显示空态', () => {
    render({ title: '文档', marks: [], orphans: new Set(), blockTexts: BLOCKS });
    expect(document.querySelector('[data-testid="marks-empty"]')?.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('[data-testid="marks-count"]')?.textContent).toContain('共 0 条');
  });
});
