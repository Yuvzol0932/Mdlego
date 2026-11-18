/**
 * 阅读页（阶段 C3 / C4）—— 对照参考图右机：
 *   顶栏（返回 / 标题 / 搜索 / 书签 / 更多，随滚动方向收放）
 *   正文（正文节点只在「渲染结果变了」或「长按查词开关变了」时重建）
 *   阅读底栏（已读 % + 进度条 + Aa + 明暗 + 下一章）
 *
 * 铁律（阶段 A 验收，host.test.ts 守着）：滚动、勾选、保存进度、开关浮层、
 * 改排版、换主题都**不得**重建 <article>。这里所有交互都只改属性/class。
 *
 * 沉浸模式：点正文空白处同时收起顶栏与底栏；再点一次恢复。
 */

import type { RenderResult, State, TaskState } from '../core/types';
import { el, icon, type PageView, type ViewDeps } from './app';
import { applyMarkHighlights, clearMarkHighlights } from './marks-render';
import {
  bindTextSelection,
  consumeToolbarOnPointerDown,
  hideSelectionToolbar,
  showMarkActions,
  type SelectionBinding,
} from './selection';
import { buildTtsChunks } from '../core/tts';
import { createTtsPlayer, speechSupported, type TtsPlayer } from './tts';
import type { MenuSpec } from './menu';

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

/** 复制文本：优先 Clipboard API，失败回落到隐藏 textarea + execCommand。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 降级 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 两组任务状态是否逐项相同（引用相同的条目视为相同）。 */
function sameTasks(a: readonly TaskState[], b: readonly TaskState[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function createReaderPage(initial: State, deps: ViewDeps): PageView {
  // ── 顶栏 ──
  const title = el('h1', { class: 'appbar__title reader-title', 'data-testid': 'app-title', text: '墨读' });

  const backBtn = el('button', {
    class: 'icon-btn',
    type: 'button',
    'data-testid': 'back-to-shelf',
    'aria-label': '返回书架',
    title: '返回书架',
  }, icon('back'));
  backBtn.addEventListener('click', () => deps.dispatch({ type: 'doc/closed' }));

  const searchBtn = el('button', {
    class: 'icon-btn',
    type: 'button',
    'data-testid': 'open-search',
    'aria-label': '搜索本文',
    title: '搜索',
  }, icon('search'));
  searchBtn.addEventListener('click', () => deps.openSearch());

  const bookmarkBtn = el('button', {
    class: 'icon-btn reader-bookmark',
    type: 'button',
    'data-testid': 'bookmark-toggle',
    'aria-label': '收藏这篇文档',
    title: '收藏',
    'aria-pressed': 'false',
  }, icon('bookmark'));
  bookmarkBtn.addEventListener('click', () => {
    const docId = deps.getState().currentDocId;
    if (docId === null) return;
    deps.toggleBookmark(docId);
  });

  const moreBtn = el('button', {
    class: 'icon-btn',
    type: 'button',
    'data-testid': 'reader-more',
    'aria-label': '更多',
    title: '更多',
  }, icon('more'));
  moreBtn.addEventListener('click', () => openMoreMenu());

  const header = el(
    'header',
    { class: 'appbar appbar--reader', 'data-scrolled': '0' },
    backBtn,
    title,
    el('div', { class: 'appbar__actions' }, searchBtn, bookmarkBtn, moreBtn),
  );

  // ── 阅读底栏 ──
  const percentText = el('span', { class: 'reader-dock__percent', 'data-testid': 'reader-progress-text', text: '已读 0%' });
  const percentFill = el('i');
  const percentBar = el('span', { class: 'progress reader-dock__progress', 'data-testid': 'reader-progress' }, percentFill);

  const typesetBtn = el('button', {
    class: 'reader-dock__btn reader-dock__aa',
    type: 'button',
    'data-testid': 'open-typeset',
    'aria-label': '排版',
    title: '排版',
    text: 'Aa',
  });
  typesetBtn.addEventListener('click', () => deps.openTypeset());

  const themeBtn = el('button', {
    class: 'reader-dock__btn',
    type: 'button',
    'data-testid': 'reader-theme-toggle',
    'aria-label': '切换明暗',
    title: '切换明暗',
  }, icon('sun'));
  themeBtn.addEventListener('click', () => toggleTheme());

  const nextBtn = el('button', {
    class: 'reader-dock__btn',
    type: 'button',
    'data-testid': 'reader-next',
    'aria-label': '下一章',
    title: '下一章',
  }, icon('chevron'));
  nextBtn.addEventListener('click', () => goNextChapter());

  const dock = el(
    'nav',
    { class: 'reader-dock glass', 'data-testid': 'reader-bar', 'aria-label': '阅读工具' },
    el('div', { class: 'reader-dock__meta' }, percentText, percentBar),
    el('div', { class: 'reader-dock__actions' }, typesetBtn, themeBtn, nextBtn),
  );

  const main = el('main', { class: 'main main--reader' });
  const page = el(
    'div',
    { class: 'shell reader-page', 'data-testid': 'shell', 'data-bars': 'shown', 'data-immersive': '0' },
    header,
    main,
    dock,
  );

  // ── 正文（创建规则见文件头） ──
  let generation = 0;
  let builtRender: RenderResult | null = null;
  let builtLookup: boolean | null = null;
  let article: HTMLElement | null = null;
  let errorShown: string | null = null;
  let lastTasks: readonly TaskState[] | null = null;
  let lastBookmarked: boolean | null = null;
  let lastDocId: string | null = null;
  /** 标注渲染签名：标注/渲染变了才重画高亮（避免每次滚动都重建 Highlight）。 */
  let lastMarksKey: string | null = null;
  /** 选区手势绑定（正文重建时必须先解绑）。 */
  let selectionBinding: SelectionBinding | null = null;
  /** 朗读播放条（阶段 E6）。 */
  let ttsPlayer: TtsPlayer | null = null;

  /** 开始/停止朗读（工具菜单里切换）。 */
  function toggleTts(): void {
    if (ttsPlayer !== null) {
      ttsPlayer.destroy();
      ttsPlayer = null;
      return;
    }
    const state = deps.getState();
    if (article === null || state.render === null) {
      deps.toast('请先打开一篇文档');
      return;
    }
    if (!speechSupported()) {
      deps.toast('当前系统不支持朗读');
      return;
    }
    const chunks = buildTtsChunks(state.render.blockTexts);
    if (chunks.length === 0) {
      deps.toast('这篇文档没有可朗读的文字');
      return;
    }
    ttsPlayer = createTtsPlayer({
      article,
      chunks,
      onToast: (message) => deps.toast(message),
      onFinished: () => {
        ttsPlayer?.destroy();
        ttsPlayer = null;
      },
    });
    page.append(ttsPlayer.el);
    ttsPlayer.start();
  }

  function freshArticle(lookup: boolean): HTMLElement {
    selectionBinding?.destroy();
    selectionBinding = null;
    const node = el('article', { class: 'article', 'data-testid': 'article' });
    generation += 1;
    node.setAttribute('data-gen', String(generation));
    bindTaskToggles(node, deps);
    // 选区/标注手势与查词开关无关：查词只是工具条上的一个按钮
    selectionBinding = bindTextSelection(node, {
      blockTexts: () => deps.getState().render?.blockTexts ?? null,
      onMark: (parts, type, color) => deps.addSelectionMark(parts, type, color),
      onNote: (parts) => deps.openNoteForSelection(parts),
      onLookup: (word) => deps.lookupWord(word),
      onCopy: (text) => deps.copyText(text),
      onMarkTap: (markId, rect) => {
        const mark = deps.getState().marks.find((m) => m.id === markId);
        if (mark === undefined) return;
        showMarkActions(rect, {
          quote: mark.anchor.quote,
          onDelete: () => deps.removeMark(markId),
          onEditNote: () => deps.openNoteForMark(markId),
          onCopy: (text) => deps.copyText(text),
        });
      },
      isReanchorPending: () => deps.isReanchorPending(),
      onReanchor: (parts) => deps.reanchorSelection(parts),
      lookupEnabled: () => deps.getState().settings.lookupEnabled,
    });
    article = node;
    builtLookup = lookup;
    lastMarksKey = null;
    main.replaceChildren(node);
    return node;
  }

  // ── 正文交互：代码复制 / 图片放大 / 空白处切沉浸 ──
  main.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const copyBtn = target.closest('.code-copy');
    if (copyBtn instanceof HTMLElement) {
      const wrap = copyBtn.closest('.code-wrap');
      const text = wrap?.querySelector('pre code')?.textContent ?? '';
      void copyText(text).then((ok) => {
        deps.toast(ok ? '已复制代码' : '复制失败');
        if (ok) {
          copyBtn.textContent = '已复制';
          window.setTimeout(() => { copyBtn.textContent = '复制'; }, 1400);
        }
      });
      return;
    }

    const img = target.closest('img');
    if (img instanceof HTMLImageElement) {
      deps.openImage(img.currentSrc || img.src);
      return;
    }

    // 空白处：链接、按钮、输入控件都不算空白
    if (target.closest('a, button, input, label')) return;

    // 这一下按在工具条外、且按下时工具条还开着 → 只负责关工具条，不切沉浸
    // （pointerdown 已经把它收掉了，这里只是不再叠加一次切换）
    if (consumeToolbarOnPointerDown()) return;

    // 残留选区（长按/取消工具条后 WebView 常留一个 Range）不能吞掉点击：
    // 先清掉选区，再继续切换沉浸。
    const selection = window.getSelection();
    if (selection !== null && selection.toString().length > 0) {
      selection.removeAllRanges();
    }
    toggleImmersive();
  });

  // ── 进度与顶栏收放 ──
  let progressQueued = false;
  let barsQueued = false;
  let lastBarY = window.scrollY;

  function scheduleProgress(): void {
    if (progressQueued) return;
    progressQueued = true;
    requestAnimationFrame(() => {
      progressQueued = false;
      paintProgress();
    });
  }

  function paintProgress(): void {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const percent = max <= 0 ? 100 : Math.round(Math.min(1, Math.max(0, window.scrollY / max)) * 100);
    percentText.textContent = `已读 ${percent}%`;
    percentFill.style.width = `${percent}%`;
  }

  function setBars(mode: 'shown' | 'hidden'): void {
    if (page.getAttribute('data-bars') === mode) return;
    page.setAttribute('data-bars', mode);
  }

  function scheduleBars(): void {
    if (barsQueued) return;
    barsQueued = true;
    requestAnimationFrame(() => {
      barsQueued = false;
      updateBars();
    });
  }

  function updateBars(): void {
    if (page.getAttribute('data-immersive') === '1') return;
    const y = window.scrollY;
    if (y <= 8) {
      setBars('shown');
      lastBarY = y;
      return;
    }
    // 累积方向：lastBarY 只在越过阈值时更新，微小的滚动不会被吞掉
    if (y > lastBarY + 6) {
      setBars('hidden');
      lastBarY = y;
    } else if (y < lastBarY - 6) {
      setBars('shown');
      lastBarY = y;
    }
  }

  /**
   * 点空白处切换沉浸模式。
   *
   * 必须按「顶栏实际是否可见」来切，不能按 data-immersive 取反：
   * 用户向下滚动后顶栏已被滚动逻辑自动收起（data-bars=hidden，但 immersive 仍是 0），
   * 此时取反会先把 immersive 变成 1 再 setBars('hidden')，屏幕毫无变化，
   * 要点第二下才看得到反应。
   *
   * 两套状态合并为一个语义：
   *   - data-bars       = 顶栏/底栏此刻是否可见（唯一可见性来源）
   *   - data-immersive  = 是否暂停「滚动自动收放」（用户手动切到隐藏时才暂停）
   */
  function toggleImmersive(): void {
    const hidden = page.getAttribute('data-bars') === 'hidden';
    setBars(hidden ? 'shown' : 'hidden');
    page.setAttribute('data-immersive', hidden ? '0' : '1');
    lastBarY = window.scrollY;
  }

  const onScroll = (): void => {
    scheduleProgress();
    scheduleBars();
    // 停在页首时顶栏完全透明（品牌色背景上的正文不该被一条色带切断）；
    // 滚动后才让玻璃底浮现。
    header.setAttribute('data-scrolled', window.scrollY > 8 ? '1' : '0');
  };
  window.addEventListener('scroll', onScroll, { passive: true });

  // ── 主题切换 / 下一章 ──
  function toggleTheme(): void {
    const scheme = document.documentElement.getAttribute('data-scheme');
    deps.dispatch({ type: 'settings/changed', patch: { theme: scheme === 'dark' ? 'warm-paper' : 'warm-night' } });
  }

  function goNextChapter(): void {
    const render = deps.getState().render;
    if (render === null) return;
    const chapters = render.toc.filter((entry) => entry.level <= 2);
    if (chapters.length === 0) {
      deps.toast('这篇文档没有章节');
      return;
    }
    const offset = header.offsetHeight;
    let current = -1;
    chapters.forEach((entry, index) => {
      const node = page.querySelector<HTMLElement>(`[data-bid="${CSS.escape(entry.bid)}"]`);
      if (node === null) return;
      if (node.getBoundingClientRect().top < offset + 1) current = index;
    });
    const target = chapters[current + 1];
    if (target === undefined) {
      deps.toast('已经是最后一章');
      return;
    }
    const node = page.querySelector<HTMLElement>(`[data-bid="${CSS.escape(target.bid)}"]`);
    if (node === null) return;
    const top = node.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    node.classList.add('flash');
    window.setTimeout(() => node.classList.remove('flash'), 1200);
  }

  // ── 更多菜单：目录 / 明暗 / 设置 ──
  function openMoreMenu(): void {
    const rect = moreBtn.getBoundingClientRect();
    const spec: MenuSpec = {
      variant: 'popover',
      anchor: { top: rect.top, bottom: rect.bottom, right: rect.right },
      items: [
        { id: 'open-toc', testId: 'open-toc', label: '目录', icon: 'list', onSelect: () => deps.openToc() },
        { id: 'open-marks', testId: 'open-marks', label: '批注', icon: 'note', onSelect: () => deps.openMarks() },
        {
          id: 'open-editor',
          testId: 'open-editor',
          label: '编辑原文',
          icon: 'edit',
          onSelect: () => {
            const docId = deps.getState().currentDocId;
            if (docId !== null) deps.openEditor(docId);
          },
        },
        { id: 'reader-tts', testId: 'reader-tts', label: '朗读', icon: 'speaker', onSelect: () => toggleTts() },
        { id: 'reader-export-html', testId: 'reader-export-html', label: '导出 HTML', icon: 'share', onSelect: () => deps.exportHtml() },
        { id: 'reader-print', testId: 'reader-print', label: '打印 / 导出 PDF', icon: 'print', onSelect: () => deps.printDocument() },
        { id: 'reader-typeset', label: '排版', icon: 'type', onSelect: () => deps.openTypeset() },
        { id: 'reader-theme', label: '切换明暗', icon: 'moon', onSelect: () => toggleTheme() },
        {
          id: 'reader-settings',
          label: '设置',
          icon: 'settings',
          onSelect: () => deps.dispatch({ type: 'nav/push', page: { kind: 'tab', tab: 'settings' } }),
        },
      ],
    };
    deps.openMenu(spec);
  }

  // ── 状态 → DOM ──
  function update(state: State): void {
    const docId = state.currentDocId;
    if (docId !== lastDocId) {
      lastDocId = docId;
      // 换文档时滚动位置由 main.ts 负责恢复，这里只需要把百分比重置
      percentText.textContent = '已读 0%';
      percentFill.style.width = '0%';
    }

    const doc = state.docs.find((d) => d.id === docId) ?? null;
    const nextTitle = doc?.title ?? '墨读';
    if (title.textContent !== nextTitle) title.textContent = nextTitle;

    const bookmarked = docId !== null && state.bookmarks.includes(docId);
    if (bookmarked !== lastBookmarked) {
      lastBookmarked = bookmarked;
      bookmarkBtn.setAttribute('aria-pressed', bookmarked ? 'true' : 'false');
      bookmarkBtn.setAttribute('aria-label', bookmarked ? '取消收藏' : '收藏这篇文档');
    }

    // 明暗快捷按钮的图标跟随当前生效的明暗
    const scheme = document.documentElement.getAttribute('data-scheme');
    const wantedThemeIcon = scheme === 'dark' ? 'sun' : 'moon';
    const use = themeBtn.querySelector('use');
    if (use !== null && use.getAttribute('href') !== `#i-${wantedThemeIcon}`) {
      themeBtn.replaceChildren(icon(wantedThemeIcon));
    }

    if (state.readerStatus === 'error') {
      const message = `无法显示这篇文档：${state.readerError ?? '未知原因'}`;
      if (errorShown !== message) {
        errorShown = message;
        article = null;
        builtRender = null;
        main.replaceChildren(el('div', { class: 'shelf-empty', 'data-testid': 'render-error', text: message }));
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
      paintProgress();
    }

    // 标注高亮：渲染结果或标注变化时重画（CSS Highlight API，不改正文 DOM）
    if (article !== null && state.render !== null) {
      const marksKey = `${generation}|${state.marks
        .map((m) => `${m.id}:${m.anchor.bid}:${m.anchor.start}:${m.anchor.end}:${m.note ?? ''}`)
        .join('|')}`;
      if (marksKey !== lastMarksKey) {
        lastMarksKey = marksKey;
        applyMarkHighlights(article, state.render.blockTexts, state.marks);
      }
    }

    const tasks = tasksFor(state);
    if (article !== null && (lastTasks === null || !sameTasks(lastTasks, tasks))) {
      applyTaskStates(article, tasks);
      lastTasks = tasks;
    }
  }

  update(initial);
  paintProgress();

  return {
    el: page,
    update,
    destroy() {
      window.removeEventListener('scroll', onScroll);
      selectionBinding?.destroy();
      selectionBinding = null;
      hideSelectionToolbar();
      clearMarkHighlights();
      ttsPlayer?.destroy();
      ttsPlayer = null;
    },
  };
}
