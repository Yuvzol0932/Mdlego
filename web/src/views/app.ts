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
import type { HighlightColor, MarkType, Page, RenderResult, SearchHit, SelectionPart, Settings, State, StateAction } from '../core/types';
import { ensureSprite, type IconName } from './icons';
import type { MenuSpec } from './menu';

/** 视图依赖注入：避免视图层直接 import data/。 */
export interface ViewDeps {
  dispatch: (action: StateAction) => void;
  /** 请求导入文件（IO 由 main.ts 编排，视图不碰原生/文件系统）。 */
  requestImport: () => void;
  /** 请求打开目录抽屉。 */
  openToc: () => void;
  /** 请求单篇搜索。 */
  openSearch: () => void;
  /** 全库搜索：按需渲染文档 + core/search.ts，由 main.ts 编排。 */
  searchLibrary: (query: string) => SearchHit[];
  /** 打开一条全库搜索命中（打开文档并滚到该块）。 */
  openHit: (hit: SearchHit) => void;
  /** 打开锚定菜单 / 底部面板 / 确认框（内容不进 state，关闭走 layer/closed）。 */
  openMenu: (spec: MenuSpec) => void;
  /** 删除文档（删库 + 更新状态 + 反馈都由 main.ts 编排）。 */
  requestDelete: (docIds: readonly string[]) => void;
  /** 收藏 / 取消收藏（持久化由 main.ts 负责）。 */
  toggleBookmark: (docId: string) => void;
  /** 选一张本地图片做横幅背景（缩图与写入由 main.ts + data/banner.ts 负责）。 */
  pickBanner: () => void;
  /** 恢复默认渐变横幅。 */
  clearBanner: () => void;
  /** 清空阅读统计（会话记录）。 */
  clearStats: () => void;
  /** 全屏查看正文图片。 */
  openImage: (src: string) => void;
  /** 打开阅读排版面板（Aa）。 */
  openTypeset: () => void;
  /** 新建标注（选区工具条动作；持久化由 main 负责）。 */
  addSelectionMark: (parts: readonly SelectionPart[], type: MarkType, color: HighlightColor | null) => void;
  /** 新建批注：先记选区，由 main 打开备注面板。 */
  openNoteForSelection: (parts: readonly SelectionPart[]) => void;
  /** 编辑已有批注的备注。 */
  openNoteForMark: (markId: string) => void;
  /** 删除标注。 */
  removeMark: (markId: string) => void;
  /** 打开批注列表面板。 */
  openMarks: () => void;
  /** 复制文本（剪贴板由 main 统一处理与提示）。 */
  copyText: (text: string) => void;
  /** 查词（释义卡片由 lookup 卡片渲染）。 */
  lookupWord: (word: string) => void;
  /** 是否在等待「失效标注重新挂载」。 */
  isReanchorPending: () => boolean;
  /** 用当前选区重新挂载失效标注。 */
  reanchorSelection: (parts: readonly SelectionPart[]) => void;
  /** 导出备份（JSON：文档/批注/进度/任务/设置/收藏）。 */
  exportBackup: () => void;
  /** 从文件恢复备份（读取、校验、确认、覆盖都在 main 处理）。 */
  importBackupFile: (file: File) => void;
  /** 从剪贴板恢复备份。 */
  importBackupClipboard: () => void;
  /** 给选中的文档加/减标签（标签面板由 main 打开，变更立即持久化）。 */
  openTagEditor: (docIds: readonly string[]) => void;
  /** 给选中的文档移动文件夹（单层；null 表示移出）。 */
  openFolderEditor: (docIds: readonly string[]) => void;
  /** 轻提示。 */
  toast: (message: string) => void;
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
  /** 页面从缓存中移除时的清理（滚动监听、定时器等）。缺省表示无需清理。 */
  destroy?: () => void;
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
  /** 当前挂载的页面根节点（阶段 D：转场命名/降级进入动画要用）。 */
  mountedElement(): HTMLElement | null;
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
    mountedElement: () => mountedEl,
    update(state) {
      const keep = new Set(state.nav.pages.map(pageKey));
      for (const key of [...views.keys()]) {
        if (!keep.has(key)) {
          // 被弹出栈的页面要拆掉监听与定时器，否则页面的定时器会一直跑
          views.get(key)?.destroy?.();
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

export { type IconName } from './icons';

/**
 * 创建一个图标元素：引用 icons.ts 的精灵（<use>），2px 描边、currentColor。
 * 第一次调用时自动把精灵注入文档。
 */
export function icon(name: IconName): SVGElement {
  ensureSprite();
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/** 系统当前是否深色（无 matchMedia 的环境视为浅色）。 */
export function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}
