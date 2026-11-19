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
import { addTagToDocs, removeTagFromDocs, setFolderForDocs } from './core/library';
import { buildBackup, parseBackup, type BackupData } from './core/backup';
import { decideSave, normalizeEditedText, titleFromText, updatedFingerprint, type OriginalSnapshot } from './core/editor';
import { buildExportHtml } from './core/export-html';
import { buildMark, marksToMarkdown, relocateMarks } from './core/marks';
import { hasWord, pushHistory, removeWord as removeWordEntry, upsertWord } from './core/vocabulary';
import { applyBackupData, collectBackupData } from './data/backup';
import { loadVocabulary, saveLookupHistory, saveWordbook } from './data/vocabulary';
import { copyText as writeClipboard } from './data/clipboard';
import { sha256Hex } from './data/import';
import { base64ToBytes, readNativeFiles, writeDocument } from './data/native';
import { renderMarkdown } from './core/markdown';
import {
  buildDiagnosticsReport,
  clearDiagnostics as clearDiagLog,
  diagnosticsCount,
  installDiagnostics,
  recordDiagnostic,
} from './core/diagnostics';
import { renderMarkdownAsync, warmRenderWorker } from './core/render-async';
import { effectiveMotion, pageDuration, type MotionLevel } from './core/motion';
import { computeStats } from './core/stats';
import { searchInRender } from './core/search';
import { typeAttributes, type TypePrefs } from './core/typography';
import type {
  Doc,
  WordEntry,
  HighlightColor,
  Mark,
  MarkType,
  ReadProgress,
  ReadingSession,
  RenderResult,
  SearchHit,
  SelectionPart,
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
import { clearSessions, deleteMark, getAllSessions, getAllTasks, getMarksByDoc, getMeta, putMark, putSession, putTask, setMeta } from './data/db';
import { pickBannerImage } from './data/banner';
import { isNative, releaseScreenWakeLock, requestScreenWakeLock, syncSystemBars } from './data/native';
import {
  createInitialState,
  createStore,
  selectCurrentDoc,
  type Store,
} from './state/store';
import { canGoBack, topPage } from './core/nav';
import { suggestMaterial, visualAttrs } from './core/theme';
import { createAppHost, signaturePage, type AppHost, type ViewDeps } from './views/app';
import { createLayerHost } from './views/layers';
import { lookupWord as lookupWordInArticle, onLookupVisibility } from './views/lookup';
import { enableEdgeBack } from './views/edge-back';
import { runThemeReveal } from './views/motion';
import {
  hasHiddenMorphSlot,
  rectOfElement,
  runCloseMask,
  runOpenMask,
  runPageFade,
  setLastClickedCard,
  settlePageTransition,
  type MaskRect,
} from './views/page-mask';
import {
  GESTURE_HIDDEN_CLASS,
  beginGestureStage,
  endGestureStage,
  type GestureStage,
} from './views/gesture-stage';
import { isNativeBackActive, mountBackGesture, setNativeBackBridge, type BackGestureController } from './views/back-gesture';
import { shouldInterceptBack, type BackStack } from './core/back-gesture';
import { FULL_STATE, FOLLOW_RADIUS_MAX, behindScale, lerpState, scrimOpacity, transformOf, type MorphState } from './core/morph';
import { MOVE_CANCEL_MS } from './views/back-gesture';
import { setNativeBackIntercept } from './data/native';
import { createReaderPage } from './views/reader';
import { createEditorPage } from './views/editor';
import { renderKit } from './views/kit';
import type { MarksInput } from './views/marks';
import type { WordbookTab } from './views/wordbook';
import type { MenuSpec } from './views/menu';
import type { NoteDraft } from './views/note';
import { createSearchPage } from './views/search';
import { renderSettings } from './views/settings';
import { createCollectionSheet, type CollectionSpec } from './views/collection';
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
/** 把「设置里的动效选择」与系统减少动效偏好合成实际生效的强度。 */
function effectiveMotionChoice(choice: Settings['motion']): 'off' | 'simple' | 'full' {
  return effectiveMotion(choice, motionReduceQuery().matches);
}

/** 系统「减少动效」偏好查询（只读，不触发重排）。 */
function motionReduceQuery(): MediaQueryList {
  return window.matchMedia('(prefers-reduced-motion: reduce)');
}

function syncVisualSettings(settings: Settings): void {
  const root = document.documentElement;
  const attrs = visualAttrs(settings, systemPrefersDark());
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null) root.removeAttribute(name);
    else root.setAttribute(name, value);
  }
  // 生效强度可能被系统偏好降级；写进属性的是生效值（设置页仍显示用户选择）
  root.setAttribute('data-motion', effectiveMotionChoice(settings.motion));
  // 护眼模式：整页暖色覆盖（纯观感，不改布局与坐标）
  if (settings.eyeCare) root.setAttribute('data-eyecare', '1');
  else root.removeAttribute('data-eyecare');
  // 状态栏/导航栏图标明暗跟随主题（lookup #5）。
  // 浅色主题 → 图标要用深色（dark: true），深色主题反之。
  // 只同步图标，不涂背景色：状态栏背景由 Web 顶栏自己画上去
  // （.appbar 的 --safe-top 内边距就是给它让位的）。
  syncSystemBars(attrs['data-scheme'] === 'light');
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
  // 提前把渲染 Worker 拉起：第一次打开文档时省掉 worker 启动开销
  warmRenderWorker();
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

  // 阅读会话（统计页数据源）。读失败按「没有记录」继续：统计页显示空状态，不伪造数字。
  let sessions: ReadingSession[] = [];
  try {
    sessions = await getAllSessions();
  } catch (error) {
    console.warn('阅读会话载入失败，统计按空状态继续', error);
  }

  const store: Store = createStore(
    { ...createInitialState(initialSettings), docs, tasks },
    (state) => {
      syncVisualSettings(state.settings);
      saveSettings(state.settings);
      syncWakeLock(state);
    },
  );
  if (bookmarks.length > 0) store.dispatch({ type: 'bookmarks/loaded', bookmarks });

  // 生词本 / 查词历史（meta 里两个 JSON 数组；脏数据由 core/vocabulary 归一化）
  void loadVocabulary()
    .then(({ words, history }) => {
      store.dispatch({ type: 'words/loaded', words });
      store.dispatch({ type: 'lookup-history/loaded', history });
    })
    .catch((error: unknown) => {
      console.warn('生词本读取失败', error);
    });
  if (sessions.length > 0) {
    store.dispatch({ type: 'stats/loaded', stats: computeStats(sessions, docs, Date.now()) });
  }

  syncVisualSettings(initialSettings);

  const rootEl = document.querySelector<HTMLElement>('[data-testid="app-root"]');
  if (rootEl === null) return;
  // 赋给明确非 null 的常量，让闭包内的类型收窄生效
  const root: HTMLElement = rootEl;

  /** 目录里高亮「当前所在块」用。 */
  let activeBid: string | null = null;

  // ── 动效所需的「最近一次指针」信息（阶段 D2） ─────────────
  // 页面转场的共享矩形要知道「从哪张封面开始」；主题圆形扩散要知道「从哪点开始」。
  // 用捕获阶段记录，不入侵任何视图的点击逻辑。
  let lastPointer: { x: number; y: number } | null = null;
  let lastPointerTarget: EventTarget | null = null;
  document.addEventListener(
    'pointerdown',
    (event) => {
      lastPointer = { x: event.clientX, y: event.clientY };
      lastPointerTarget = event.target;
    },
    { capture: true, passive: true },
  );
  // 键盘 / 程序触发的点击没有 pointerdown：用点击坐标，没有坐标就用元素中心。
  // 这样屏幕阅读器、自动化与「回车激活按钮」也能拿到一个合理的扩散原点。
  document.addEventListener(
    'click',
    (event) => {
      lastPointerTarget = event.target;
      if (event.clientX > 0 || event.clientY > 0) {
        lastPointer = { x: event.clientX, y: event.clientY };
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      const rect = target?.getBoundingClientRect() ?? null;
      if (rect !== null) lastPointer = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    },
    { capture: true, passive: true },
  );

  /**
   * sticky 顶栏下沿的视口坐标。
   *
   * 顶栏没有稳定的 testid，这里从标题节点取父元素（各页面的顶栏都是
   * <header> 里放标题），避免用裸选择器找节点 —— check:selectors 会拦。
   *
   * 必须排除顶栏自身的 `translateY(-100%)`：顶栏滚动态（data-bars=hidden）
   * 会把自己整条移出屏幕，`getBoundingClientRect()` 于是返回负值。
   * 阅读进度的「基准线」是**几何常量**，不该随顶栏收放而变 —— 否则
   * 保存进度时顶栏收起、恢复时顶栏显示，同一个 bid 会差一整条顶栏高度
   * （实测 64px，正好是顶栏高度），表现就是「回到原文但位置偏了一行」。
   * 这里用 offsetHeight（不含 transform）作为稳定基准线。
   */
  function appbarBottom(): number {
    const title = root.querySelector<HTMLElement>('[data-testid="app-title"]');
    // 标题可能被包在品牌块里（书架顶栏），所以向上找最近的 header 而不是只看父元素
    const appbar = title?.closest('header') ?? null;
    if (appbar === null) return 0;
    // sticky 元素永远贴在 top: 0，所以「稳定下沿」= 自身布局高度
    return appbar.offsetHeight;
  }

  /**
   * 目标块当前所处的**视觉→布局**缩放比（转场形变壳的 scale）。
   *
   * `getBoundingClientRect()` 返回的是变换后的视觉坐标，`scrollTop` 是布局坐标。
   * 打开/关闭转场期间 `.page-mask` 带 `transform: scale(...)`（从被点封面矩形
   * 起飞时约 0.26），混用两种坐标会差 `1/scale` 倍，且随动画推进自己变化 ——
   * 表现就是「锚点每帧都差一点，永远收敛不到位」。
   *
   * 用 `视觉高 / 布局高`（`offsetHeight` 不受 transform 影响）现算，
   * 不依赖读计算样式，也不依赖知道动画进度。非转场期为 1。
   */
  function visualScale(el: HTMLElement): number {
    const layout = el.offsetHeight;
    const visual = el.getBoundingClientRect().height;
    if (layout <= 0 || visual <= 0) return 1;
    const scale = visual / layout;
    return scale > 0.01 ? 1 / scale : 1;
  }

  /**
   * 滚动到某个块并高亮一下。
   * ratio 为「顶栏下沿在该块内的相对位置」(0=块顶, 1=块底)：
   * 加上 ratio×块高，才能让退出时停在顶栏下的那一行回到顶栏下，
   * 而不是把整块顶部顶上去（那样只有块级精度）。
   * 目录/搜索跳转不传 ratio，按 0 处理，行为不变。
   */
  function scrollToBid(bid: string, ratio = 0, behavior: ScrollBehavior = 'smooth', allowFlush = true): boolean {
    let target = root.querySelector<HTMLElement>(`[data-bid="${CSS.escape(bid)}"]`);
    if (target === null && allowFlush) {
      // 分片懒挂载：目标块可能还在空闲队列里 → 让阅读页同步补齐后重试一次
      hostRef?.mountedElement()?.dispatchEvent(new CustomEvent('mdlego:flush-article'));
      target = root.querySelector<HTMLElement>(`[data-bid="${CSS.escape(bid)}"]`);
    }
    if (target === null) return false;
    // sticky 顶栏压住视口 0..appbar.bottom；扣掉顶栏下沿高度。
    const offset = appbarBottom();
    const mask = maskScroller();
    // 打开/关闭转场期间 `.page-mask` 带 transform: scale()，getBoundingClientRect()
    // 给的是**视觉**坐标，而 scrollTop 是**布局**坐标，混用会差 1/scale 倍。
    // 用「视觉高 / 布局高」现算缩放再换算（offsetHeight 不受 transform 影响）。
    const scale = visualScale(target);
    // 打开动画期间阅读页在 fixed 遮罩层里，window 滚动会被夹到 0：
    // 滚动要写在遮罩层上，收尾时由 page-mask 在解绑 fixed 的同一同步帧交给 window。
    if (mask !== null) {
      const rect = target.getBoundingClientRect();
      mask.scrollTop = Math.max(0, rect.top * scale + mask.scrollTop - offset + ratio * rect.height * scale);
    } else {
      const rect = target.getBoundingClientRect();
      const top = Math.max(0, rect.top * scale + window.scrollY - offset + ratio * rect.height * scale);
      window.scrollTo({ top, behavior });
    }
    target.classList.add('flash');
    window.setTimeout(() => target.classList.remove('flash'), 1200);
    activeBid = bid;
    return true;
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

  // ── 阅读会话记录（统计页的数据源） ──────────────────────────
  /**
   * 一次「正在阅读」的会话。ms 只累计前台可见时长：
   * 切后台 / 锁屏期间不计入 —— 阅读时长不该包含 App 被挂起的时间。
   */
  let session: { docId: string; startedAt: number; visibleMs: number; visibleSince: number | null } | null = null;

  function pauseSessionClock(): void {
    if (session === null || session.visibleSince === null) return;
    session.visibleMs += Date.now() - session.visibleSince;
    session.visibleSince = null;
  }

  function resumeSessionClock(): void {
    if (session === null || session.visibleSince !== null) return;
    session.visibleSince = Date.now();
  }

  /** 开始新会话（若上一篇还没结，先结掉，避免同一段时间记两遍）。 */
  function startSession(docId: string): void {
    finishSession();
    session = {
      docId,
      startedAt: Date.now(),
      visibleMs: 0,
      visibleSince: document.visibilityState === 'hidden' ? null : Date.now(),
    };
  }

  /** 结束当前会话并落库；少于 3 秒的打开不计入统计（误点不污染数据）。 */
  function finishSession(): void {
    if (session === null) return;
    const current = session;
    session = null;
    if (current.visibleSince !== null) current.visibleMs += Date.now() - current.visibleSince;
    const ms = Math.round(current.visibleMs);
    if (ms < 3_000) return;
    const endedAt = Date.now();
    const record: ReadingSession = {
      // 会话 id 只需本机唯一：开始时刻 + 随机后缀
      id: `${current.docId}-${current.startedAt}-${Math.random().toString(36).slice(2, 8)}`,
      docId: current.docId,
      startedAt: current.startedAt,
      endedAt,
      // 上限 4 小时：长时间挂前台时，避免一次会话把统计拉爆
      ms: Math.min(ms, 4 * 3_600_000),
    };
    void putSession(record)
      .then(refreshStats)
      .catch((error: unknown) => console.warn('阅读会话写入失败', error));
  }

  /** 重新读会话并刷新统计快照（没有记录时 dispatch null，页面显示空状态而不是零）。 */
  async function refreshStats(): Promise<void> {
    try {
      const all = await getAllSessions();
      const state = store.getState();
      store.dispatch({
        type: 'stats/loaded',
        stats: all.length === 0 ? null : computeStats(all, state.docs, Date.now()),
      });
    } catch (error) {
      console.warn('统计刷新失败', error);
    }
  }

  /** 删除文档：先删库，成功后再更新状态；失败只提示，不假装删掉了。 */
  function requestDelete(docIds: readonly string[]): void {
    const ids = docIds.filter((id) => store.getState().docs.some((d) => d.id === id));
    if (ids.length === 0) return;
    void Promise.all(ids.map((id) => removeFromShelf(id)))
      .then(() => {
        for (const id of ids) store.dispatch({ type: 'doc/deleted', docId: id });
        toast(ids.length === 1 ? '已删除 1 篇' : `已删除 ${ids.length} 篇`);
        // 最近读过的列表要剔除已删文档（会话记录本身保留：累计时长是事实）
        void refreshStats();
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

  // ── 划词批注（阶段 E2）────────────────────────────────
  /** 备注面板草稿；null 表示没开。 */
  let currentNote: NoteDraft | null = null;
  /** 新建批注时暂存的选区（面板确认后据此建标注）。 */
  let pendingNoteParts: readonly SelectionPart[] | null = null;
  /** 失效标注重新挂载：等待用户在正文里选新位置。 */
  let pendingReanchor: string | null = null;

  function newMarkId(): string {
    return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** 由选区切片构造标注（坐标换成锚点；note 文本可为 null）。 */
  function createMarksFromParts(
    parts: readonly SelectionPart[],
    type: MarkType,
    color: HighlightColor | null,
    note: string | null,
  ): Mark[] {
    const state = store.getState();
    const render = state.render;
    const docId = state.currentDocId;
    if (render === null || docId === null || parts.length === 0) return [];
    const createdAt = Date.now();
    return parts.map((part, index) =>
      buildMark({
        id: `${newMarkId()}-${index}`,
        docId,
        bid: part.bid,
        blockText: render.blockTexts.get(part.bid) ?? '',
        start: part.start,
        end: part.end,
        type,
        color,
        note,
        createdAt,
      }),
    );
  }

  function addMarks(marks: readonly Mark[]): void {
    for (const mark of marks) {
      store.dispatch({ type: 'mark/added', mark });
      void putMark(mark).catch((error: unknown) => {
        console.warn('标注保存失败', error);
        toast('标注保存失败，请重试');
      });
    }
  }

  function updateMarkRecord(mark: Mark): void {
    store.dispatch({ type: 'mark/updated', mark });
    void putMark(mark).catch((error: unknown) => {
      console.warn('标注更新失败', error);
      toast('标注保存失败，请重试');
    });
  }

  function removeMark(markId: string): void {
    store.dispatch({ type: 'mark/removed', markId });
    void deleteMark(markId).catch((error: unknown) => {
      console.warn('标注删除失败', error);
      toast('删除失败，请重试');
    });
  }

  function addSelectionMark(parts: readonly SelectionPart[], type: MarkType, color: HighlightColor | null): void {
    addMarks(createMarksFromParts(parts, type, color, null));
  }

  function openNoteForSelection(parts: readonly SelectionPart[]): void {
    const docId = store.getState().currentDocId;
    if (docId === null || parts.length === 0) return;
    pendingNoteParts = parts;
    currentNote = {
      docId,
      mode: 'new',
      quote: parts.map((part) => part.quote).join(''),
      initial: '',
    };
    store.dispatch({ type: 'layer/opened', layer: 'note' });
  }

  function openNoteForMark(markId: string): void {
    const state = store.getState();
    const mark = state.marks.find((m) => m.id === markId);
    if (mark === undefined || state.currentDocId === null) return;
    pendingNoteParts = null;
    currentNote = {
      docId: state.currentDocId,
      mode: 'edit',
      markId: mark.id,
      quote: mark.anchor.quote,
      initial: mark.note ?? '',
    };
    store.dispatch({ type: 'layer/opened', layer: 'note' });
  }

  function saveNote(text: string): void {
    const draft = currentNote;
    if (draft === null) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      toast('批注不能为空');
      return;
    }
    if (draft.mode === 'edit' && draft.markId !== undefined) {
      const mark = store.getState().marks.find((m) => m.id === draft.markId);
      if (mark !== undefined) updateMarkRecord({ ...mark, note: trimmed });
    } else if (pendingNoteParts !== null) {
      addMarks(createMarksFromParts(pendingNoteParts, 'note', null, trimmed));
    }
    pendingNoteParts = null;
    currentNote = null;
    store.dispatch({ type: 'layer/closed', layer: 'note' });
    toast(draft.mode === 'edit' ? '批注已更新' : '批注已保存');
  }

  function cancelNote(): void {
    pendingNoteParts = null;
    currentNote = null;
    store.dispatch({ type: 'layer/closed', layer: 'note' });
  }

  function openMarks(): void {
    store.dispatch({ type: 'layer/opened', layer: 'marks' });
  }

  /** 批注列表面板的数据（重定位在这里算，失效项只影响展示）。 */
  function marksInput(): MarksInput | null {
    const state = store.getState();
    const render = state.render;
    const doc = state.docs.find((d) => d.id === state.currentDocId);
    if (render === null || doc === undefined) return null;
    const relocated = relocateMarks(state.marks, render.blockTexts);
    return {
      title: doc.title,
      marks: relocated.marks,
      orphans: new Set(relocated.orphans.map((m) => m.id)),
      blockTexts: render.blockTexts,
    };
  }

  function beginReanchor(markId: string): void {
    pendingReanchor = markId;
    store.dispatch({ type: 'layer/closed', layer: 'marks' });
    toast('在正文选中要挂载的文字，再点「挂载到此」');
  }

  function reanchorTo(parts: readonly SelectionPart[]): void {
    const markId = pendingReanchor;
    pendingReanchor = null;
    if (markId === null) return;
    const state = store.getState();
    const mark = state.marks.find((m) => m.id === markId);
    const render = state.render;
    const part = parts[0];
    if (mark === undefined || render === null || part === undefined) return;
    updateMarkRecord(
      buildMark({
        id: mark.id,
        docId: mark.docId,
        bid: part.bid,
        blockText: render.blockTexts.get(part.bid) ?? '',
        start: part.start,
        end: part.end,
        type: mark.type,
        color: mark.color,
        note: mark.note,
        createdAt: mark.createdAt,
      }),
    );
    toast('已重新挂载');
  }

  function exportMarks(): void {
    const input = marksInput();
    if (input === null) return;
    const markdown = marksToMarkdown(input.title, input.marks, input.blockTexts, input.orphans);
    void writeClipboard(markdown).then((ok) => {
      toast(ok ? `已复制 ${input.marks.length} 条批注的 Markdown` : '复制失败，请检查剪贴板权限');
    });
  }

  function copyToClipboard(text: string): void {
    void writeClipboard(text).then((ok) => {
      toast(ok ? '已复制' : '复制失败，请检查剪贴板权限');
    });
  }

  function lookupWord(word: string, rect: DOMRect | null = null): void {
    const article = root.querySelector<HTMLElement>('[data-testid="article"]');
    if (article === null) return;
    lookupWordInArticle(article, word, rect, {
      isSaved: (candidate) => hasWord(store.getState().words, candidate),
      onToggleWord: (entry) => addOrRemoveWord(entry),
      onRecord: (candidate) => recordLookup(candidate),
      motionLevel: () => motionLevel(),
    });
  }

  /** 打开文档后读取并重定位该文档的标注。 */
  async function loadMarksForDoc(docId: string, render: RenderResult): Promise<void> {
    try {
      const stored = await getMarksByDoc(docId);
      if (stored.length === 0) {
        // 没有批注就不需要块文本索引：blockTexts 是懒解析的（一万条解析在真机上近 1s）
        if (store.getState().currentDocId === docId) store.dispatch({ type: 'marks/loaded', marks: [] });
        return;
      }
      const relocated = relocateMarks(stored, render.blockTexts);
      if (store.getState().currentDocId !== docId) return;
      store.dispatch({ type: 'marks/loaded', marks: relocated.marks });
      for (const mark of relocated.changed) void putMark(mark);
    } catch (error) {
      console.warn('读取标注失败', error);
      if (store.getState().currentDocId === docId) {
        store.dispatch({ type: 'marks/loaded', marks: [] });
        toast('批注读取失败');
      }
    }
  }

  // ── 备份与恢复（阶段 E3）────────────────────────────
  /** 已在确认弹层里等待恢复的备份数据。 */
  let pendingRestore: BackupData | null = null;

  /** 触发浏览器下载；环境不支持返回 false（由调用方改用剪贴板）。 */
  function downloadText(filename: string, text: string, mime = 'application/json'): boolean {
    try {
      const blob = new Blob([text], { type: mime });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.rel = 'noopener';
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 导出备份。
   * WebView 对 Blob 下载支持不一致，所以同时写剪贴板：
   * 下载成功与否无法可靠探测，就明确告诉用户两条路径都给了。
   */
  function exportBackup(): void {
    void collectBackupData()
      .then((data) => {
        const text = buildBackup(data, {
          appVersion: APP_VERSION,
          exportedAt: new Date().toISOString(),
        });
        const stamp = new Date().toISOString().slice(0, 10);
        downloadText(`mdlego-backup-${stamp}.json`, text);
        void writeClipboard(text).then((ok) => {
          toast(ok ? '备份已生成；若未出现下载，可从剪贴板粘贴保存' : '备份已生成（系统未允许写剪贴板）');
        });
      })
      .catch((error: unknown) => {
        toast(`导出失败：${error instanceof Error ? error.message : String(error)}`);
      });
  }

  /** 校验备份并弹确认框；真正覆盖在用户确认后才做。 */
  function requestRestore(text: string): void {
    const parsed = parseBackup(text);
    if (!parsed.ok) {
      toast(parsed.reason);
      return;
    }
    const { summary } = parsed;
    pendingRestore = parsed.file.data;
    openMenu({
      variant: 'dialog',
      title: '恢复备份？',
      items: [
        {
          id: 'restore-confirm',
          testId: 'restore-confirm',
          label: `覆盖本机数据（${summary.docs} 篇文档 / ${summary.marks} 条批注）`,
          danger: true,
          onSelect: () => {
            const data = pendingRestore;
            pendingRestore = null;
            if (data !== null) void performRestore(data);
          },
        },
        {
          id: 'restore-cancel',
          testId: 'restore-cancel',
          label: '取消',
          onSelect: () => {
            pendingRestore = null;
          },
        },
      ],
    });
  }

  /**
   * 覆盖写入并把状态同步回内存。
   * 不整页重载：先落库，再按备份内容 dispatch，界面立刻反映恢复结果，
   * 也避免重载过程中 toast 被吞掉（smoke 曾经抓不到）。
   */
  async function performRestore(data: BackupData): Promise<void> {
    try {
      await applyBackupData(data);
      store.dispatch({ type: 'docs/loaded', docs: data.docs });
      store.dispatch({ type: 'tasks/loaded', tasks: data.tasks });
      store.dispatch({ type: 'bookmarks/loaded', bookmarks: data.bookmarks });
      store.dispatch({ type: 'marks/loaded', marks: [] });
      store.dispatch({ type: 'words/loaded', words: data.vocabulary });
      store.dispatch({ type: 'settings/changed', patch: data.settings as Partial<Settings> });
      await refreshStats();
      toast(`已恢复备份：${data.docs.length} 篇文档 / ${data.marks.length} 条批注`);
    } catch (error) {
      toast(`恢复失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function importBackupFile(file: File): void {
    void file
      .text()
      .then(requestRestore)
      .catch(() => toast('读取备份文件失败'));
  }

  function importBackupClipboard(): void {
    const clipboard = navigator.clipboard;
    if (clipboard === undefined || typeof clipboard.readText !== 'function') {
      toast('当前环境不支持读取剪贴板，请用文件恢复');
      return;
    }
    void clipboard
      .readText()
      .then(requestRestore)
      .catch(() => toast('读取剪贴板失败，请检查权限或用文件恢复'));
  }

  // ── 编辑原文（阶段 E5）───────────────────────────────
  function openEditor(docId: string): void {
    store.dispatch({ type: 'nav/push', page: { kind: 'editor', docId } });
  }

  /** 把新文本同步给当前阅读页（若正在读这篇）：重建渲染并重载批注锚点。 */
  function refreshReaderForDoc(docId: string, text: string): void {
    const state = store.getState();
    if (state.currentDocId !== docId) return;
    void renderMarkdownAsync(text)
      .then((render) => {
        if (store.getState().currentDocId !== docId) return;
        store.dispatch({ type: 'reader/ready', render });
        void loadMarksForDoc(docId, render);
      })
      .catch((error: unknown) => {
        console.warn('保存后重渲染失败', error);
      });
  }

  /** 新建「应用内副本」文档（另存为）。 */
  function createEditedCopy(source: Doc, text: string, sha256: string): Doc {
    const now = Date.now();
    return {
      id: `doc-copy-${now.toString(36)}-${sha256.slice(0, 8)}`,
      title: titleFromText(text, source.title),
      text,
      encoding: 'utf-8',
      source: { kind: 'inline' },
      fingerprint: null,
      importedAt: now,
      lastReadAt: source.lastReadAt,
      progress: source.progress,
      tags: source.tags ?? [],
      folder: source.folder ?? null,
    };
  }

  async function saveEditedDoc(
    docId: string,
    rawText: string,
    mode: 'auto' | 'force' | 'copy',
  ): Promise<'saved' | 'copied' | 'conflict' | 'no-original' | 'missing' | 'failed'> {
    const state = store.getState();
    const doc = state.docs.find((item) => item.id === docId);
    if (doc === undefined) return 'failed';
    const text = normalizeEditedText(rawText);
    const bytes = new TextEncoder().encode(text);
    let sha256: string;
    try {
      sha256 = await sha256Hex(bytes);
    } catch {
      toast('计算内容指纹失败，未保存');
      return 'failed';
    }

    // 读原文件快照做冲突检测（浏览器/内部文档读不到 → no-original）
    let snapshot: OriginalSnapshot | null = null;
    if (doc.source.kind === 'file' && isNative()) {
      try {
        const files = await readNativeFiles([doc.source.uri]);
        const file = files[0];
        if (file === undefined) {
          snapshot = { exists: false, sha256: null, size: -1, mtimeMs: null };
        } else {
          const fresh = base64ToBytes(file.base64);
          snapshot = {
            exists: true,
            sha256: await sha256Hex(fresh),
            size: fresh.length,
            mtimeMs: file.mtimeMs,
          };
        }
      } catch {
        snapshot = { exists: false, sha256: null, size: -1, mtimeMs: null };
      }
    }

    // 浏览器里拿不到原文件：不要把「读不到」误报成「原文件消失」
    const decision =
      !isNative() && doc.source.kind === 'file' ? 'no-original' as const : decideSave(doc, snapshot);
    if (mode === 'copy') return saveCopy(doc, text, sha256);

    if (mode === 'auto' && (decision === 'conflict' || decision === 'no-original' || decision === 'missing')) {
      return decision;
    }

    // 覆盖保存：能写原文件就写；写不了（浏览器/无原文件/写失败）退回应用内副本
    if (decision === 'write' && doc.source.kind === 'file') {
      const written = await writeDocument(doc.source.uri, bytes);
      if (!written) {
        toast('写回原文件失败，已改为另存应用内副本');
        return saveCopy(doc, text, sha256);
      }
      const next: Doc = {
        ...doc,
        text,
        title: titleFromText(text, doc.title),
        fingerprint: updatedFingerprint(bytes.length, sha256, snapshot?.mtimeMs ?? null),
      };
      store.dispatch({ type: 'doc/updated', doc: next });
      try {
        await saveDoc(next);
      } catch {
        toast('内容已写回原文件，但本地记录保存失败');
      }
      refreshReaderForDoc(doc.id, text);
      store.dispatch({ type: 'nav/back' });
      return 'saved';
    }

    // force 且无原文件/原文件消失：只能存副本
    return saveCopy(doc, text, sha256);
  }

  function saveCopy(source: Doc, text: string, sha256: string): 'copied' | 'failed' {
    const copy = createEditedCopy(source, text, sha256);
    store.dispatch({ type: 'doc/imported', doc: copy });
    void saveDoc(copy).catch(() => toast('副本保存失败'));
    toast('已存为应用内副本');
    store.dispatch({ type: 'nav/back' });
    return 'copied';
  }

  // ── 导出 / 打印（阶段 E6）───────────────────────────
  function exportHtml(): void {
    const state = store.getState();
    const doc = state.docs.find((item) => item.id === state.currentDocId);
    if (doc === undefined || state.render === null) {
      toast('请先打开一篇文档');
      return;
    }
    const rootStyle = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string): string => rootStyle.getPropertyValue(name).trim() || fallback;
    const html = buildExportHtml({
      title: doc.title,
      bodyHtml: state.render.html,
      dark: document.documentElement.getAttribute('data-scheme') === 'dark',
      palette: {
        ink: token('--ink', 'CanvasText'),
        paper: token('--paper', 'Canvas'),
        soft: token('--ink-soft', 'GrayText'),
        rule: token('--rule', 'GrayText'),
        accent: token('--accent', 'LinkText'),
        codeBg: token('--paper-raised', 'Canvas'),
      },
    });
    const name = `${doc.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || '文档'}.html`;
    downloadText(name, html, 'text/html');
    void writeClipboard(html).then((ok) => {
      toast(ok ? '已导出 HTML（同时复制到剪贴板）' : '已导出 HTML');
    });
  }

  function printDocument(): void {
    try {
      window.print();
      toast('已调用系统打印；若系统无打印服务则不会弹出对话框');
    } catch {
      toast('当前环境不支持打印');
    }
  }

  // ── 生词本 / 查词历史（阶段 E4）──────────────────────
  /** 生词本面板当前的初始分段。 */
  let wordbookTab: WordbookTab = 'words';

  function addOrRemoveWord(entry: { word: string; phonetic: string; translation: string }): void {
    const state = store.getState();
    const normalized = entry.word.trim().toLowerCase();
    if (hasWord(state.words, normalized)) {
      const next = removeWordEntry(state.words, normalized);
      store.dispatch({ type: 'words/loaded', words: next });
      void saveWordbook(next).catch(() => toast('生词本保存失败'));
      toast('已从生词本移除');
      return;
    }
    const word: WordEntry = {
      word: normalized,
      phonetic: entry.phonetic,
      translation: entry.translation,
      addedAt: Date.now(),
    };
    const result = upsertWord(state.words, word);
    store.dispatch({ type: 'words/loaded', words: result.words });
    void saveWordbook(result.words).catch(() => toast('生词本保存失败'));
    toast(result.added ? '已加入生词本' : '已更新生词条目');
  }

  function recordLookup(word: string): void {
    const next = pushHistory(store.getState().lookupHistory, word, Date.now());
    store.dispatch({ type: 'lookup-history/loaded', history: next });
    void saveLookupHistory(next).catch((error: unknown) => {
      console.warn('查词历史保存失败', error);
    });
  }

  function openWordbook(tab: WordbookTab): void {
    wordbookTab = tab;
    store.dispatch({ type: 'layer/opened', layer: 'wordbook' });
  }

  function wordbookInput(): { words: readonly WordEntry[]; history: readonly { word: string; at: number }[]; tab: WordbookTab } {
    const state = store.getState();
    return { words: state.words, history: state.lookupHistory, tab: wordbookTab };
  }

  function removeWordFromBook(word: string): void {
    const next = removeWordEntry(store.getState().words, word);
    store.dispatch({ type: 'words/loaded', words: next });
    void saveWordbook(next).catch(() => toast('生词本保存失败'));
  }

  function clearWordbook(): void {
    store.dispatch({ type: 'words/loaded', words: [] });
    void saveWordbook([]).catch(() => toast('生词本保存失败'));
    toast('已清空生词本');
  }

  function clearLookupHistory(): void {
    store.dispatch({ type: 'lookup-history/loaded', history: [] });
    void saveLookupHistory([]).catch(() => toast('查词历史保存失败'));
    toast('已清空查词历史');
  }

  function switchWordbookTab(tab: WordbookTab): void {
    wordbookTab = tab;
    layers.sync(store.getState());
  }

  // ── 标签 / 文件夹面板（阶段 E1）──────────────────────────
  /** 当前要编辑的集合；关闭 collection 浮层时清空。 */
  let currentCollection: CollectionSpec | null = null;

  /** 把变更后的文档写回库并更新状态（只处理真正变了的文档）。 */
  function persistChangedDocs(next: readonly Doc[]): void {
    const prev = store.getState().docs;
    for (const doc of next) {
      const old = prev.find((d) => d.id === doc.id);
      if (old === undefined || old === doc) continue;
      store.dispatch({ type: 'doc/updated', doc });
      void saveDoc(doc).catch((error: unknown) => {
        console.warn('标签/文件夹保存失败', error);
        toast('保存失败，请重试');
      });
    }
  }

  function openTagEditor(docIds: readonly string[]): void {
    if (docIds.length === 0) return;
    currentCollection = { kind: 'tags', docIds };
    store.dispatch({ type: 'layer/opened', layer: 'collection' });
  }

  function openFolderEditor(docIds: readonly string[]): void {
    if (docIds.length === 0) return;
    currentCollection = { kind: 'folder', docIds };
    store.dispatch({ type: 'layer/opened', layer: 'collection' });
  }

  /** 标签/文件夹面板的三个写操作（面板每次点击就调用，立即生效）。 */
  function addTagToSelected(docIds: readonly string[], tag: string): void {
    persistChangedDocs(addTagToDocs(store.getState().docs, docIds, tag));
  }

  function removeTagFromSelected(docIds: readonly string[], tag: string): void {
    persistChangedDocs(removeTagFromDocs(store.getState().docs, docIds, tag));
  }

  function setFolderForSelected(docIds: readonly string[], folder: string | null): void {
    persistChangedDocs(setFolderForDocs(store.getState().docs, docIds, folder));
  }

  /** 屏幕常亮：设置开启且正在阅读（前台）时持有 Wake Lock，其余情况释放。 */
  function syncWakeLock(state: State): void {
    const hold =
      state.settings.keepAwake && state.currentDocId !== null && document.visibilityState !== 'hidden';
    if (hold) void requestScreenWakeLock();
    else releaseScreenWakeLock();
  }

  /** 选横幅背景：先缩图压到可存进 localStorage 的尺寸，存不下就明确告诉用户。 */
  function pickBanner(): void {
    void pickBannerImage()
      .then((data) => {
        if (data === null) {
          toast('这张图片不可用（格式不支持，或压缩后仍太大）');
          return;
        }
        store.dispatch({ type: 'settings/changed', patch: { bannerImage: data } });
        toast('已设置横幅背景');
      })
      .catch((error: unknown) => {
        toast(`选择图片失败：${error instanceof Error ? error.message : String(error)}`);
      });
  }

  function clearBanner(): void {
    store.dispatch({ type: 'settings/changed', patch: { bannerImage: null } });
  }

  /** 清空阅读统计（只删会话记录，文档与批注不动）。 */
  /** 导出诊断日志（F3）：版本/构建号/环境/状态摘要/错误列表，JSON。 */
  function exportDiagnostics(): void {
    const state = store.getState();
    const report = buildDiagnosticsReport({
      appVersion: APP_VERSION,
      buildId: BUILD_ID,
      state: {
        docs: state.docs.length,
        currentDocId: state.currentDocId,
        readerStatus: state.readerStatus,
        navPages: state.nav.pages.length,
        layers: state.nav.layers,
        settings: state.settings,
        bookmarks: state.bookmarks.length,
        motion: motionLevel(),
        theme: state.settings.theme,
        scheme: document.documentElement.getAttribute('data-scheme') ?? '',
      },
    });
    const text = JSON.stringify(report, null, 2);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadText(`mdlego-diagnostics-${stamp}.json`, text);
    void writeClipboard(text).then((ok) => {
      toast(ok ? '诊断日志已生成，同时写入剪贴板' : '诊断日志已生成（系统未允许写剪贴板）');
    });
  }

  /** 清空诊断日志（设置页用）。 */
  function clearDiagnosticsLog(): void {
    clearDiagLog();
    toast('诊断日志已清空');
  }

  function clearStats(): void {
    void clearSessions()
      .then(() => {
        store.dispatch({ type: 'stats/loaded', stats: null });
        toast('已清空阅读统计');
      })
      .catch((error: unknown) => {
        toast(`清空失败：${error instanceof Error ? error.message : String(error)}`);
      });
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
    openTagEditor,
    openFolderEditor,
    addSelectionMark,
    openNoteForSelection,
    openNoteForMark,
    removeMark,
    openMarks,
    copyText: copyToClipboard,
    lookupWord,
    openWordbook,
    isReanchorPending: () => pendingReanchor !== null,
    reanchorSelection: reanchorTo,
    exportBackup,
    importBackupFile,
    importBackupClipboard,
    openEditor,
    saveEditedDoc,
    exportHtml,
    printDocument,
    pickBanner,
    clearBanner,
    clearStats,
    exportDiagnostics,
    clearDiagnostics: clearDiagnosticsLog,
    diagnosticsCount,
    toast,
    appVersion: APP_VERSION,
    buildId: BUILD_ID,
    sample: '',
    renderMarkdown,
  };

  // ── F3 错误边界：全局错误进诊断日志（本地持久化，设置页可导出）──
  let lastDiagToastAt = 0;
  installDiagnostics({
    onRecord: () => {
      const now = Date.now();
      // 同一批异常只提示一次，避免错误风暴把界面刷屏
      if (now - lastDiagToastAt < 15000) return;
      lastDiagToastAt = now;
      toast('出错了，已记录诊断日志（设置 → 导出日志）');
    },
  });

  /**
   * 「即将/正在恢复阅读进度」标记。
   * 由 openDoc() 置起、进度恢复那一帧结束后清除；hashchange 归零要避开它。
   */
  let restorePending = false;
  /** 转场收尾后要补滚到的位置（阅读页在遮罩层里时 window 滚动会被夹到 0）。 */
  let pendingRestoreTop: number | null = null;

  /**
   * 打开转场期间真正的滚动容器（转场改造 Step 1 + Step 3）。
   *
   * Step 3 把遮罩层拆成了「几何形变壳 .page-mask + 内部阅读视口层
   * .page-mask__reader」：形变壳只做 transform，滚动发生在内部的 reader 层上
   * （否则缩放会把 scrollTop 语义乘上 scale，锚点定位全部错位）。
   * 所以这里必须返回 .page-mask__reader，而不是 .page-mask。
   */
  function maskScroller(): HTMLElement | null {
    return root.querySelector<HTMLElement>('[data-testid="page-mask-reader"]');
  }

  /**
   * 首帧同步锚定：正文窗口已按锚点挂好，这里把视图滚到目标块。
   *
   * 与旧的 `restoreProgressIncremental` 的区别：**不再逐帧追分片**。
   * 目标块在首屏窗口里同步存在，一次测量就能定位；
   * 只有外部深链目标异常未命中时才退回按需挂载的兜底路径。
   */
  function anchorFirstFrame(bid: string, ratio: number): boolean {
    const pageEl = mounted();
    if (pageEl === null) return false;
    const target = pageEl.querySelector<HTMLElement>(`[data-bid="${CSS.escape(bid)}"]`);
    if (target === null) return false;
    // 阅读页在挂载首屏时已经在同一同步栈内做过锚定（见 reader.ts::anchorToBlock）。
    // 这里绝不重复写一次 scrollTop：第二次写入是在**已经滚动过**的基座上
    // 重新测量并再减一遍相关高度，会叠加出固定偏差（实测 300px 量级，
    // 正好是窗口内首块与目标块之间的高度差）。
    if (pageEl.dataset['anchored'] === '1') {
      activeBid = bid;
      pageEl.dispatchEvent(new CustomEvent('mdlego:anchor-settled'));
      return true;
    }
    const offset = appbarBottom();
    const mask = maskScroller();
    // 同上：转场期间的形变壳带 scale，必须把视觉坐标换算回布局坐标
    const scale = visualScale(target);
    if (mask !== null) {
      // 遮罩层是 fixed 全屏滚动容器：把偏移写在这里，转场收尾时由 page-mask
      // 在解绑 fixed 的同一同步帧里交给 window（见 runOpenMask 的 cleanup）。
      const rect = target.getBoundingClientRect();
      const top = Math.max(0, rect.top * scale + mask.scrollTop - offset + ratio * rect.height * scale);
      mask.scrollTop = top;
    } else {
      const rect = target.getBoundingClientRect();
      const top = Math.max(0, rect.top * scale + window.scrollY - offset + ratio * rect.height * scale);
      window.scrollTo(0, top);
    }
    activeBid = bid;
    // 让阅读页把进度条控制权交回给真实滚动计算
    pageEl.dispatchEvent(new CustomEvent('mdlego:anchor-settled'));
    return true;
  }

  /**
   * 进度恢复兜底：目标块确实不在已挂载窗口里时，逐帧让阅读页补分片再试。
   *
   * 正常打开有进度的书籍**不会**走到这里（首屏窗口已经包含目标块）；
   * 只有深链目标越界、或渲染结果与保存的 bid 对不上时才用得上。
   * 900KB 文档整篇同步补齐在真机上是一个 1s 长任务；逐帧补则每帧只做一小片。
   */
  function restoreProgressIncremental(bid: string, ratio: number): void {
    restorePending = true;
    const startedAt = performance.now();
    const currentPage = (): HTMLElement | null => mounted();
    const stop = (): void => {
      restorePending = false;
      currentPage()?.removeAttribute('data-restoring');
    };
    currentPage()?.setAttribute('data-restoring', '1');
    const step = (): void => {
      if (store.getState().currentDocId === null) {
        stop();
        return;
      }
      if (scrollToBid(bid, ratio, 'auto', false)) {
        stop();
        return;
      }
      const pageEl = currentPage();
      if (pageEl === null) {
        stop();
        return;
      }
      pageEl.setAttribute('data-restoring', '1');
      // cancelable：阅读页还有分片时会 preventDefault（返回 false）
      const more = pageEl.dispatchEvent(new CustomEvent('mdlego:mount-next', { cancelable: true })) === false;
      if (!more || performance.now() - startedAt > 8000) {
        // 分片挂完仍找不到（或超时）：放弃恢复，保持顶部，避免卡死
        stop();
        return;
      }
      requestAnimationFrame(step);
    };
    // 等渲染结果落一帧再开始，避免和首屏挂载抢同一帧
    requestAnimationFrame(() => requestAnimationFrame(step));
  }

  /** 打开文档：渲染（Worker 优先，大文档不卡首帧）并恢复进度。 */
  function openDoc(docId: string): void {
    const state = store.getState();
    const doc = state.docs.find((d) => d.id === docId);
    if (doc === null || doc === undefined) return;

    // 统计从这里开始计时（切文档会先结掉上一篇）
    startSession(docId);

    // 记录阅读时间并持久化
    const updated: Doc = { ...doc, lastReadAt: Date.now() };
    store.dispatch({ type: 'doc/updated', doc: updated });
    void saveDoc(updated);

    // 解析/渲染放 Worker：主线程只挂首屏分片，遮罩转场首帧不被 900KB 文档卡住
    void renderMarkdownAsync(doc.text)
      .then((render) => {
        // 渲染期间用户可能已经返回/切走：过期结果不能写进当前阅读页
        if (store.getState().currentDocId !== docId) return;
        store.dispatch({ type: 'reader/ready', render });
        // 批注在正文分片全部挂完后再读：首次访问 blockTexts 要解析一万条块文本，
        // 放在打开窗口/挂载中途都是 >50ms 长任务。
        let marksLoaded = false;
        let marksFallback = 0;
        const loadMarks = (): void => {
          if (marksLoaded) return;
          marksLoaded = true;
          if (marksFallback !== 0) window.clearTimeout(marksFallback);
          if (store.getState().currentDocId !== docId) return;
          void loadMarksForDoc(docId, render);
        };
        const pageEl = mounted();
        if (pageEl !== null && pageEl.getAttribute('data-article') === 'complete') loadMarks();
        else if (pageEl !== null) pageEl.addEventListener('mdlego:article-complete', loadMarks, { once: true });
        // 兜底：极端情况下正文一直没挂完（用户立刻返回等），别让批注永远不出现
        marksFallback = window.setTimeout(loadMarks, 15000);

        // 恢复阅读进度（转场改造 Step 1）：
        // 正文首屏窗口已经以目标 bid 为中心同步挂好，这里直接一次测量定位，
        // 不再「先露第 0 屏 → 逐帧挂分片追赶」。目标块异常未命中时才走兜底。
        if (doc.progress !== null) {
          const { bid, ratio } = doc.progress;
          restorePending = true;
          if (anchorFirstFrame(bid, ratio)) {
            restorePending = false;
          } else {
            restoreProgressIncremental(bid, ratio);
          }
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        recordDiagnostic({
          kind: 'render',
          message: `阅读页渲染失败：${message}`,
          ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
          extra: { docId },
        });
        store.dispatch({ type: 'reader/error', message });
      });
  }

  /** 拦截 doc/opened，触发真正的渲染。 */
  const originalDispatch = deps.dispatch;

  /** 宿主在下面创建；转场回调只会发生在启动完成之后，所以用可空引用避开声明顺序。 */
  let hostRef: AppHost | null = null;

  /** 当前生效的动效强度（系统 reduce 已折算）。 */
  function motionLevel(): MotionLevel {
    return effectiveMotionChoice(store.getState().settings.motion);
  }

  /** 书架里某篇文档的封面节点（转场共享矩形用）。 */
  function coverForDoc(docId: string): HTMLElement | null {
    return root.querySelector<HTMLElement>(`[data-cover-doc="${CSS.escape(docId)}"]`);
  }

  /**
   * 优先取「书架网格里的那张封面」。
   *
   * 同一篇文章会同时出现在「继续阅读」和「我的书架」两处，
   * `querySelector` 永远命中 DOM 里第一个（继续阅读），返回书架时就会把
   * 错误的封面抓去做形变。网格是用户认知里的「书的位置」，先取它。
   */
  function preferredCoverForDoc(docId: string): HTMLElement | null {
    const grid = root.querySelector<HTMLElement>(`[data-testid="shelf-grid"]`);
    const inGrid = grid?.querySelector<HTMLElement>(`[data-cover-doc="${CSS.escape(docId)}"]`) ?? null;
    return inGrid ?? coverForDoc(docId);
  }

  /**
   * 用户点的那个元素所在卡片里的封面。
   *
   * 点标题/空白处时 `closest('[data-cover-doc]')` 找不到封面（封面是兄弟节点），
   * 必须先 `closest('[data-doc-id]')` 找到被点的卡片，再在卡片内部取封面。
   */
  function coverWithinClickedCard(docId: string): HTMLElement | null {
    const target = lastPointerTarget;
    if (!(target instanceof Element)) return null;
    const card = target.closest<HTMLElement>('[data-doc-id]');
    if (card === null || card.dataset['docId'] !== docId) return null;
    return card.querySelector<HTMLElement>(`[data-cover-doc="${CSS.escape(docId)}"]`);
  }

  /** 转场来源封面：被点卡片内部 → 网格 → 继续阅读；都没有则返回 null（降级为普通转场）。 */
  function sourceCover(docId: string): HTMLElement | null {
    return coverWithinClickedCard(docId) ?? preferredCoverForDoc(docId);
  }

  const mounted = (): HTMLElement | null => hostRef?.mountedElement() ?? null;

  /** 左缘右滑提交时的当前位移：关闭动画从这里接着播，不再叠第二套转场。 */
  let pendingSwipeOffset = 0;
  /**
   * 预测式返回松手时的实时形变矩阵（转场改造 Step 4）。
   * 有值时关闭动画直接以它为起始关键帧 —— 严禁先弹回全屏再重播关闭动画。
   */
  let pendingMorphState: MorphState | null = null;

  // ── 预测式返回：原生桥接 + 跟手缩窗（转场改造 Step 4）────────
  /** 预测式返回跟手控制器（挂载在下方）。 */
  let backGesture: BackGestureController;
  /** 跟手期间临时压上的形变层句柄（生命周期由 gesture-stage.ts 管）。 */
  let gestureStage: GestureStage | null = null;

  /** 当前退栈状态快照（供 core/back-gesture.ts 的纯函数决策）。 */
  function currentBackStack(): BackStack {
    const nav = store.getState().nav;
    return {
      pageDepth: nav.pages.length,
      layerDepth: nav.layers.length,
      topIsReader: topPage(nav).kind === 'reader',
    };
  }

  /**
   * 同步原生侧的返回拦截开关。
   *
   * 铁律：书架根页面且没有任何浮层时必须注销回调，
   * 否则系统会认为应用要自己消费返回，废掉「缩回桌面图标」的原生动画。
   * 每次导航状态变化都调用一次（幂等，原生侧自己去重）。
   */
  let lastIntercept: boolean | null = null;
  function syncBackIntercept(): void {
    const wanted = shouldInterceptBack(currentBackStack());
    if (wanted === lastIntercept) return;
    lastIntercept = wanted;
    void setNativeBackIntercept(wanted);
  }

  /**
   * 跟手开始：建一个「空转」的形变层，但**不**播放动画。
   *
   * 只摆临时层，不碰真实页面（真实页面只被加一个类名隐藏）。
   * 逐帧矩阵由 onMove 驱动，松手后交给关闭转场接着播。
   *
   * 关于「底层书架」：v1.2.0 想在这里露出书架并做景深，于是去找
   * 「转场层前面那个兄弟节点」，结果拿到的是**真实阅读页**，
   * 每帧给它写 transform，取消后又不还原 —— 这就是「页面错位 / 白屏」。
   * 现在不再这么做：手势期间底下就是压暗层，书架等 commit 时由
   * runCloseMask 的 update() 切出来（那时才需要书架）。
   */
  function prepareCloseForGesture(): void {
    // 任何残留转场先落地，避免两层叠在一起
    settlePageTransition();
    if (store.getState().currentDocId === null) {
      endGestureStage();
      return;
    }
    gestureStage = beginGestureStage({
      page: mounted(),
      viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
    });
  }

  /**
   * 跟手推进：把实时矩阵写到临时层上。
   *
   * **只动临时层自己**，绝不碰真实页面。压暗层随跟手进度微调透明度，
   * 这就是手势期间全部的视觉反馈。
   */
  function applyGestureMorph(state: MorphState): void {
    if (gestureStage === null) return;
    gestureStage.apply(state);
    // 压暗层：跟手越深越暗（用半径反推阻尼，与 core/morph 的公式同源）
    const damped = Math.max(0, Math.min(1, state.radius / FOLLOW_RADIUS_MAX));
    const scrim = gestureStage.element.previousElementSibling;
    if (scrim instanceof HTMLElement && scrim.classList.contains('page-mask-scrim')) {
      scrim.style.opacity = String(scrimOpacity(damped, false));
    }
  }

  /** 跟手取消：从当前矩阵回弹到全屏，然后拆掉临时层。 */
  function reboundFromGesture(from: MorphState): void {
    const stage = gestureStage;
    gestureStage = null;
    if (stage === null) {
      endGesture();
      return;
    }
    const anim = stage.element.animate(
      [
        { transform: transformOf(from) },
        { transform: transformOf(FULL_STATE) },
      ],
      { duration: MOVE_CANCEL_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' },
    );
    // 不能只等 finished：息屏/切后台时 WebView 会冻结动画时间线，
    // finished 永不 resolve，临时层就永远拆不掉（应用看起来卡死）。
    // 与「动画结束」赛跑一个超时，谁先到谁收尾。
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      stage.end();
      assertPageIntegrity();
    };
    const timer = window.setTimeout(finish, MOVE_CANCEL_MS + 120);
    anim.finished.then(finish, finish);
  }

  /**
   * 手势收尾的唯一出口（幂等）。
   *
   * 任务书要求：取消、提交、新手势开始、visibilitychange、pagehide、
   * 路由变化 —— 任一情形都必须先调它。这里把「临时层拆除」与
   * 「完整性检查」放在一起，作为最后一道防线。
   */
  function endGesture(): void {
    gestureStage = null;
    endGestureStage();
    assertPageIntegrity();
  }

  /**
   * 手势结束后的完整性检查（1.2.1 #A 兜底）。
   *
   * 白屏的两个已知成因都能在这里被抓到：
   *   1 真实页面被残留的隐藏类 / 内联样式遮住；
   *   2 临时层没拆干净，盖在阅读页上面。
   *
   * 检查失败就用当前 store 状态强制重建视图 —— 宁可闪一下，
   * 也不能让用户停在白屏上。
   */
  function assertPageIntegrity(): void {
    const pageEl = mounted();
    if (pageEl === null) return;
    const strayLayers = document.querySelectorAll('.page-mask, .page-mask-scrim').length;
    const hidden = pageEl.classList.contains(GESTURE_HIDDEN_CLASS);
    // 真实页面被写了 transform 也算异常（历史 bug 的痕迹，防复发）
    const dirtyStyle = pageEl.getAttribute('style')?.includes('transform') === true;
    if (strayLayers === 0 && !hidden && !dirtyStyle) return;
    document.querySelectorAll('.page-mask, .page-mask-scrim').forEach((el) => el.remove());
    pageEl.classList.remove(GESTURE_HIDDEN_CLASS);
    if (dirtyStyle) pageEl.removeAttribute('style');
    hostRef?.update(store.getState());
  }

  /** 转场收尾后通知页面（阅读页收到后挂载剩余正文）。 */
  function notifyTransitionEnd(): void {
    if (pendingRestoreTop !== null) {
      const top = pendingRestoreTop;
      pendingRestoreTop = null;
      window.scrollTo(0, top);
      window.dispatchEvent(new Event('scroll'));
    }
    mounted()?.dispatchEvent(new CustomEvent('mdlego:transition-end'));
  }

  /** 被点击的卡片矩形（网格/列表卡片，或「继续阅读」整卡）；用于遮罩起点。 */
  function startCardRect(target: EventTarget | null): MaskRect | null {
    if (!(target instanceof Element)) return null;
    const card = target.closest<HTMLElement>('[data-doc-id], [data-testid="continue-open"]');
    return card === null ? null : rectOfElement(card);
  }

  /**
   * 转场形变几何矩形：取**封面元素**，不是整张卡片。
   *
   * `.book-card` 是整个可点区域（封面 + 标题 + 时间 + 进度条），
   * 它自身 `border-radius: 0`；真正带 18px 圆角、3:4 比例的是内部
   * `.cover`。形变起止点必须取封面，否则：
   *   - 圆角补偿算出来是 0（一上来就是直角，收尾也是硬角）；
   *   - 展开/收拢范围把标题与进度条也吞进去，与「书封落回卡槽」不符。
   */
  function morphRectOf(card: HTMLElement | null): MaskRect | null {
    const cover = coverElementOf(card);
    if (cover === null) return null;
    const rect = rectOfElement(cover);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const visible = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
    return visible ? rect : null;
  }

  /** 卡片内部真正的封面元素（带 data-cover / 圆角 / 色板）。 */
  function coverElementOf(card: HTMLElement | null): HTMLElement | null {
    if (card === null) return null;
    if (card.matches('[data-cover]')) return card;
    return card.querySelector<HTMLElement>('[data-cover]');
  }

  /**
   * 关闭动画的目标矩形：**关闭时重新测量**书架里当前这本书的封面。
   * 阅读后该书可能被排到最前；优先网格卡片，其次「继续阅读」卡片；
   * 找不到或不在可视区返回 null（降级为中心缩放淡出）。
   */
  function targetCardRect(docId: string | null): MaskRect | null {
    if (docId === null || hostRef === null) return null;
    const el = targetCardElement(docId);
    const cover = coverElementOf(el);
    if (cover === null) return null;
    // 卡片入场动画（错峰淡入上移）会给 rect 叠加 translateY(10px)：
    // 先把动画结算到终态，再量目标矩形，否则关闭终点会差 10px。
    for (const animation of el?.getAnimations() ?? []) {
      try { animation.finish(); } catch { /* 无限动画不能 finish */ }
    }
    return morphRectOf(el);
  }

  /**
   * 关闭转场的目标卡片元素（网格优先，其次「继续阅读」卡）。
   * 用于原卡槽防重影（转场期间隐身）与封面视觉克隆。
   */
  function targetCardElement(docId: string | null): HTMLElement | null {
    if (docId === null || hostRef === null) return null;
    const id = CSS.escape(docId);
    const gridCard = root.querySelector<HTMLElement>(`[data-testid="shelf-grid"] [data-doc-id="${id}"]`);
    const continueCover = root.querySelector<HTMLElement>(`[data-testid="continue-open"] [data-cover-doc="${id}"]`);
    return gridCard ?? continueCover?.closest<HTMLElement>('[data-testid="continue-open"]') ?? null;
  }

  deps.dispatch = (action: StateAction): void => {
    // 主题切换：从最近点击位置圆形扩散（任务书 §4.2）
    if (action.type === 'settings/changed' && action.patch.theme !== undefined) {
      runThemeReveal(motionLevel(), lastPointer, () => originalDispatch(action));
      return;
    }

    if (action.type === 'doc/opened') {
      const docId = action.docId;
      // 从「被点卡片」的矩形展开（点标题/封面/空白处都算整张卡片）
      // 记下被点的卡片元素：转场要克隆它的封面视觉，并把它临时隐身防重影。
      // 拿不到指针目标时（键盘/程序触发）退回按 docId 查书架卡片。
      const card = (lastPointerTarget instanceof Element
        ? lastPointerTarget.closest<HTMLElement>('[data-doc-id], [data-testid="continue-open"]')
        : null) ?? targetCardElement(docId);
      setLastClickedCard(card);
      // 形变起止点取封面（带 18px 圆角、3:4 比例），不是整张卡片。
      const startRect = morphRectOf(card) ?? startCardRect(lastPointerTarget);
      runOpenMask({
        level: motionLevel(),
        startRect,
        getPrevious: mounted,
        getMounted: mounted,
        slotElement: coverElementOf(card),
        // update() 会重渲染书架：必须用 docId 在 update 之后重新取实时节点，
        // 否则隐身类加在已被替换的旧节点上，屏幕仍会出现两个相同封面。
        resolveSlot: () => coverElementOf(targetCardElement(docId)),
        update: () => {
          store.dispatch(action);
          openDoc(docId);
        },
        onSettled: notifyTransitionEnd,
      });
      return;
    }

    // 离开阅读页（返回/进设置/切 tab/关文档）之前先存进度：此刻正文还挂着，位置才量得准。
    if (action.type === 'doc/closed' || action.type.startsWith('nav/')) {
      const nav = store.getState().nav;
      if (topPage(nav).kind === 'reader' && nav.layers.length === 0) {
        persistProgress();
        finishSession();
      }
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

    // ── 页面级转场（阶段 D2）───────────────────────────────
    if (action.type === 'doc/closed') {
      // 关文档：阅读页可见窗口缩回书架上这本书的卡片（重新测量）
      const docId = store.getState().currentDocId;
      runCloseMask({
        level: motionLevel(),
        getPrevious: mounted,
        getMounted: mounted,
        update: () => originalDispatch(action),
        findTarget: () => targetCardRect(docId),
        findTargetElement: () => coverElementOf(targetCardElement(docId)),
        resolveSlot: () => coverElementOf(targetCardElement(docId)),
        startMorph: pendingMorphState,
        onSettled: notifyTransitionEnd,
      });
      pendingMorphState = null;
      return;
    }
    if (action.type === 'nav/back') {
      const nav = store.getState().nav;
      // 只关浮层：页面没换，不做整页转场
      if (nav.layers.length > 0) {
        settlePageTransition();
        originalDispatch(action);
        return;
      }
      if (nav.pages.length > 1) {
        const swipeOffset = pendingSwipeOffset;
        pendingSwipeOffset = 0;
        const morph = pendingMorphState;
        pendingMorphState = null;
        const docId = store.getState().currentDocId;
        const fromReader = topPage(nav).kind === 'reader';
        if (fromReader) {
          runCloseMask({
            level: motionLevel(),
            getPrevious: mounted,
            getMounted: mounted,
            update: () => originalDispatch(action),
            findTarget: () => targetCardRect(docId),
            findTargetElement: () => coverElementOf(targetCardElement(docId)),
            resolveSlot: () => coverElementOf(targetCardElement(docId)),
            startOffsetX: swipeOffset,
            startMorph: morph,
            onSettled: notifyTransitionEnd,
          });
        } else {
          runPageFade(motionLevel(), () => originalDispatch(action));
        }
        return;
      }
      originalDispatch(action);
      return;
    }
    if (action.type === 'nav/push') {
      runPageFade(motionLevel(), () => originalDispatch(action));
      return;
    }
    if (action.type === 'nav/tab') {
      runPageFade(motionLevel(), () => originalDispatch(action));
      return;
    }

    originalDispatch(action);
  };

  /** 记录当前阅读位置（按块 id，而不是像素 —— 改字号后仍能回到同一处）。 */
  /** 进度落库用的块列表缓存：分片挂载会不断追加，签名变了才重建。 */
  let progressBlocks: HTMLElement[] = [];
  let progressBlocksKey = '';

  function progressBlockList(article: HTMLElement): HTMLElement[] {
    const key = `${article.getAttribute('data-gen') ?? ''}|${article.childElementCount}`;
    if (key === progressBlocksKey) return progressBlocks;
    progressBlocks = Array.from(article.querySelectorAll<HTMLElement>('[data-bid]'));
    progressBlocksKey = key;
    return progressBlocks;
  }

  function persistProgress(): void {
    const state = store.getState();
    const doc = selectCurrentDoc(state);
    if (doc === null) return;
    const article = root.querySelector<HTMLElement>('[data-testid="article"]');
    if (article === null) return;

    const blocks = progressBlockList(article);
    if (blocks.length === 0) return;
    // 基准线取 sticky 顶栏的下沿（视口坐标，滚动时保持不变）。
    // 不能再用 article.top：它随内容一起上移，恒为负，会让第一个块永远满足条件。
    const baseline = appbarBottom();
    let chosen: ReadProgress | null = null;
    // 块按文档顺序排列，rect.bottom 单调递增 → 二分找第一个「下沿越过基准线」的块。
    // 900KB 文档原来这里每次 9600+ 次 getBoundingClientRect，滚动停顿时会卡 50ms+。
    let lo = 0;
    let hi = blocks.length - 1;
    let index = -1;
    // 先验证单调性（少量抽样），异常资料退回线性扫描，直链/绝对定位块不会算错位置
    const monotonic =
      blocks.length < 3
      || (blocks[1] as HTMLElement).getBoundingClientRect().bottom
        >= (blocks[0] as HTMLElement).getBoundingClientRect().bottom;
    if (monotonic) {
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const rect = blocks[mid]!.getBoundingClientRect();
        if (rect.bottom > baseline) {
          index = mid;
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      }
      if (index >= 0) {
        const block = blocks[index]!;
        const rect = block.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (baseline - rect.top) / rect.height));
        chosen = { bid: block.getAttribute('data-bid') ?? '', ratio };
      }
    } else {
      for (const block of blocks) {
        const rect = block.getBoundingClientRect();
        if (rect.bottom > baseline) {
          const ratio = Math.max(0, Math.min(1, (baseline - rect.top) / rect.height));
          chosen = { bid: block.getAttribute('data-bid') ?? '', ratio };
          break;
        }
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
    onFatalHome: () => {
      deps.dispatch({ type: 'nav/tab', tab: 'shelf' });
    },
    createPage: (page, state) => {
      if (page.kind === 'reader') return createReaderPage(state, deps);
      if (page.kind === 'editor') return createEditorPage(state, deps, page.docId);
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
          (s) => JSON.stringify({ ...s.settings, glassLevel: 0 }) + `|${s.nav.pages.length}|diag:${diagnosticsCount()}`,
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

  hostRef = host;
  // 首屏也写一次指示点位置（没有过渡动画，避免刚启动就滑一下）
  root.style.setProperty('--tab-index', String(tabIndicatorIndex(store.getState())));

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
    collectionSpec: () => currentCollection,
    addTag: addTagToSelected,
    removeTag: removeTagFromSelected,
    setFolder: setFolderForSelected,
    noteDraft: () => currentNote,
    noteSave: saveNote,
    noteCancel: cancelNote,
    marksInput,
    marksRemove: removeMark,
    marksJump: (mark) => {
      store.dispatch({ type: 'layer/closed', layer: 'marks' });
      scrollToBid(mark.anchor.bid, 0, 'smooth');
    },
    marksReanchor: beginReanchor,
    marksExport: exportMarks,
    wordbookInput,
    wordbookRemove: removeWordFromBook,
    wordbookClearWords: clearWordbook,
    wordbookClearHistory: clearLookupHistory,
    wordbookSwitchTab: switchWordbookTab,
    dispatch: (action: StateAction) => store.dispatch(action),
    motionLevel: () => motionLevel(),
    close: (layer) => {
      if (layer === 'menu') currentMenu = null;
      if (layer === 'image') currentImage = null;
      if (layer === 'collection') currentCollection = null;
      if (layer === 'note') {
        currentNote = null;
        pendingNoteParts = null;
      }
      store.dispatch({ type: 'layer/closed', layer });
    },
  });

  // ── 左缘右滑返回（阶段 D4）────────────────────────────
  // 只在「动效：完整」且可返回时启用；提交时走统一路由（nav/back），
  // 因为滑出动画已经播过，这一次跳过整页 View Transition。
  // 原生预测式返回桥接可用时自动让位（否则两侧手势会双重触发）。
  enableEdgeBack({
    getPageElement: mounted,
    canGoBack: () => {
      const nav = store.getState().nav;
      return nav.pages.length > 1 || nav.layers.length > 0;
    },
    enabled: () => motionLevel() === 'full' && !isNativeBackActive(),
    durationMs: () => pageDuration(motionLevel()),
    // 手势提交时把当前位移交给关闭动画：不再叠「滑出 + 进入」两套转场
    onCommit: (offsetX: number) => {
      pendingSwipeOffset = offsetX;
      deps.dispatch({ type: 'nav/back' });
    },
  });

  // ── 预测式返回跟手缩窗（转场改造 Step 4）──────────────────
  // 原生层在 Android 14+ 逐帧调用 window.__mdlegoBackGesture；
  // 这里把进度映射成 FLIP 形变壳的实时矩阵，松手时以该矩阵作为关闭动画起点。
  backGesture = mountBackGesture({
    getStack: () => currentBackStack(),
    viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
    onStart: () => {
      // 单帧原子准备：提前把转场宿主与书架切换做好，但**不**开始播放动画，
      // 由后续 move 逐帧驱动（真正的动画在 onCancel / commit 之后才跑）。
      prepareCloseForGesture();
    },
    onMove: (state: MorphState) => {
      applyGestureMorph(state);
    },
    onCancel: (from: MorphState) => {
      reboundFromGesture(from);
    },
    onCommit: () => {
      // 把松手瞬间的矩阵交给关闭转场，严禁先弹回全屏再重播关闭动画。
      //
      // 注意这里**不**调 endGesture()：关闭转场（runCloseMask）自己会先
      // settlePageTransition()，而且它需要阅读页还处于「可见」状态去抓快照。
      // 手势层只负责把自己拆掉，页面可见性交回给关闭转场。
      gestureStage = null;
      endGestureStage();
      pendingMorphState = backGesture.takePendingMorph();
      deps.dispatch({ type: 'nav/back' });
    },
  });
  syncBackIntercept();

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

  /**
   * 底部导航指示点的槽位索引（5 槽：书架/搜索/＋/统计/设置）。
   * 写到 <html> 的 --tab-index 上；motion.css 的 @property 让它可插值，
   * 指示条只靠 transform 平移 —— 不做 left 动画。
   */
  function tabIndicatorIndex(state: State): number {
    const top = topPage(state.nav);
    if (top.kind !== 'tab') return 0;
    if (top.tab === 'search') return 1;
    if (top.tab === 'stats') return 3;
    if (top.tab === 'settings') return 4;
    return 0;
  }

  store.subscribe((state) => {
    host.update(state);
    layers.sync(state);
    root.style.setProperty('--tab-index', String(tabIndicatorIndex(state)));
    const want = hashFor(state);
    if ((location.hash || '#/') !== want) history.replaceState(null, '', want);
    // 路由/浮层变化时同步原生返回拦截开关：
    // 回到书架根页面且无浮层时必须注销，否则废掉系统退回桌面的原生动画。
    syncBackIntercept();
    // 路由变了说明页面已经换过，手势层必须收掉（幂等，正常情况下是空操作）
    endGestureStage();
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

  // 系统「减少动效」偏好变化：实时降级/恢复（任务书 §4.1：同时尊重该偏好）
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => {
    syncVisualSettings(store.getState().settings);
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

  // ── 阅读会话：只有前台可见时长计入统计 ──
  // 切后台/锁屏时暂停计时，回来继续；页面被销毁前尽量把会话落库（异步尽力而为）。
  // 应用切后台/锁屏时原生可能不再发结束事件：无条件收掉手势层，
  // 否则残留的临时层与隐藏类会在用户回来时表现为白屏（1.2.1 #A）。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') endGesture();
  });
  window.addEventListener('pagehide', () => endGesture());

  document.addEventListener('visibilitychange', () => {
    syncWakeLock(store.getState());
    if (session === null) return;
    if (document.visibilityState === 'hidden') pauseSessionClock();
    else resumeSessionClock();
  });
  window.addEventListener('pagehide', () => finishSession());

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
