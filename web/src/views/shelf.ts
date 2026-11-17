/**
 * 书架视图 —— 文档列表。
 *
 * 只做：读 state → 写 DOM → 派发 intent。
 * 导入的实际 IO 由 main.ts 编排（视图拿到的只有 dispatch）。
 */

import type { Doc, State } from '../core/types';
import { el, icon, type ViewDeps } from './app';

/** 相对时间：今天 / 昨天 / N 天前 / 具体日期。 */
function relativeTime(ms: number | null): string {
  if (ms === null) return '未读';
  const now = Date.now();
  const diff = now - ms;
  const day = 86_400_000;
  if (diff < 0) return '刚刚';
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < day * 2) return '昨天';
  if (diff < day * 7) return `${Math.floor(diff / day)} 天前`;
  const d = new Date(ms);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

/** 正文摘要：取首个非空、非标题行，截到 60 字。 */
function excerpt(doc: Doc): string {
  const lines = doc.text.split(/\r\n|\r|\n/);
  for (const line of lines) {
    const t = line.trim();
    if (t.length === 0 || /^#{1,6}\s/.test(t) || /^[-*+]\s*\[[ xX]\]/.test(t)) continue;
    const plain = t.replace(/[*_`>#]/g, '').trim();
    if (plain.length > 0) return plain.slice(0, 60) + (plain.length > 60 ? '…' : '');
  }
  return '（空文档）';
}

/** 单篇文档卡片。 */
function docCard(doc: Doc, deps: ViewDeps): HTMLElement {
  const card = el('button', {
    class: 'doc-item',
    type: 'button',
    'data-testid': 'doc-item',
    'data-doc-id': doc.id,
    onclick: () => deps.dispatch({ type: 'doc/opened', docId: doc.id }),
  });

  card.append(
    el('span', { class: 'doc-item__title', text: doc.title }),
    el('span', { class: 'doc-item__excerpt', text: excerpt(doc) }),
    el(
      'span',
      { class: 'doc-item__meta' },
      el('span', { text: relativeTime(doc.lastReadAt) }),
      el('span', { text: `${Math.max(1, Math.round(doc.text.length / 500))} 分钟读完` }),
    ),
  );

  return card;
}

/** 空书架。 */
function emptyShelf(deps: ViewDeps): HTMLElement {
  return el(
    'div',
    { class: 'shelf__empty', 'data-testid': 'shelf-empty' },
    el('div', { class: 'shelf__empty-mark', text: '墨' }),
    el('div', { class: 'shelf__empty-title', text: '书架空着' }),
    el('div', {
      class: 'shelf__empty-hint',
      text: '点右下角导入 .md / .txt，或在文件管理器里把笔记分享到墨读。',
    }),
    el('button', {
      class: 'btn btn--accent shelf__empty-action',
      type: 'button',
      'data-testid': 'empty-import',
      text: '导入文档',
      onclick: () => deps.requestImport(),
    }),
  );
}

/** 渲染书架页。 */
export function renderShelf(state: State, deps: ViewDeps): HTMLElement {
  const docs = [...state.docs].sort((a, b) => {
    const at = a.lastReadAt ?? a.importedAt;
    const bt = b.lastReadAt ?? b.importedAt;
    return bt - at;
  });

  const list = el('div', { class: 'shelf', 'data-testid': 'shelf' });
  if (docs.length === 0) {
    list.append(emptyShelf(deps));
  } else {
    for (const doc of docs) list.append(docCard(doc, deps));
  }

  const importBtn = el('button', {
    class: 'fab',
    type: 'button',
    'data-testid': 'import-file',
    'aria-label': '导入文档',
    title: '导入文档',
    onclick: () => deps.requestImport(),
  }, icon('plus'));

  return el(
    'div',
    { class: 'shell', 'data-testid': 'shell' },
    el(
      'header',
      { class: 'appbar appbar--center' },
      el('span', { class: 'appbar__spacer', 'aria-hidden': 'true' }),
      el('h1', { class: 'appbar__title', 'data-testid': 'app-title', text: '墨读' }),
      el('button', {
        class: 'icon-btn',
        type: 'button',
        onclick: () => deps.dispatch({ type: 'nav/push', page: { kind: 'tab', tab: 'settings' } }),
        'data-testid': 'open-settings',
        'aria-label': '设置',
        title: '设置',
      }, icon('settings')),
    ),
    el(
      'main',
      { class: 'main' },
      list,
      el('div', {
        class: 'shelf__count',
        'data-testid': 'shelf-count',
        text: docs.length > 0 ? `共 ${docs.length} 篇` : '',
      }),
    ),
    importBtn,
  );
}
