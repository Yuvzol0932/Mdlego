// @vitest-environment jsdom
/**
 * 生词本 / 查词历史面板（阶段 E4）。
 * 验分段切换、词条与历史渲染、删除/清空回调与空态文案。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { LookupHistoryEntry, WordEntry } from '../core/types';
import { createWordbookSheet, type WordbookInput } from './wordbook';

function word(name: string, addedAt = 1): WordEntry {
  return { word: name, phonetic: `/${name}/`, translation: `${name} 的释义`, addedAt };
}

const WORDS = [word('inspect', 3), word('prospect', 2)];
const HISTORY: LookupHistoryEntry[] = [
  { word: 'inspect', at: new Date('2026-11-17T10:05:00').getTime() },
  { word: 'spect', at: new Date('2026-11-17T09:00:00').getTime() },
];

function render(input: Partial<WordbookInput> = {}) {
  const calls: string[] = [];
  const sheet = createWordbookSheet(
    { words: WORDS, history: HISTORY, tab: 'words', ...input },
    {
      removeWord: (w) => calls.push(`remove:${w}`),
      clearWords: () => calls.push('clear-words'),
      clearHistory: () => calls.push('clear-history'),
      switchTab: (tab) => calls.push(`tab:${tab}`),
    },
  );
  document.body.append(sheet.el);
  return { sheet, calls, root: document.body };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('生词本面板', () => {
  it('默认生词本分段：列出单词/音标/释义与数量', () => {
    render();
    expect(document.querySelectorAll('[data-testid="wordbook-item"]')).toHaveLength(2);
    expect(document.querySelector('[data-testid="wordbook-count"]')?.textContent).toContain('2');
    expect(document.body.textContent).toContain('inspect 的释义');
    expect(document.querySelector('[data-testid="wordbook-tab-words"]')?.getAttribute('aria-selected')).toBe('true');
  });

  it('点历史分段回调 switchTab；历史条目显示时间', () => {
    const { calls } = render();
    document.querySelector<HTMLElement>('[data-testid="wordbook-tab-history"]')?.click();
    expect(calls).toEqual(['tab:history']);
  });

  it('删除单词与清空回调', () => {
    const { calls } = render();
    document.querySelector<HTMLElement>('[data-testid="wordbook-remove"]')?.click();
    document.querySelector<HTMLElement>('[data-testid="wordbook-clear"]')?.click();
    expect(calls).toEqual(['remove:inspect', 'clear-words']);
  });

  it('空生词本显示空态，清空按钮隐藏', () => {
    render({ words: [] });
    expect(document.querySelector('[data-testid="wordbook-empty"]')?.hasAttribute('hidden')).toBe(false);
    expect((document.querySelector('[data-testid="wordbook-clear"]') as HTMLButtonElement).hidden).toBe(true);
  });

  it('历史分段：列出查词记录并支持清空历史', () => {
    const { calls } = render({ tab: 'history' });
    const items = document.querySelectorAll('[data-testid="history-item"]');
    expect(items).toHaveLength(2);
    expect(items[0]?.getAttribute('data-word')).toBe('inspect');
    document.querySelector<HTMLElement>('[data-testid="wordbook-clear"]')?.click();
    expect(calls).toEqual(['clear-history']);
  });
});
