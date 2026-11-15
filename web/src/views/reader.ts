/**
 * 阅读器视图。
 *
 * 只负责：把已渲染的 HTML 放进 DOM、把任务勾选状态映射到复选框、
 * 派发打开文档 / 目录 / 搜索 / 返回等 intent。
 * 不负责解析（core）、不负责存储（data）、不负责滚动监听（main 层）。
 */

import type { State, TaskState } from '../core/types';
import { el, icon, type ViewDeps } from './app';
import { bindLongPress } from './lookup';

/** 取出当前文档的任务状态。 */
function tasksFor(state: State): readonly TaskState[] {
  if (state.currentDocId === null) return [];
  return state.tasks.filter((t) => t.docId === state.currentDocId);
}

/** 把已保存的勾选状态套用到 DOM 上。 */
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

/** 绑定复选框点击。 */
function bindTaskToggles(article: HTMLElement, state: State, deps: ViewDeps): void {
  article.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.classList.contains('task-box')) return;

    const bid = target.getAttribute('data-task-bid');
    if (bid === null || state.currentDocId === null) return;

    deps.dispatch({
      type: 'task/toggled',
      task: { docId: state.currentDocId, bid, index: 0, checked: target.checked },
    });
  });
}

/** 底部工具栏：目录 / 搜索 / 返回书架。 */
function toolbar(state: State, deps: ViewDeps): HTMLElement {
  return el(
    'nav',
    { class: 'reader-bar', 'data-testid': 'reader-bar', 'aria-label': '阅读工具' },
    el('button', {
      class: 'reader-bar__btn',
      type: 'button',
      'data-testid': 'back-to-shelf',
      'aria-label': '返回书架',
      title: '返回书架',
      onclick: () => deps.dispatch({ type: 'doc/closed' }),
    }, icon('back'), el('span', { text: '书架' })),
    el('button', {
      class: 'reader-bar__btn',
      type: 'button',
      'data-testid': 'open-toc',
      'aria-label': '目录',
      title: '目录',
      onclick: () => deps.openToc(),
    }, icon('list'), el('span', { text: '目录' })),
    el('button', {
      class: 'reader-bar__btn',
      type: 'button',
      'data-testid': 'open-search',
      'aria-label': '搜索',
      title: '搜索',
      onclick: () => deps.openSearch(),
    }, icon('search'), el('span', { text: '搜索' })),
    el('a', {
      class: 'reader-bar__btn',
      href: '#/settings',
      'data-testid': 'open-settings',
      'aria-label': '设置',
      title: '设置',
    }, icon('settings'), el('span', { text: '设置' })),
  );
}

/** 渲染阅读页。 */
export function renderReader(state: State, deps: ViewDeps): HTMLElement {
  const doc = state.docs.find((d) => d.id === state.currentDocId) ?? null;
  const title = doc?.title ?? '墨读';

  if (state.readerStatus === 'error') {
    return el(
      'div',
      { class: 'shell', 'data-testid': 'shell' },
      el('header', { class: 'appbar' },
        el('h1', { class: 'appbar__title', 'data-testid': 'app-title', text: title })),
      el('main', { class: 'main' },
        el('div', {
          class: 'shelf__empty',
          'data-testid': 'render-error',
          text: `无法显示这篇文档：${state.readerError ?? '未知原因'}`,
        })),
    );
  }

  const article = el('article', { class: 'article', 'data-testid': 'article' });
  if (state.render !== null) {
    article.innerHTML = state.render.html;
    applyTaskStates(article, tasksFor(state));
    bindTaskToggles(article, state, deps);
    // 设置里的「长按查词」关掉时，整条手势链都不挂：长按完全无反应（方案 §6.3 第 12 张截图）。
    // 关的是绑定而不是每次长按判一次状态 —— 关掉后连定时器都不存在，才算真「无反应」。
    if (state.settings.lookupEnabled) bindLongPress(article);
  }

  return el(
    'div',
    { class: 'shell', 'data-testid': 'shell' },
    el(
      'header',
      { class: 'appbar' },
      el('button', {
        class: 'icon-btn',
        type: 'button',
        'data-testid': 'back-to-shelf-top',
        'aria-label': '返回书架',
        title: '返回书架',
        onclick: () => deps.dispatch({ type: 'doc/closed' }),
      }, icon('back')),
      el('h1', { class: 'appbar__title', 'data-testid': 'app-title', text: title }),
      el('span', { class: 'appbar__spacer', 'aria-hidden': 'true' }),
    ),
    el('main', { class: 'main main--reader' }, article),
    toolbar(state, deps),
  );
}
