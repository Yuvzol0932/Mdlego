/**
 * 阅读器视图。
 *
 * 只负责：把已渲染的 HTML 放进 DOM、把任务勾选状态映射到复选框、
 * 派发打开文档 / 目录 / 搜索 / 返回等 intent。
 * 不负责解析（core）、不负责存储（data）、不负责滚动监听（main 层）。
 *
 * 局部更新（阶段 A1）：页面外壳与 <article> 只在下列输入变化时才重建正文：
 *   - 渲染结果（RenderResult 对象）换了，即换了文档或文档内容
 *   - 「长按查词」开关变了（监听挂在节点上，无法摘除，只能换节点）
 * 滚动、勾选、进度保存、开关浮层、改字号字体（走根节点属性 + CSS）都不重建正文。
 */

import type { RenderResult, State, TaskState } from '../core/types';
import { el, icon, type PageView, type ViewDeps } from './app';
import { bindLongPress } from './lookup';

/** 取出当前文档的任务状态。 */
function tasksFor(state: State): readonly TaskState[] {
  if (state.currentDocId === null) return [];
  return state.tasks.filter((t) => t.docId === state.currentDocId);
}

/** 把已保存的勾选状态套用到 DOM 上（原地改属性，不动节点结构）。 */
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

/** 绑定复选框点击。docId 取自最新状态，不捕获过期闭包。 */
function bindTaskToggles(article: HTMLElement, deps: ViewDeps): void {
  article.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!target.classList.contains('task-box')) return;

    const bid = target.getAttribute('data-task-bid');
    const docId = deps.getState().currentDocId;
    if (bid === null || docId === null) return;

    deps.dispatch({
      type: 'task/toggled',
      task: { docId, bid, index: 0, checked: target.checked },
    });
  });
}

/** 底部工具栏：目录 / 搜索 / 返回书架 / 设置。 */
function toolbar(deps: ViewDeps): HTMLElement {
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
    el('button', {
      class: 'reader-bar__btn',
      type: 'button',
      'data-testid': 'open-settings',
      'aria-label': '设置',
      title: '设置',
      onclick: () => deps.dispatch({ type: 'nav/push', page: { kind: 'tab', tab: 'settings' } }),
    }, icon('settings'), el('span', { text: '设置' })),
  );
}

/**
 * 创建阅读页。节点只创建一次，之后 update() 做局部更新。
 * 正文重建次数记在 <article data-gen>，供测试与排查「是否被重建」使用。
 */
export function createReaderPage(initial: State, deps: ViewDeps): PageView {
  const title = el('h1', { class: 'appbar__title', 'data-testid': 'app-title', text: '墨读' });
  const main = el('main', { class: 'main main--reader' });
  const page = el(
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
      title,
      el('span', { class: 'appbar__spacer', 'aria-hidden': 'true' }),
    ),
    main,
    toolbar(deps),
  );

  let generation = 0;
  let builtRender: RenderResult | null = null;
  let builtLookup: boolean | null = null;
  let article: HTMLElement | null = null;
  let errorShown: string | null = null;
  let lastTasks: readonly TaskState[] | null = null;

  /** 新建一个空 article 并挂到 main。 */
  function freshArticle(lookup: boolean): HTMLElement {
    const node = el('article', { class: 'article', 'data-testid': 'article' });
    generation += 1;
    node.setAttribute('data-gen', String(generation));
    bindTaskToggles(node, deps);
    // 设置里的「长按查词」关掉时，整条手势链都不挂：长按完全无反应（方案 §6.3 第 12 张截图）。
    // 关的是绑定而不是每次长按判一次状态 —— 关掉后连定时器都不存在，才算真「无反应」。
    if (lookup) bindLongPress(node);
    article = node;
    builtLookup = lookup;
    main.replaceChildren(node);
    return node;
  }

  function update(state: State): void {
    const doc = state.docs.find((d) => d.id === state.currentDocId) ?? null;
    const nextTitle = doc?.title ?? '墨读';
    if (title.textContent !== nextTitle) title.textContent = nextTitle;

    if (state.readerStatus === 'error') {
      const message = `无法显示这篇文档：${state.readerError ?? '未知原因'}`;
      if (errorShown !== message) {
        errorShown = message;
        article = null;
        builtRender = null;
        main.replaceChildren(el('div', { class: 'shelf__empty', 'data-testid': 'render-error', text: message }));
      }
      return;
    }
    errorShown = null;

    const lookup = state.settings.lookupEnabled;
    const needNode = article === null || builtLookup !== lookup || builtRender !== state.render;
    if (needNode) {
      const node = freshArticle(lookup);
      if (state.render !== null) node.innerHTML = state.render.html;
      builtRender = state.render;
      lastTasks = null; // 新节点必须套一遍勾选状态
    }

    const tasks = tasksFor(state);
    if (article !== null && (lastTasks === null || !sameTasks(lastTasks, tasks))) {
      applyTaskStates(article, tasks);
      lastTasks = tasks;
    }
  }

  update(initial);
  return { el: page, update };
}

/** 两组任务状态是否逐项相同（引用相同的条目视为相同）。 */
function sameTasks(a: readonly TaskState[], b: readonly TaskState[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
