/**
 * 应用入口 —— M2 编排层。
 *
 * 职责边界（刻意保持很薄）：
 *   1. 读取已存设置与书架
 *   2. 创建 store，把副作用（持久化、DOM 同步、滚动）放在订阅者里
 *   3. 把 IO 能力通过 ViewDeps 注入视图，视图本身不碰原生/文件系统
 *
 * 业务逻辑一律不写在这里。
 */

import { App } from '@capacitor/app';

import { APP_VERSION, BUILD_ID } from './core/build-info';
import { renderMarkdown } from './core/markdown';
import { searchInRender } from './core/search';
import { typeAttributes, type TypePrefs } from './core/typography';
import type {
  Doc,
  ReadProgress,
  SearchHit,
  Settings,
  State,
  StateAction,
  TaskState,
} from './core/types';
import { loadSettings, saveSettings } from './data/settings-store';
import {
  consumePendingShare,
  importViaPicker,
  loadShelf,
  removeFromShelf,
  saveDoc,
  subscribeToShares,
  type ImportSummary,
} from './data/library';
import { getAllTasks, putTask } from './data/db';
import { isNative } from './data/native';
import {
  createInitialState,
  createStore,
  selectCurrentDoc,
  type Store,
} from './state/store';
import { readRoute, renderApp } from './views/app';
import { renderTocDrawer, renderSearchOverlay } from './views/overlays';
import { closeLookupCard } from './views/lookup';

/** 把排版设置写进根节点属性。CSS 据此选择档位，JS 不碰具体像素值。 */
function applyTypePrefs(prefs: TypePrefs): void {
  const attrs = typeAttributes(prefs);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(attrs)) {
    root.setAttribute(name, value);
  }
}

/** 视觉同步：状态中的设置 → DOM 根节点属性。 */
function syncVisualSettings(settings: Settings): void {
  document.documentElement.setAttribute('data-theme', settings.theme);
  applyTypePrefs({
    typeScale: settings.typeScale,
    lineScale: settings.lineScale,
    paraScale: settings.paraScale,
    fontFamily: settings.fontFamily,
  });
}

/** 把导入结果显示成 toast。 */
function toast(message: string): void {
  const node = document.createElement('div');
  node.className = 'toast';
  node.setAttribute('data-testid', 'toast');
  node.setAttribute('role', 'status');
  node.textContent = message;
  document.body.append(node);
  window.setTimeout(() => node.remove(), 2600);
}

/** 汇总导入反馈文案。 */
function importMessage(summary: ImportSummary): string {
  const parts: string[] = [];
  if (summary.imported.length > 0) parts.push(`导入 ${summary.imported.length} 篇`);
  if (summary.skippedDuplicates > 0) parts.push(`跳过 ${summary.skippedDuplicates} 篇重复`);
  if (summary.failures.length > 0) parts.push(`${summary.failures.length} 篇失败`);
  if (parts.length === 0) return '没有可导入的文件';
  if (summary.failures.length > 0) parts.push(summary.failures[0]?.reason ?? '');
  return parts.join(' · ');
}

/**
 * 启动应用。
 */
async function bootstrap(): Promise<void> {
  const initialSettings = loadSettings();

  // ── 载入已有数据 ──
  let docs: Doc[] = [];
  try {
    docs = await loadShelf();
  } catch (error) {
    console.warn('书架载入失败，按空书架继续', error);
  }

  // 任务勾选状态和文档一起从库里读回来；读失败按「全未勾选」继续，
  // 不能因为一次 IO 失败让整个应用起不来。
  let tasks: TaskState[] = [];
  try {
    tasks = await getAllTasks();
  } catch (error) {
    console.warn('任务勾选状态载入失败，按空状态继续', error);
  }

  const store: Store = createStore(
    { ...createInitialState(initialSettings), docs, tasks },
    (state) => {
      syncVisualSettings(state.settings);
      saveSettings(state.settings);
    },
  );

  syncVisualSettings(initialSettings);

  const rootEl = document.querySelector<HTMLElement>('[data-testid="app-root"]');
  if (rootEl === null) return;
  // 赋给明确非 null 的常量，让闭包内的类型收窄生效
  const root: HTMLElement = rootEl;

  /** 当前打开的浮层（toc / search），独立于状态树，避免污染业务状态。 */
  let activeOverlay: 'toc' | 'search' | null = null;
  let activeBid: string | null = null;

  /**
   * sticky 顶栏下沿的视口坐标。
   *
   * 顶栏没有稳定的 testid，这里从标题节点取父元素（各页面的顶栏都是
   * <header> 里放标题），避免用裸选择器找节点 —— check:selectors 会拦。
   */
  function appbarBottom(): number {
    const title = root.querySelector<HTMLElement>('[data-testid="app-title"]');
    const appbar = title?.parentElement ?? null;
    return appbar?.getBoundingClientRect().bottom ?? 0;
  }

  /**
   * 滚动到某个块并高亮一下。
   * ratio 为「顶栏下沿在该块内的相对位置」(0=块顶, 1=块底)：
   * 加上 ratio×块高，才能让退出时停在顶栏下的那一行回到顶栏下，
   * 而不是把整块顶部顶上去（那样只有块级精度）。
   * 目录/搜索跳转不传 ratio，按 0 处理，行为不变。
   */
  function scrollToBid(bid: string, ratio = 0, behavior: ScrollBehavior = 'smooth'): void {
    const target = root.querySelector<HTMLElement>(`[data-bid="${CSS.escape(bid)}"]`);
    if (target === null) return;
    // sticky 顶栏压住视口 0..appbar.bottom；扣掉顶栏下沿高度。
    const offset = appbarBottom();
    const rect = target.getBoundingClientRect();
    const top = rect.top + window.scrollY - offset + ratio * rect.height;
    window.scrollTo({ top: Math.max(0, top), behavior });
    target.classList.add('flash');
    window.setTimeout(() => target.classList.remove('flash'), 1200);
    activeBid = bid;
  }

  /** 关闭浮层。 */
  function closeOverlay(): void {
    activeOverlay = null;
    const el = root.querySelector('[data-testid="toc-drawer"], [data-testid="search-overlay"]');
    el?.remove();
  }

  /** 把一批导入结果合进状态，并给出反馈。 */
  function applyImport(summary: ImportSummary): void {
    if (summary.imported.length === 0 && summary.skippedDuplicates === 0 && summary.failures.length === 0) {
      return; // 用户取消了选择，不打扰
    }
    for (const doc of summary.imported) {
      store.dispatch({ type: 'doc/imported', doc });
    }
    toast(importMessage(summary));
    // 导入后回到书架，让用户看到新文档
    location.hash = '#/';
  }

  /** 请求导入文件。 */
  function requestImport(): void {
    void importViaPicker().then(applyImport).catch((error: unknown) => {
      toast(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** 打开目录抽屉。 */
  function openToc(): void {
    const state = store.getState();
    if (state.render === null) return;
    activeOverlay = 'toc';
    root.append(
      renderTocDrawer(
        state.render.toc,
        activeBid,
        (bid) => {
          scrollToBid(bid);
          closeOverlay();
        },
        closeOverlay,
      ),
    );
  }

  /** 打开搜索浮层。 */
  function openSearch(): void {
    activeOverlay = 'search';
    const state = store.getState();
    root.append(
      renderSearchOverlay(
        state,
        deps,
        (query) => {
          const s = store.getState();
          const docId = s.currentDocId;
          const hits: SearchHit[] =
            s.render !== null && docId !== null ? searchInRender(s.render, docId, query) : [];
          store.dispatch({ type: 'search/queried', query, results: hits });
        },
        (hit) => {
          scrollToBid(hit.bid);
          store.dispatch({ type: 'search/queried', query: '', results: [] });
          closeOverlay();
        },
        closeOverlay,
      ),
    );
    // 打开后立刻聚焦输入框
    window.setTimeout(() => {
      root.querySelector<HTMLInputElement>('[data-testid="search-input"]')?.focus();
    }, 60);
  }

  const deps = {
    dispatch: (action: StateAction) => store.dispatch(action),
    requestImport,
    openToc,
    openSearch,
    appVersion: APP_VERSION,
    buildId: BUILD_ID,
    sample: '',
    renderMarkdown,
  };

  /** 打开文档：渲染并恢复进度。 */
  function openDoc(docId: string): void {
    const state = store.getState();
    const doc = state.docs.find((d) => d.id === docId);
    if (doc === null || doc === undefined) return;

    try {
      const render = renderMarkdown(doc.text);
      store.dispatch({ type: 'reader/ready', render });
    } catch (error) {
      store.dispatch({
        type: 'reader/error',
        message: error instanceof Error ? error.message : String(error),
      });
    }

    // 记录阅读时间并持久化
    const updated: Doc = { ...doc, lastReadAt: Date.now() };
    store.dispatch({ type: 'doc/updated', doc: updated });
    void saveDoc(updated);

    // 恢复阅读进度：等渲染完成一帧后再立即滚到位，不再用平滑滚动 + 固定 80ms 猜时序。
    if (doc.progress !== null) {
      const { bid, ratio } = doc.progress;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollToBid(bid, ratio, 'auto'));
      });
    }
  }

  /** 拦截 doc/opened，触发真正的渲染。 */
  const originalDispatch = deps.dispatch;
  deps.dispatch = (action: StateAction): void => {
    if (action.type === 'doc/opened') {
      store.dispatch(action);
      openDoc(action.docId);
      return;
    }
    if (action.type === 'doc/closed') {
      persistProgress();
      store.dispatch(action);
      location.hash = '#/';
      return;
    }
    // 任务勾选：先按正常路径改状态，再把这一条写回库。
    // 写库失败只记录，不回滚 UI —— 勾选是本地瞬时操作，报错更打扰。
    if (action.type === 'task/toggled') {
      originalDispatch(action);
      void putTask(action.task).catch((error: unknown) => {
        console.warn('任务勾选状态写入失败', error);
      });
      return;
    }
    originalDispatch(action);
  };

  /** 记录当前阅读位置（按块 id，而不是像素 —— 改字号后仍能回到同一处）。 */
  function persistProgress(): void {
    const state = store.getState();
    const doc = selectCurrentDoc(state);
    if (doc === null) return;
    const article = root.querySelector('[data-testid="article"]');
    if (article === null) return;

    const blocks = Array.from(article.querySelectorAll<HTMLElement>('[data-bid]'));
    // 基准线取 sticky 顶栏的下沿（视口坐标，滚动时保持不变）。
    // 不能再用 article.top：它随内容一起上移，恒为负，会让第一个块永远满足条件。
    const baseline = appbarBottom();
    let chosen: ReadProgress | null = null;
    for (const block of blocks) {
      const rect = block.getBoundingClientRect();
      if (rect.bottom > baseline) {
        // 顶栏下沿在本块内的相对位置，钳制到 0~1，交给恢复端还原到具体行。
        const ratio = Math.max(0, Math.min(1, (baseline - rect.top) / rect.height));
        chosen = { bid: block.getAttribute('data-bid') ?? '', ratio };
        break;
      }
    }
    if (chosen === null) return;
    const updated: Doc = { ...doc, progress: chosen };
    store.dispatch({ type: 'doc/updated', doc: updated });
    void saveDoc(updated);
  }

  /**
   * 系统返回键 —— 与界面内返回走同一套判断，不另开一套导航。
   *
   * 顺序按渲染优先级，一次只退一层：
   *   1. 目录/搜索浮层 → 只关浮层，页面不动
   *   2. 排版浮层（state.overlay）→ 只关它
   *   3. 设置页 → 回上一页（#/），阅读页现场原样保留
   *   4. 阅读页 → 走 doc/closed 分发（订阅者先存进度再回书架）
   *   5. 书架页 → 退出应用
   */
  function handleSystemBack(): void {
    // 释义卡片挂在正文里，先关它 —— 否则返回键会直接把阅读页退掉
    if (closeLookupCard()) return;
    if (activeOverlay !== null) {
      closeOverlay();
      return;
    }
    const state = store.getState();
    // 顺序与 renderApp 的渲染优先级一致：hash 设置页压过 font 浮层，
    // 否则「设置页 + 残留浮层」时按一次返回会关掉看不见的那个。
    if (readRoute() === 'settings') {
      location.hash = '#/';
      return;
    }
    if (state.overlay !== 'none') {
      store.dispatch({ type: 'overlay/opened', overlay: state.overlay });
      return;
    }
    if (state.currentDocId !== null) {
      deps.dispatch({ type: 'doc/closed' });
      return;
    }
    void App.exitApp();
  }

  /** 渲染视图。 */
  const renderNow = (): void => {
    renderApp(root, store.getState(), deps);
    // 浮层是附加节点，重渲染后要重新挂上
    if (activeOverlay === 'toc') {
      root.querySelector('[data-testid="toc-drawer"]')?.remove();
      // 避免递归：直接构造
      const state = store.getState();
      if (state.render !== null) {
        root.append(renderTocDrawer(state.render.toc, activeBid, (bid) => {
          scrollToBid(bid);
          closeOverlay();
        }, closeOverlay));
      }
    } else if (activeOverlay === 'search') {
      root.querySelector('[data-testid="search-overlay"]')?.remove();
      const state = store.getState();
      root.append(renderSearchOverlay(state, deps, (query) => {
        const s = store.getState();
        const docId = s.currentDocId;
        const hits = s.render !== null && docId !== null ? searchInRender(s.render, docId, query) : [];
        store.dispatch({ type: 'search/queried', query, results: hits });
      }, (hit) => {
        scrollToBid(hit.bid);
        store.dispatch({ type: 'search/queried', query: '', results: [] });
        closeOverlay();
      }, closeOverlay));
    }
  };

  store.subscribe(renderNow);
  window.addEventListener('hashchange', renderNow);
  renderNow();

  // ── 系统分享 / 打开 ──
  // 用 setTimeout 让 Capacitor 插件桥完成初始化后再取 URI。
  // 直接在 bootstrap 里 await 会在某些启动时序下拿到空数组。
  // peek 是非破坏性的：即使这次取早了，onNewIntent 事件仍会再触发一次。
  window.setTimeout(() => {
    void consumePendingShare().then(applyImport).catch((error: unknown) => {
      toast(`打开失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }, 300);
  subscribeToShares(applyImport);

  // ── 阅读进度：滚动停止后记录 ──
  let scrollTimer: number | null = null;
  window.addEventListener('scroll', () => {
    if (scrollTimer !== null) window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(() => {
      if (store.getState().currentDocId !== null) persistProgress();
    }, 400);
  }, { passive: true });

  // ── 系统返回键（仅 Android 原生；浏览器里没有该事件） ──
  // 注册后 Capacitor 不再执行默认的 WebView goBack，返回完全由 handleSystemBack 决定。
  if (isNative()) {
    void App.addListener('backButton', handleSystemBack);
  }

  // ── 删除支持（供未来的长按菜单调用） ──
  void removeFromShelf;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { void bootstrap(); }, { once: true });
} else {
  void bootstrap();
}
