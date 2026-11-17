// @vitest-environment jsdom
/**
 * 备注面板（阶段 E2）：原文预览、字数计数、保存/取消回调。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNoteSheet } from './note';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('备注面板', () => {
  it('新建模式：预览原文，输入后保存去掉首尾空白', () => {
    const saved: string[] = [];
    const sheet = createNoteSheet(
      { docId: 'd1', mode: 'new', quote: '被选的原文 片段', initial: '' },
      { save: (text) => saved.push(text), cancel: () => undefined },
    );
    document.body.append(sheet.el);
    expect(document.querySelector('[data-testid="note-quote"]')?.textContent).toContain('被选的原文');
    const input = document.querySelector<HTMLTextAreaElement>('[data-testid="note-input"]') as HTMLTextAreaElement;
    input.value = '  我的批注  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector<HTMLElement>('[data-testid="note-save"]')?.click();
    expect(saved).toEqual(['我的批注']);
  });

  it('编辑模式：带入旧备注与按钮文案，取消回调', () => {
    const cancel = vi.fn();
    const sheet = createNoteSheet(
      { docId: 'd1', mode: 'edit', markId: 'm1', quote: '原文', initial: '旧备注' },
      { save: () => undefined, cancel },
    );
    document.body.append(sheet.el);
    expect((document.querySelector('[data-testid="note-input"]') as HTMLTextAreaElement).value).toBe('旧备注');
    expect(document.querySelector('[data-testid="note-save"]')?.textContent).toBe('保存修改');
    document.querySelector<HTMLElement>('[data-testid="note-cancel"]')?.click();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
