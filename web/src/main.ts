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
import { getAllTasks, getMeta, putTask, setMeta } from './data/db';
import { isNative } from './data/native';
import {
  createInitialState,
  createStore,
  selectCurrentDoc,
  type Store,
} from './state/store';
import { canGoBack, topPage } from './core/nav';
import { suggestMaterial, visualAttrs } from './core/theme';
import { createAppHost, signaturePage, type ViewDeps } from './views/app';
import { createLayerHost } from './views/layers';
import { onLookupVisibility } from './views/lookup';
import { createReaderPage } from './views/reader';
import { renderKit } from './views/kit';
import type { MenuSpec } from './views/menu';
import { createSearchPage } from './views/search';
import { renderSettings } from './views/settings';
import { createShelfPage } from './views/shelf';
import { renderStats } from './views/stats';

/** 把排版设置写进根节点属性。CSS 据此选择档位，JS 不碰具体像素值。 */
function applyTypePrefs(prefs: TypePrefs): void {
  const attrs = typeAttributes(prefs);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(attrs)) {
    root.setAttribute(name, value);
  }
}

/** 系统当前是否深色。 */
function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** 视觉同步：状态中的设置 → DOM 根节点属性（主题/明暗/强调色/材质/玻璃强度/动效 + 排版档位）。 */
function syncVisualSettings(settings: Settings): void {
  const root = document.documentElement;
  const attrs = visualAttrs(settings, systemPrefersDark());
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null) root.removeAttribute(name);
    else root.setAttribute(name, value);
  }
  applyTypePrefs({
    typeScale: settings.typeScale,
    lineScale: settings.lineScale,
    paraScale: settings.paraScale,
    fontFamily: settings.fontFamily,
  });
}

/** 组件展示页只在开发环境 / kit 构建可见；正式构建里这个常量是 false，整页被摇树掉。 */
const KIT_ENABLED = import.meta.env.DEV || import.meta.env.MODE === 'kit';

/** hash ↔ 一级 tab 的对应（书架是默认页，不带 hash）。 */
function tabFromHash(hash: string): 'settings' | 'kit' | 'search' | 'stats' | null {
  if (hash === '#/settings') return 'settings';
  if (hash === '#/search') return 'search';
  if (hash === '#/stats') return 'stats';
  if (hash === '#/kit' && KIT_ENABLED) return 'kit';
  return null;
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

  // 收藏列表存 meta 表（小、不常变）；坏数据一律当空列表，不阻塞启动。
  let bookmarks: string[] = [];
  try {
    const raw = await getMeta('bookmarks');
    if (Array.isArray(raw)) bookmarks = raw.filter((v): v is string => typeof v === 'string');
  } catch (error) {
    console.warn('收藏列表载入失败，按空列表继续', error);
  }

  const store: Store = createStore(
    { ...createInitialState(initialSettings), docs, tasks },
    (state) => {
      syncVisualSettings(state.settings);
      saveSettings(state.settings);
    },
  );
  if (bookmarks.length > 0) store.dispatch({ type: 'bookmarks/loaded', bookmarks });

  syncVisualSettings(initialSettings);

  const rootEl = document.querySelector<HTMLElement>('[data-testid="app-root"]');
  if (rootEl === null) return;
  // 赋给明确非 null 的常量，让闭包内的类型收窄生效
  const root: HTMLElement = rootEl;

  /** 目录里高亮「当前所在块」用。 */
  let activeBid: string | null = null;

  /**
   * sticky 顶栏下沿的视口坐标。
   *
   * 顶栏没有稳定的 testid，这里从标题节点取父元素（各页面的顶栏都是
   * <header> 里放标题），避免用裸选择器找节点 —— check:selectors 会拦。
   */
  function appbarBottom(): number {
    const title = root.querySelector<HTMLElement>('[data-testid="app-title"]');
    // 标题可能被包在品牌块里（书架顶栏），所以向上找最近的 header 而不是只看父元素
    const appbar = title?.closest('header') ?? null;
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
    deps.dispatch({ type: 'nav/tab', tab: 'shelf' });
  }

  /** 请求导入文件。 */
  function requestImport(): void {
    void importViaPicker().then(applyImport).catch((error: unknown) => {
      toast(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** 打开目录抽屉。 */
  function openToc(): void {
    if (store.getState().render === null) return;
    store.dispatch({ type: 'layer/opened', layer: 'toc' });
  }

  /** 打开搜索浮层。 */
  function openSearch(): void {
    store.dispatch({ type: 'layer/opened', layer: 'search' });
  }

  // ── 全库搜索：按需渲染 + 纯函数匹配（视图只负责画） ────────────────
  /**
   * 渲染缓存。全库搜索要把每篇文档渲染一遍，输入防抖后仍可能重复渲染；
   * 缓存最近 8 篇，文档长度变了（内容变更）才失效。上限很小，避免长文档
   * 的 RenderResult 常驻内存。
   */
  const libraryRenderCache = new Map<string, { readonly textLen: number; readonly render: ReturnType<typeof renderMarkdown> }>();
  const LIBRARY_RENDER_CACHE_MAX = 8;

  function renderDocForSearch(doc: Doc): ReturnType<typeof renderMarkdown> {
    const cached = libraryRenderCache.get(doc.id);
    if (cached !== undefined && cached.textLen === doc.text.length) return cached.render;
    const render = renderMarkdown(doc.text);
    libraryRenderCache.set(doc.id, { textLen: doc.text.length, render });
    if (libraryRenderCache.size > LIBRARY_RENDER_CACHE_MAX) {
      const oldest = libraryRenderCache.keys().next().value;
      if (oldest !== undefined) libraryRenderCache.delete(oldest);
    }
    return render;
  }

  /** 全库搜索：最近读过的文档优先。 */
  function searchLibrary(query: string): SearchHit[] {
    const q = query.trim();
    if (q.length === 0) return [];
    const state = store.getState();
    const docs = [...state.docs].sort((a, b) => (b.lastReadAt ?? b.importedAt) - (a.lastReadAt ?? a.importedAt));
    const hits: SearchHit[] = [];
    for (const doc of docs) {
      const render =
        doc.id === state.currentDocId && state.render !== null ? state.render : renderDocForSearch(doc);
      for (const hit of searchInRender(render, doc.id, q)) {
        hits.push(hit);
        // 视图只画 60 条；多收一档留给后续筛选，也不至于把整库扫完
        if (hits.length >= 120) return hits;
      }
    }
    return hits;
  }

  /** 打开全库搜索命中：先打开文档，等正文挂载后再滚到命中块。 */
  function openHit(hit: SearchHit): void {
    if (!store.getState().docs.some((d) => d.id === hit.docId)) return;
    deps.dispatch({ type: 'doc/opened', docId: hit.docId });
    // openDoc 会先安排「恢复上次进度」的两次 rAF；这里排在它之后，确保命中位置优先。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollToBid(hit.bid, 0, 'auto'));
      });
    });
  }

  // ── 菜单浮层：内容不进 state，main 只记住「当前该画什么」 ──────────
  let currentMenu: MenuSpec | null = null;

  function openMenu(spec: MenuSpec): void {
    currentMenu = spec;
    store.dispatch({ type: 'layer/opened', layer: 'menu' });
  }

  /** 删除文档：先删库，成功后再更新状态；失败只提示，不假装删掉了。 */
  function requestDelete(docIds: readonly string[]): void {
    const ids = docIds.filter((id) => store.getState().docs.some((d) => d.id === id));
    if (ids.length === 0) return;
    void Promise.all(ids.map((id) => removeFromShelf(id)))
      .then(() => {
        for (const id of ids) store.dispatch({ type: 'doc/deleted', docId: id });
        toast(ids.length === 1 ? '已删除 1 篇' : `已删除 ${ids.length} 篇`);
      })
      .catch((error: unknown) => {
        toast(`删除失败：${error instanceof Error ? error.message : String(error)}`);
      });
  }

  /** 收藏 / 取消收藏：改状态 + 写 meta 表（失败只记日志，界面以内存态为准）。 */
  function toggleBookmark(docId: string): void {
    store.dispatch({ type: 'bookmark/toggled', docId });
    const next = store.getState().bookmarks;
    void setMeta('bookmarks', next).catch((error: unknown) => {
      console.warn('收藏列表写入失败', error);
    });
    toast(next.includes(docId) ? '已收藏' : '已取消收藏');
  }

  // ── 全屏图片 ─────────────────────────────────────
  let currentImage: string | null = null;

  function openImage(src: string): void {
    currentImage = src;
    store.dispatch({ type: 'layer/opened', layer: 'image' });
  }

  /** 打开阅读排版面板（Aa）。 */
  function openTypeset(): void {
    store.dispatch({ type: 'layer/opened', layer: 'typeset' });
  }

  const deps: ViewDeps = {
    dispatch: (action: StateAction) => store.dispatch(action),
    getState: () => store.getState(),
    requestImport,
    openToc,
    openSearch,
    searchLibrary,
    openHit,
    openMenu,
    requestDelete,
    toggleBookmark,
    openImage,
    openTypeset,
    toast,
    appVersion: APP_VERSION,
    buildId: BUILD_ID,
    sample: '',
    renderMarkdown,
  };

  /**
   * 「即将/正在恢复阅读进度」标记。
   * 由 openDoc() 置起、进度恢复那一帧结束后清除；hashchange 归零要避开它。
   */
  let restorePending = false;

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
      restorePending = true;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollToBid(bid, ratio, 'auto');
          restorePending = false;
        });
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
    // 离开阅读页（返回/进设置/切 tab/关文档）之前先存进度：此刻正文还挂着，位置才量得准。
    if (action.type === 'doc/closed' || action.type.startsWith('nav/')) {
      const nav = store.getState().nav;
      if (topPage(nav).kind === 'reader' && nav.layers.length === 0) persistProgress();
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
    // 附带全文百分比：书架「继续阅读」卡要显示 68%，但 bid+ratio 只能还原位置、
    // 算不出整篇进度，所以在写进度时顺手记一个滚动百分比。
    const updated: Doc = { ...doc, progress: { ...chosen, percent: readPercent() } };
    store.dispatch({ type: 'doc/updated', doc: updated });
    void saveDoc(updated);
  }

  /** 整篇阅读百分比（0..100）：按文档级滚动的当前位置算。 */
  function readPercent(): number {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (max <= 0) return 100;
    return Math.round(Math.min(1, Math.max(0, window.scrollY / max)) * 100);
  }

  /**
   * 系统返回键 —— 与界面内返回走同一条路：dispatch nav/back。
   * 浮层优先、其次页面，由 core/nav.ts 的 back() 一处决定；栈到底了才退出应用。
   */
  function handleSystemBack(): void {
    if (!canGoBack(store.getState().nav)) {
      void App.exitApp();
      return;
    }
    deps.dispatch({ type: 'nav/back' });
  }

  // ── 页面宿主 + 浮层宿主：只做局部更新，不再整树重渲染 ──
  const host = createAppHost(root, {
    isRestoringScroll: () => restorePending,
    createPage: (page, state) => {
      if (page.kind === 'reader') return createReaderPage(state, deps);
      if (page.tab === 'kit' && KIT_ENABLED) {
        return signaturePage(
          (s) => renderKit(s, deps),
          // 滑块拖动时 glassLevel 连续变化：不能因它重建页面，否则拖动中的滑块被换掉、手势中断
          (s) => JSON.stringify({ ...s.settings, glassLevel: 0 }),
          state,
        );
      }
      if (page.tab === 'settings') {
        return signaturePage(
          (s) => renderSettings(s, deps),
          // 滑块拖动时 glassLevel 连续变化：不能因它重建页面，否则拖动中的滑块被换掉、手势中断。
          // 页面栈深度也进签名：从阅读页压进来的设置页有返回键，作为 tab 时没有。
          (s) => JSON.stringify({ ...s.settings, glassLevel: 0 }) + `|${s.nav.pages.length}`,
          state,
        );
      }
      if (page.tab === 'search') return createSearchPage(state, deps);
      if (page.tab === 'stats') {
        // 统计数据只在会话落盘后整块换一次，重建页面代价可忽略
        return signaturePage(
          (s) => renderStats(s, deps),
          (s) => JSON.stringify(s.stats),
          state,
        );
      }
      return createShelfPage(state, deps);
    },
  });

  const layers = createLayerHost(root, {
    activeBid: () => activeBid,
    pickToc: (bid) => {
      scrollToBid(bid);
      store.dispatch({ type: 'layer/closed', layer: 'toc' });
    },
    query: (query) => {
      const s = store.getState();
      const docId = s.currentDocId;
      const hits: SearchHit[] =
        s.render !== null && docId !== null ? searchInRender(s.render, docId, query) : [];
      store.dispatch({ type: 'search/queried', query, results: hits });
    },
    pickHit: (hit) => {
      scrollToBid(hit.bid);
      store.dispatch({ type: 'search/queried', query: '', results: [] });
      store.dispatch({ type: 'layer/closed', layer: 'search' });
    },
    menuSpec: () => currentMenu,
    imageSrc: () => currentImage,
    dispatch: (action: StateAction) => store.dispatch(action),
    close: (layer) => {
      if (layer === 'menu') currentMenu = null;
      if (layer === 'image') currentImage = null;
      store.dispatch({ type: 'layer/closed', layer });
    },
  });

  // 查词卡片挂在正文里，但它是栈上的一层：登记进去，返回键才会先关它
  onLookupVisibility((open) => {
    store.dispatch(open ? { type: 'layer/opened', layer: 'lookup' } : { type: 'layer/closed', layer: 'lookup' });
  });

  /** hash 只是导航状态的镜像（保留深链）；写 hash 用 replaceState，不触发 hashchange。 */
  function hashFor(state: State): string {
    const top = topPage(state.nav);
    if (top.kind === 'tab') {
      if (top.tab === 'settings') return '#/settings';
      if (top.tab === 'search') return '#/search';
      if (top.tab === 'stats') return '#/stats';
      if (top.tab === 'kit') return '#/kit';
    }
    return '#/';
  }

  store.subscribe((state) => {
    host.update(state);
    layers.sync(state);
    const want = hashFor(state);
    if ((location.hash || '#/') !== want) history.replaceState(null, '', want);
  });

  window.addEventListener('hashchange', () => {
    const top = topPage(store.getState().nav);
    const want = tabFromHash(location.hash);
    const here = top.kind === 'tab' ? top.tab : null;
    // hash 是导航的镜像，语义是「切到哪个 tab」，不是「压一层页面」：
    //   #/search、#/stats、#/settings → switchTab；离开这些 hash → 回书架。
    // （从阅读页进设置走的是 more 菜单里的 nav/push，不经过 hash。）
    if (want === null) {
      if (here !== null && here !== 'shelf') deps.dispatch({ type: 'nav/tab', tab: 'shelf' });
      return;
    }
    if (want !== here) deps.dispatch({ type: 'nav/tab', tab: want });
  });

  // 首屏：深链 #/settings、#/search、#/stats、#/kit 直接进对应 tab，其余从书架开始
  const initialTab = tabFromHash(location.hash);
  if (initialTab !== null) {
    store.dispatch({ type: 'nav/tab', tab: initialTab });
  } else {
    host.update(store.getState());
  }

  // 跟随系统：系统明暗变了，且用户选的是「跟随系统」时，重新解析主题
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (store.getState().settings.theme === 'system') syncVisualSettings(store.getState().settings);
  });

  // 启动自检：低端机建议「柔和半透明」，只提示一次，不擅自改用户设置
  {
    const s0 = store.getState().settings;
    const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    const suggestion = s0.materialHinted
      ? null
      : suggestMaterial({ cores: navigator.hardwareConcurrency ?? null, memoryGb: mem ?? null }, s0.material);
    if (suggestion !== null) {
      store.dispatch({ type: 'settings/changed', patch: { materialHinted: true } });
      toast('检测到设备性能较弱，建议在 设置 → 外观 把材质切到「柔和半透明」');
    }
  }

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
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { void bootstrap(); }, { once: true });
} else {
  void bootstrap();
}
