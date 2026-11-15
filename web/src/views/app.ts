/**
 * 视图层总入口。
 *
 * 只做三件事：读 state → 写 DOM → 派发 action。
 * 不持有业务状态、不直接读写存储。
 */

import type { RenderResult, Settings, State, StateAction } from '../core/types';
import { renderReader } from './reader';
import { renderShelf } from './shelf';
import { renderSettings } from './settings';

/** 视图依赖注入：避免视图层直接 import data/。 */
export interface ViewDeps {
  dispatch: (action: StateAction) => void;
  /** 请求导入文件（IO 由 main.ts 编排，视图不碰原生/文件系统）。 */
  requestImport: () => void;
  /** 请求打开目录抽屉。 */
  openToc: () => void;
  /** 请求单篇搜索。 */
  openSearch: () => void;
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

  // 有当前文档就进阅读器，否则回书架
  if (state.currentDocId !== null) {
    root.replaceChildren(renderReader(state, deps));
  } else {
    root.replaceChildren(renderShelf(state, deps));
  }
}

/** 监听 hash 变化，触发重渲染。 */
export function watchRoute(onChange: () => void): void {
  window.addEventListener('hashchange', onChange);
}

/** 供设置页使用的类型别名。 */
export type { Settings };

/**
 * 内联 SVG 图标。
 *
 * 只用一套描边参数（1.75px、圆头圆角、currentColor），保证图标与
 * 杂志风的细线条一致；不用 emoji，也不依赖任何图标字体或外部资源。
 */
export type IconName = 'settings' | 'back' | 'type' | 'plus' | 'list' | 'search' | 'close' | 'trash';

const ICON_PATHS: Record<IconName, string> = {
  // 齿轮：外圈八齿 + 内圆
  settings:
    'M12 15.25a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5Z' +
    'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06' +
    'a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09' +
    'A1.7 1.7 0 0 0 8.98 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83' +
    'l.06-.06A1.7 1.7 0 0 0 4.62 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09' +
    'A1.7 1.7 0 0 0 4.7 8.98a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83' +
    'l.06.06A1.7 1.7 0 0 0 9 4.62a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09' +
    'A1.7 1.7 0 0 0 15.02 4.7a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83' +
    'l-.06.06A1.7 1.7 0 0 0 19.38 9v.02A1.7 1.7 0 0 0 20.94 10H21a2 2 0 1 1 0 4h-.09' +
    'A1.7 1.7 0 0 0 19.4 15Z',
  // 左箭头
  back: 'M19 12H5M11 18l-6-6 6-6',
  // 字号：大小两个 A，暗示档位
  type: 'M3 18 7.5 6 12 18M4.6 14h5.8M14 18l3-8 3 8M15.2 15.2h3.6',
  plus: 'M12 5v14M5 12h14',
  // 目录：三行层级
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.35-4.35',
  close: 'M18 6 6 18M6 6l12 12',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
};

/** 创建一个图标元素。 */
export function icon(name: IconName): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');

  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICON_PATHS[name]);
  svg.append(path);
  return svg;
}
