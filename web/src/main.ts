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
import { effectiveMotion, pageDuration, pageEnterClass, type MotionLevel } from './core/motion';
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
import { isNative, releaseScreenWakeLock, requestScreenWakeLock } from './data/native';
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
import { runCrossfade, runPageTransition, runThemeReveal } from './views/motion';
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

  function lookupWord(word: string): void {
    const article = root.querySelector<HTMLElement>('[data-testid="article"]');
    if (article === null) return;
    lookupWordInArticle(article, word, {
      isSaved: (candidate) => hasWord(store.getState().words, candidate),
      onToggleWord: (entry) => addOrRemoveWord(entry),
      onRecord: (candidate) => recordLookup(candidate),
    });
  }

  /** 打开文档后读取并重定位该文档的标注。 */
  async function loadMarksForDoc(docId: string, render: RenderResult): Promise<void> {
    try {
      const stored = await getMarksByDoc(docId);
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
    try {
      const render = renderMarkdown(text);
      store.dispatch({ type: 'reader/ready', render });
      void loadMarksForDoc(docId, render);
    } catch (error) {
      console.warn('保存后重渲染失败', error);
    }
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

    // 统计从这里开始计时（切文档会先结掉上一篇）
    startSession(docId);

    try {
      const render = renderMarkdown(doc.text);
      store.dispatch({ type: 'reader/ready', render });
      void loadMarksForDoc(docId, render);
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

  /** 优先用「用户刚点的那个封面」；找不到（键盘/程序触发）再按文档 id 找。 */
  function sourceCover(docId: string): HTMLElement | null {
    const target = lastPointerTarget;
    const cover = target instanceof Element ? target.closest<HTMLElement>('[data-cover-doc]') : null;
    if (cover !== null && cover.dataset['coverDoc'] === docId) return cover;
    return coverForDoc(docId);
  }

  const mounted = (): HTMLElement | null => hostRef?.mountedElement() ?? null;

  /** 左缘右滑提交时置起：跳过那一次整页 View Transition（避免把滑出的页面拍进快照）。 */
  let suppressNextPageTransition = false;

  deps.dispatch = (action: StateAction): void => {
    // 主题切换：从最近点击位置圆形扩散（任务书 §4.2）
    if (action.type === 'settings/changed' && action.patch.theme !== undefined) {
      runThemeReveal(motionLevel(), lastPointer, () => originalDispatch(action));
      return;
    }

    if (action.type === 'doc/opened') {
      const docId = action.docId;
      runPageTransition({
        level: motionLevel(),
        direction: 'forward',
        oldSurface: sourceCover(docId),
        newSurface: mounted,
        mountedElement: mounted,
        update: () => {
          store.dispatch(action);
          openDoc(docId);
        },
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
      // 关文档：阅读页根 → 书架上那篇文档的封面
      const docId = store.getState().currentDocId;
      runPageTransition({
        level: motionLevel(),
        direction: 'back',
        oldSurface: mounted(),
        newSurface: () => (docId === null ? null : coverForDoc(docId)),
        mountedElement: mounted,
        update: () => originalDispatch(action),
      });
      return;
    }
    if (action.type === 'nav/back') {
      const nav = store.getState().nav;
      // 只关浮层：页面没换，不做整页转场
      if (nav.layers.length > 0) {
        originalDispatch(action);
        return;
      }
      if (nav.pages.length > 1) {
        // 左缘右滑已经播过「滑出」动画：这一次直接换页，避免再叠一层 VT
        if (suppressNextPageTransition) {
          suppressNextPageTransition = false;
          originalDispatch(action);
          return;
        }
        const docId = store.getState().currentDocId;
        const fromReader = topPage(nav).kind === 'reader';
        runPageTransition({
          level: motionLevel(),
          direction: 'back',
          oldSurface: fromReader ? mounted() : null,
          newSurface: () => (docId === null ? null : coverForDoc(docId)),
          mountedElement: mounted,
          update: () => originalDispatch(action),
        });
        return;
      }
      originalDispatch(action);
      return;
    }
    if (action.type === 'nav/push') {
      runPageTransition({
        level: motionLevel(),
        direction: 'forward',
        oldSurface: null,
        newSurface: mounted,
        mountedElement: mounted,
        update: () => originalDispatch(action),
      });
      return;
    }
    if (action.type === 'nav/tab') {
      runCrossfade(motionLevel(), () => originalDispatch(action));
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
  enableEdgeBack({
    getPageElement: mounted,
    canGoBack: () => {
      const nav = store.getState().nav;
      return nav.pages.length > 1 || nav.layers.length > 0;
    },
    enabled: () => motionLevel() === 'full',
    durationMs: () => pageDuration(motionLevel()),
    onBack: () => {
      suppressNextPageTransition = true;
      deps.dispatch({ type: 'nav/back' });
      // 新页面已经挂载：补一个「返回」方向的进入动画，接住滑出的观感
      const el = mounted();
      const cls = pageEnterClass('back', motionLevel());
      if (el !== null && cls !== null) {
        el.classList.remove('page-enter--back', 'page-enter--forward');
        void el.offsetWidth;
        el.classList.add(cls);
        window.setTimeout(() => el.classList.remove(cls), pageDuration(motionLevel()) + 60);
      }
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
