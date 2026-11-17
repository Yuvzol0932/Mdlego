/**
 * 视图层总入口。
 *
 * 只做三件事：读 state → 写 DOM → 派发 action。
 * 不持有业务状态、不直接读写存储。
 *
 * 渲染模型（阶段 A）：页面节点创建一次，之后只做局部更新。
 * 不再有「每次 dispatch 整树 replaceChildren」。
 */

import { pageKey, topPage } from '../core/nav';
import type { Page, RenderResult, Settings, State, StateAction } from '../core/types';

/** 视图依赖注入：避免视图层直接 import data/。 */
export interface ViewDeps {
  dispatch: (action: StateAction) => void;
  /** 请求导入文件（IO 由 main.ts 编排，视图不碰原生/文件系统）。 */
  requestImport: () => void;
  /** 请求打开目录抽屉。 */
  openToc: () => void;
  /** 请求单篇搜索。 */
  openSearch: () => void;
  /** 读取最新状态（事件回调里用，避免闭包捕获过期 state）。 */
  getState: () => State;
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

/** 一个已挂载（或缓存）的页面：节点创建一次，之后只做局部更新。 */
export interface PageView {
  readonly el: HTMLElement;
  /** 状态变化时调用；实现负责判断哪些部分真的需要动。 */
  update(state: State): void;
}

/**
 * 「签名页」：内容由一个纯渲染函数产生，但只有签名变化才重建。
 * 外层 .shell 节点保持不变，只替换它的子节点 —— 页面节点身份稳定，
 * 缓存、滚动记忆与测试断言都可以依赖它。
 */
export function signaturePage(
  render: (state: State) => HTMLElement,
  signature: (state: State) => string,
  initial: State,
): PageView {
  const first = render(initial);
  let sig = signature(initial);
  return {
    el: first,
    update(state) {
      const next = signature(state);
      if (next === sig) return;
      sig = next;
      first.replaceChildren(...Array.from(render(state).childNodes));
    },
  };
}

/** 页面宿主需要的外部能力。 */
export interface HostHooks {
  createPage: (page: Page, state: State) => PageView;
  /** 返回 true 表示当前正在恢复阅读进度，换页时不要改动滚动位置。 */
  isRestoringScroll: () => boolean;
}

export interface AppHost {
  update(state: State): void;
  /** 当前挂在 DOM 里的页面键（测试与诊断用）。 */
  mountedKey(): string | null;
}

/**
 * 页面宿主：按页面栈挂载页面。
 *
 *  - 同一时刻 DOM 里只有栈顶一页（不会出现重复 testid）
 *  - 栈内的其它页面作为脱离文档的节点缓存，回到它时原样挂回，
 *    正文不会重建、勾选状态不丢
 *  - 弹出栈的页面立即丢弃
 *  - 每页的滚动位置按页面键记忆，换页时保存/恢复
 */
export function createAppHost(root: HTMLElement, hooks: HostHooks): AppHost {
  const views = new Map<string, PageView>();
  const scrollOf = new Map<string, number>();
  let mountedEl: HTMLElement | null = null;
  let mountedKeyValue: string | null = null;

  return {
    mountedKey: () => mountedKeyValue,
    update(state) {
      const keep = new Set(state.nav.pages.map(pageKey));
      for (const key of [...views.keys()]) {
        if (!keep.has(key)) {
          views.delete(key);
          scrollOf.delete(key);
        }
      }

      const top = topPage(state.nav);
      const topKey = pageKey(top);
      let view = views.get(topKey);
      if (view === undefined) {
        view = hooks.createPage(top, state);
        views.set(topKey, view);
      }
      for (const v of views.values()) v.update(state);

      if (mountedKeyValue !== topKey || mountedEl !== view.el) {
        if (mountedKeyValue !== null) scrollOf.set(mountedKeyValue, window.scrollY);
        mountedEl?.remove();
        root.prepend(view.el);
        mountedEl = view.el;
        mountedKeyValue = topKey;
        if (!hooks.isRestoringScroll()) window.scrollTo(0, scrollOf.get(topKey) ?? 0);
      }
    },
  };
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
