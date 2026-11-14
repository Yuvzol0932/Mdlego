/**
 * 视图层总入口。
 *
 * 只做三件事：读 state → 写 DOM → 派发 action。
 * 不持有业务状态、不直接读写存储。
 */

import type { RenderResult, Settings, State, StateAction } from '../core/types';
import { renderReader } from './reader';
import { renderSettings } from './settings';

/** 视图依赖注入：避免视图层直接 import data/。 */
export interface ViewDeps {
  dispatch: (action: StateAction) => void;
  appVersion: string;
  buildId: string;
  sample: string;
  renderMarkdown: (source: string) => RenderResult;
}

/** 极简元素创建工具。 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | ((event: Event) => void)> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text' && typeof value === 'string') node.textContent = value;
    else if (key === 'class' && typeof value === 'string') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2), value);
    } else if (typeof value === 'string') node.setAttribute(key, value);
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** 路由：目前只有书架/阅读 与 设置。 */
export type Route = 'shelf' | 'settings';

/** 从 hash 读当前路由。 */
export function readRoute(): Route {
  return location.hash === '#/settings' ? 'settings' : 'shelf';
}

/** 应用外壳：顶栏 + 主内容。 */
function shell(title: string, actions: Node[], content: Node): HTMLElement {
  return el(
    'div',
    { class: 'shell', 'data-testid': 'shell' },
    el(
      'header',
      { class: 'appbar' },
      el('h1', { class: 'appbar__title', 'data-testid': 'app-title', text: title }),
      ...actions,
    ),
    content,
  );
}

/** 渲染整个应用。 */
export function renderApp(root: HTMLElement, state: State, deps: ViewDeps): void {
  const route = readRoute();

  // 优先级：显式打开排版浮层 > 路由到设置页 > 阅读页
  // 注意 hash 路由优先于浮层状态：用户如果主动跳到 #/settings，
  // 应该看到完整设置（含主题），而不是被残留的 font 浮层挡住。
  if (route === 'settings') {
    root.replaceChildren(renderSettings(state, deps, { fontOnly: false }));
    return;
  }

  if (state.overlay === 'font') {
    root.replaceChildren(renderSettings(state, deps, { fontOnly: true }));
    return;
  }

  root.replaceChildren(renderReader(state, deps));
}

/** 监听 hash 变化，触发重渲染。 */
export function watchRoute(onChange: () => void): void {
  window.addEventListener('hashchange', onChange);
}

/** 供设置页使用的类型别名。 */
export type { Settings };
