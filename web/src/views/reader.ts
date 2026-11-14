/**
 * 阅读器视图。
 *
 * 只负责：把已渲染的 HTML 放进 DOM、把任务勾选状态映射到复选框。
 * 不负责解析（core 负责）、不负责存储（data 负责）。
 */

import type { State, TaskState } from '../core/types';
import { el, icon, type ViewDeps } from './app';

/** 从二进制渲染结果里取出当前文档的任务状态。 */
function tasksFor(state: State): readonly TaskState[] {
  if (state.currentDocId === null) return [];
  return state.tasks.filter((t) => t.docId === state.currentDocId);
}

/**
 * 把已保存的勾选状态套用到 DOM 上。
 *
 * 注意：复选框是渲染时生成的，勾选状态存在 App 内（不改原文）。
 * 因此每次重绘都要重新套一遍，这是唯一需要"增量补丁"的地方。
 */
function applyTaskStates(article: HTMLElement, tasks: readonly TaskState[]): void {
  const boxes = article.querySelectorAll<HTMLInputElement>('.task-box');
  for (const box of boxes) {
    const bid = box.getAttribute('data-task-bid');
    if (bid === null) continue;
    const saved = tasks.find((t) => t.bid === bid);
    const checked = saved?.checked ?? box.hasAttribute('checked');
    box.checked = checked;
    box.setAttribute('data-task-checked', checked ? '1' : '0');
    const li = box.closest('li');
    if (li !== null) li.setAttribute('data-task-checked', checked ? '1' : '0');
  }
}

/** 绑定复选框点击：只派发 action，不直接改存储。 */
function bindTaskToggles(article: HTMLElement, state: State, deps: ViewDeps): void {
  article.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.classList.contains('task-box')) return;

    const bid = target.getAttribute('data-task-bid');
    if (bid === null || state.currentDocId === null) return;

    deps.dispatch({
      type: 'task/toggled',
      task: {
        docId: state.currentDocId,
        bid,
        index: 0,
        checked: target.checked,
      },
    });
  });
}

/** 渲染阅读页。 */
export function renderReader(state: State, deps: ViewDeps): HTMLElement {
  const doc = state.docs.find((d) => d.id === state.currentDocId) ?? null;

  // 顶栏只有一个入口：设置。
  // 字号调节属于排版设置，合并进设置页，不再单独占一个「字号」按钮 ——
  // 两个汉字按钮并排太直白，也把同一类操作拆到了两处。
  const actions: Node[] = [
    el('a', {
      class: 'icon-btn',
      href: '#/settings',
      'data-testid': 'open-settings',
      'aria-label': '设置',
      title: '设置',
    }, icon('settings')),
  ];

  const title = doc?.title ?? '墨读';

  // 渲染失败时给出明确原因，而不是白屏
  if (state.readerStatus === 'error') {
    return el(
      'div',
      { class: 'shell', 'data-testid': 'shell' },
      el(
        'header',
        { class: 'appbar' },
        el('h1', { class: 'appbar__title', 'data-testid': 'app-title', text: title }),
        ...actions,
      ),
      el(
        'main',
        { class: 'main' },
        el('div', {
          class: 'shelf__empty',
          'data-testid': 'render-error',
          text: `无法显示这篇文档：${state.readerError ?? '未知原因'}`,
        }),
      ),
    );
  }

  const article = el('article', { class: 'article', 'data-testid': 'article' });

  if (state.render !== null) {
    // 一次性写入，避免逐块插入造成多次重排
    article.innerHTML = state.render.html;
    applyTaskStates(article, tasksFor(state));
    bindTaskToggles(article, state, deps);
  }

  return el(
    'div',
    { class: 'shell', 'data-testid': 'shell' },
    el(
      'header',
      { class: 'appbar' },
      el('h1', { class: 'appbar__title', 'data-testid': 'app-title', text: title }),
      ...actions,
    ),
    el('main', { class: 'main main--reader' }, article),
  );
}
