/**
 * 批注列表面板（阶段 E2）。
 *
 * 内容：当前文档的标注，按块顺序列出（类型、原文、备注）。
 * 动作：点击跳转并高亮；删除；失效标注可「重新挂载」；顶部「导出」Markdown。
 *
 * 列表只读数据、只发回调；排序/标签/失效判断复用 core/marks.ts，
 * 导出文本在 main 里生成（按需调用 marksToMarkdown）。
 */

import { markLabel, orderMarks } from '../core/marks';
import type { Mark } from '../core/types';
import { el, icon } from './app';

export interface MarksInput {
  readonly title: string;
  readonly marks: readonly Mark[];
  /** 重定位失败的标注 id（列表标「失效」并给重新挂载入口）。 */
  readonly orphans: ReadonlySet<string>;
  readonly blockTexts: ReadonlyMap<string, string>;
}

export interface MarksHandlers {
  readonly jump: (mark: Mark) => void;
  readonly remove: (markId: string) => void;
  readonly reanchor: (markId: string) => void;
  readonly exportMarkdown: () => void;
}

export interface MarksSheet {
  readonly el: HTMLElement;
  update(next: MarksInput): void;
}

export function createMarksSheet(input: MarksInput, handlers: MarksHandlers): MarksSheet {
  const list = el('div', { class: 'marks-list', 'data-testid': 'marks-list' });
  const empty = el('p', { class: 'marks-empty', 'data-testid': 'marks-empty', text: '这篇文档还没有批注。选中文字后点「批注」即可添加。' });
  const count = el('span', { class: 'sheet-panel__hint', 'data-testid': 'marks-count' });

  const exportBtn = el('button', {
    class: 'ui-btn ui-press',
    type: 'button',
    'data-testid': 'marks-export',
    text: '导出',
  });
  exportBtn.addEventListener('click', () => handlers.exportMarkdown());

  const panel = el(
    'section',
    { class: 'sheet-panel glass', 'data-testid': 'marks-sheet', role: 'dialog', 'aria-label': '批注' },
    el('span', { class: 'sheet-panel__handle', 'aria-hidden': 'true' }),
    el(
      'header',
      { class: 'sheet-panel__head' },
      el('h2', { class: 'sheet-panel__title', text: '批注' }),
      count,
      exportBtn,
    ),
    list,
    empty,
  );

  let current = input;

  function paint(): void {
    list.replaceChildren();
    const ordered = orderMarks(current.marks, current.blockTexts);
    count.textContent = `共 ${ordered.length} 条`;
    empty.hidden = ordered.length > 0;
    for (const mark of ordered) {
      list.append(markRow(mark, current.orphans.has(mark.id)));
    }
  }

  function markRow(mark: Mark, orphaned: boolean): HTMLElement {
    const label = markLabel(mark.type, mark.color);
    const row = el('div', {
      class: orphaned ? 'mark-row mark-row--orphan' : 'mark-row',
      'data-testid': 'mark-item',
      'data-mark-id': mark.id,
    });

    const jump = el(
      'button',
      {
        class: 'mark-row__main',
        type: 'button',
        'data-testid': 'mark-jump',
        'aria-label': `跳到这条${label}`,
      },
      el(
        'span',
        { class: 'mark-row__head' },
        el('span', { class: `mark-badge mark-badge--${mark.type}`, text: label }),
        orphaned ? el('span', { class: 'mark-badge mark-badge--orphan', text: '失效' }) : el('span'),
      ),
      el('span', { class: 'mark-row__quote', text: mark.anchor.quote || '（无原文）' }),
      mark.note !== null && mark.note.trim().length > 0
        ? el('span', { class: 'mark-row__note', text: mark.note })
        : el('span'),
    );
    jump.addEventListener('click', () => handlers.jump(mark));
    row.append(jump);

    const actions = el('div', { class: 'mark-row__actions' });
    if (orphaned) {
      const reanchor = el('button', {
        class: 'mark-row__action',
        type: 'button',
        'data-testid': 'mark-reanchor-item',
        text: '重新挂载',
      });
      reanchor.addEventListener('click', () => handlers.reanchor(mark.id));
      actions.append(reanchor);
    }
    const remove = el('button', {
      class: 'mark-row__action mark-row__action--danger',
      type: 'button',
      'data-testid': 'mark-remove',
      'aria-label': '删除标注',
      title: '删除标注',
    }, icon('trash'));
    remove.addEventListener('click', () => handlers.remove(mark.id));
    actions.append(remove);
    row.append(actions);
    return row;
  }

  paint();
  return {
    el: panel,
    update(next: MarksInput) {
      current = next;
      paint();
    },
  };
}
