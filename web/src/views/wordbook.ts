/**
 * 生词本 / 查词历史面板（阶段 E4）。
 *
 * 一个浮层，两个分段：生词本（可删除、可清空）与查词历史（可清空）。
 * 只读 state 数据、只发回调；持久化与去重规则在 main + core/vocabulary.ts。
 */

import type { LookupHistoryEntry, WordEntry } from '../core/types';
import { el, icon } from './app';

export type WordbookTab = 'words' | 'history';

export interface WordbookInput {
  readonly words: readonly WordEntry[];
  readonly history: readonly LookupHistoryEntry[];
  readonly tab: WordbookTab;
}

export interface WordbookHandlers {
  readonly removeWord: (word: string) => void;
  readonly clearWords: () => void;
  readonly clearHistory: () => void;
  readonly switchTab: (tab: WordbookTab) => void;
}

export interface WordbookSheet {
  readonly el: HTMLElement;
  update(next: WordbookInput): void;
}

/** 历史时间：月/日 时:分（本地时区），不引入额外格式化库。 */
function formatAt(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function createWordbookSheet(input: WordbookInput, handlers: WordbookHandlers): WordbookSheet {
  const list = el('div', { class: 'wordbook-list', 'data-testid': 'wordbook-list' });
  const empty = el('p', { class: 'wordbook-empty', 'data-testid': 'wordbook-empty' });
  const count = el('span', { class: 'sheet-panel__hint', 'data-testid': 'wordbook-count' });
  const tabs = el('div', { class: 'wordbook-tabs', role: 'tablist', 'aria-label': '生词本视图' });
  const clear = el('button', {
    class: 'ui-btn ui-btn--ghost ui-press',
    type: 'button',
    'data-testid': 'wordbook-clear',
    text: '清空',
  });

  const panel = el(
    'section',
    { class: 'sheet-panel glass', 'data-testid': 'wordbook-sheet', role: 'dialog', 'aria-label': '生词本' },
    el('span', { class: 'sheet-panel__handle', 'aria-hidden': 'true' }),
    el(
      'header',
      { class: 'sheet-panel__head' },
      el('h2', { class: 'sheet-panel__title', text: '生词本' }),
      count,
      clear,
    ),
    tabs,
    list,
    empty,
  );

  let current = input;

  function paint(): void {
    // 分段
    tabs.replaceChildren();
    const segments: Array<{ tab: WordbookTab; label: string; total: number; testId: string }> = [
      { tab: 'words', label: '生词本', total: current.words.length, testId: 'wordbook-tab-words' },
      { tab: 'history', label: '查词历史', total: current.history.length, testId: 'wordbook-tab-history' },
    ];
    for (const segment of segments) {
      const on = current.tab === segment.tab;
      const btn = el('button', {
        class: on ? 'wordbook-tab wordbook-tab--on ui-press' : 'wordbook-tab ui-press',
        type: 'button',
        role: 'tab',
        'aria-selected': on ? 'true' : 'false',
        'data-testid': segment.testId,
        text: `${segment.label} ${segment.total}`,
      });
      btn.addEventListener('click', () => handlers.switchTab(segment.tab));
      tabs.append(btn);
    }

    list.replaceChildren();
    empty.hidden = true;
    empty.textContent = '';

    if (current.tab === 'words') {
      count.textContent = `共 ${current.words.length} 个`;
      clear.hidden = current.words.length === 0;
      if (current.words.length === 0) {
        empty.hidden = false;
        empty.textContent = '还没有生词。查词时点「生词本」就能收藏。';
        return;
      }
      for (const word of current.words) list.append(wordRow(word));
      return;
    }

    count.textContent = `共 ${current.history.length} 条`;
    clear.hidden = current.history.length === 0;
    if (current.history.length === 0) {
      empty.hidden = false;
      empty.textContent = '还没有查词记录。在正文里查一个词就会出现在这里。';
      return;
    }
    for (const item of current.history) list.append(historyRow(item));
  }

  function wordRow(word: WordEntry): HTMLElement {
    const remove = el('button', {
      class: 'wordbook-item__remove',
      type: 'button',
      'data-testid': 'wordbook-remove',
      'aria-label': `删除 ${word.word}`,
      title: '删除',
    }, icon('trash'));
    remove.addEventListener('click', () => handlers.removeWord(word.word));
    return el(
      'div',
      { class: 'wordbook-item', 'data-testid': 'wordbook-item', 'data-word': word.word },
      el(
        'div',
        { class: 'wordbook-item__text' },
        el(
          'div',
          { class: 'wordbook-item__head' },
          el('span', { class: 'wordbook-item__word', text: word.word }),
          word.phonetic.length > 0 ? el('span', { class: 'wordbook-item__phonetic', text: word.phonetic }) : el('span'),
        ),
        el('p', { class: 'wordbook-item__translation', text: word.translation }),
      ),
      remove,
    );
  }

  function historyRow(item: LookupHistoryEntry): HTMLElement {
    return el(
      'div',
      { class: 'wordbook-item', 'data-testid': 'history-item', 'data-word': item.word },
      el(
        'div',
        { class: 'wordbook-item__text' },
        el(
          'div',
          { class: 'wordbook-item__head' },
          el('span', { class: 'wordbook-item__word', text: item.word }),
          el('span', { class: 'wordbook-item__time', text: formatAt(item.at) }),
        ),
      ),
    );
  }

  clear.addEventListener('click', () => {
    if (current.tab === 'words') handlers.clearWords();
    else handlers.clearHistory();
  });

  paint();
  return {
    el: panel,
    update(next: WordbookInput) {
      current = next;
      paint();
    },
  };
}
