/**
 * 书架视图（阶段 C2）—— 对照参考图左机：
 *   顶栏（logo + 应用名 + 搜索/更多）→ 横幅轮播 → 继续阅读 → 我的书架（三列封面）
 *   → 空状态；底部是五项导航。
 *
 * 状态分工（重要）：
 *   - 业务数据只读 `state`（docs / settings），变更一律 dispatch；
 *   - 排序方式、网格/列表、多选集合、轮播位置是**页面级 UI 状态**，留在本文件里，
 *     不进全局 state —— 它们不需要跨页存活，也不该被 reducer 关心。
 *   - 页面节点创建一次，update() 时只重画「真的变了」的部分：文档集合变了重画内容，
 *     只改了选择状态就只切 class，避免长按选中时整页重建把手势打断。
 */

import { collectFacets, filterDocs, isFiltering, type ShelfFilter } from '../core/library';
import { CARD_STAGGER_MAX } from '../core/motion';
import {
  BUILTIN_BANNERS,
  BUILTIN_QUOTES,
  createShuffleBag,
  nextFromShuffleBag,
  type ShuffleBag,
} from '../core/quotes';
import type { Doc, State } from '../core/types';
import { el, icon, type PageView, type ViewDeps } from './app';
import { buildCoverElement, estimatedMinutes, relativeTime } from './cover';
import type { MenuSpec } from './menu';
import { renderTabBar } from './tabbar';

type ViewMode = 'grid' | 'list';
type SortMode = 'recent' | 'name' | 'imported';

const SORT_LABEL: Record<SortMode, string> = {
  recent: '最近阅读',
  name: '按名称',
  imported: '导入时间',
};

/** 长按进入多选的时长（毫秒）。太短会误触，太长像没反应。 */
const LONG_PRESS_MS = 420;
/** 长按期间允许的手指抖动半径（像素），超过就当成滚动，取消长按。 */
const MOVE_TOLERANCE = 10;

/** 文档「展示签名」：这些字段变了才需要重画书架内容。 */
function docsSignature(state: State): string {
  return state.docs
    .map(
      (d) =>
        `${d.id}|${d.title}|${d.lastReadAt ?? ''}|${d.importedAt}|${d.text.length}|${d.progress?.bid ?? ''}|${d.progress?.percent ?? ''}` +
        // 阶段 E1：标签/文件夹变化要触发重绘（否则筛选条与卡片 meta 不更新）
        `|${(d.tags ?? []).join(',')}|${d.folder ?? ''}|${JSON.stringify(d.cover ?? null)}`,
    )
    .join('\n')
    + `\n--fav--${state.bookmarks.join(',')}`;
}

/** 影响横幅的展示签名（自定义图片 / 语录 / 动效档）。 */
function heroSignature(state: State): string {
  return `${state.settings.bannerImage?.length ?? 0}|${state.settings.quotes.join('\u0001')}|${state.settings.motion}`;
}

/** 正在读的那篇（继续阅读）：有进度且最近读过。 */
function continueDoc(state: State): Doc | null {
  let best: Doc | null = null;
  for (const doc of state.docs) {
    if (doc.progress === null) continue;
    if (best === null) {
      best = doc;
      continue;
    }
    const a = doc.lastReadAt ?? doc.importedAt;
    const b = best.lastReadAt ?? best.importedAt;
    if (a > b) best = doc;
  }
  return best;
}

/** 按当前排序方式排好的文档。 */
function sortedDocs(state: State, sort: SortMode): Doc[] {
  const docs = [...state.docs];
  if (sort === 'name') {
    docs.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
    return docs;
  }
  if (sort === 'imported') {
    docs.sort((a, b) => b.importedAt - a.importedAt);
    return docs;
  }
  docs.sort((a, b) => (b.lastReadAt ?? b.importedAt) - (a.lastReadAt ?? a.importedAt));
  return docs;
}

/** 小节标题行：标题 + 右侧动作（查看全部 / 视图切换）。 */
function sectionHead(title: string, action: { label: string; testId: string; onClick: () => void }): HTMLElement {
  const btn = el('button', {
    class: 'section-head__more ui-press',
    type: 'button',
    'data-testid': action.testId,
  });
  btn.append(el('span', { text: action.label }), icon('chevron'));
  btn.addEventListener('click', () => action.onClick());
  return el('header', { class: 'section-head' }, el('h2', { class: 'section-title', text: title }), btn);
}

/** 封面块（网格/列表/继续阅读共用）。 */
function coverBlock(doc: Doc, className: string, compact = false): HTMLElement {
  return buildCoverElement(doc, className, { compact });
}

/** 细进度条；没有百分比时返回 null（旧数据不猜）。 */
function progressBar(percent: number | undefined, testId: string): HTMLElement | null {
  if (percent === undefined) return null;
  const fill = el('i');
  fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  return el('span', { class: 'progress', 'data-testid': testId }, fill);
}

export function createShelfPage(initial: State, deps: ViewDeps): PageView {
  let viewMode: ViewMode = 'grid';
  let sort: SortMode = 'recent';
  let selecting = false;
  /** 书架筛选（阶段 E1）：全部 / 收藏 / 标签 / 文件夹；页面级 UI 状态，不进全局 state。 */
  let filter: ShelfFilter = { kind: 'all' };
  const selected = new Set<string>();
  let heroIndex = 0;
  let heroObserver: IntersectionObserver | null = null;
  let docsSig = docsSignature(initial);
  let heroSig = heroSignature(initial);
  let heroTimer: number | null = null;
  let destroyed = false;

  // 横幅名言与风景图洗牌循环：每次进书架随机起手，一轮内不重复
  const quoteInit = nextFromShuffleBag(createShuffleBag(Math.max(1, initial.settings.quotes.length || BUILTIN_QUOTES.length)), Math.max(1, initial.settings.quotes.length || BUILTIN_QUOTES.length));
  let quoteBag: ShuffleBag = quoteInit.next;
  let activeQuoteIdx = quoteInit.index;

  const bannerInit = nextFromShuffleBag(createShuffleBag(BUILTIN_BANNERS.length), BUILTIN_BANNERS.length);
  let bannerBag: ShuffleBag = bannerInit.next;
  let activeBannerIdx = bannerInit.index;

  // ── 顶部：品牌 + 搜索 / 更多 ──
  const moreBtn = el('button', {
    class: 'icon-btn',
    type: 'button',
    'data-testid': 'shelf-more',
    'aria-label': '更多',
    title: '更多',
  }, icon('more'));
  moreBtn.addEventListener('click', () => openMoreMenu(moreBtn));

  const searchBtn = el('button', {
    class: 'icon-btn',
    type: 'button',
    'data-testid': 'shelf-search',
    'aria-label': '搜索',
    title: '搜索',
  }, icon('search'));
  searchBtn.addEventListener('click', () => deps.dispatch({ type: 'nav/tab', tab: 'search' }));

  const header = el(
    'header',
    { class: 'appbar appbar--shelf', 'data-scrolled': '0' },
    el(
      'div',
      { class: 'brand' },
      el('span', { class: 'brand__mark', 'aria-hidden': 'true' }, icon('book')),
      el('h1', { class: 'brand__name', 'data-testid': 'app-title', text: '墨读' }),
    ),
    el('div', { class: 'appbar__actions' }, searchBtn, moreBtn),
  );

  // ── 内容区 ──
  const hero = el('section', { class: 'hero', 'data-testid': 'shelf-hero' });
  const body = el('div', { class: 'shelf-body', 'data-testid': 'shelf' });

  // ── 多选操作条（选择模式下替代底部导航） ──
  const selectCount = el('span', { class: 'shelf-selectbar__count' });
  const selectAll = el('button', {
    class: 'shelf-selectbar__action ui-press',
    type: 'button',
    'data-testid': 'shelf-select-all',
    text: '全选',
  });
  selectAll.addEventListener('click', () => {
    for (const doc of sortedDocs(deps.getState(), sort)) selected.add(doc.id);
    paintSelection();
  });
  const selectCancel = el('button', {
    class: 'shelf-selectbar__action ui-press',
    type: 'button',
    'data-testid': 'shelf-select-cancel',
    text: '取消',
  });
  selectCancel.addEventListener('click', () => exitSelection());
  const selectTag = el('button', {
    class: 'shelf-selectbar__action ui-press',
    type: 'button',
    'data-testid': 'shelf-select-tag',
    text: '标签',
  });
  selectTag.addEventListener('click', () => deps.openTagEditor([...selected]));
  const selectFolder = el('button', {
    class: 'shelf-selectbar__action ui-press',
    type: 'button',
    'data-testid': 'shelf-select-folder',
    text: '文件夹',
  });
  selectFolder.addEventListener('click', () => deps.openFolderEditor([...selected]));
  const selectCover = el('button', {
    class: 'shelf-selectbar__action ui-press',
    type: 'button',
    'data-testid': 'shelf-select-cover',
    text: '封面',
  });
  selectCover.addEventListener('click', () => {
    const id = [...selected][0];
    if (id !== undefined) {
      exitSelection();
      deps.openCoverEditor(id);
    }
  });
  const selectDelete = el('button', {
    class: 'shelf-selectbar__action shelf-selectbar__action--danger ui-press',
    type: 'button',
    'data-testid': 'shelf-select-delete',
    text: '删除',
  });
  selectDelete.addEventListener('click', () => confirmDelete());
  const selectBar = el(
    'div',
    { class: 'shelf-selectbar', 'data-testid': 'shelf-selectbar', hidden: '' },
    selectCount,
    el('div', { class: 'shelf-selectbar__actions' }, selectAll, selectCover, selectTag, selectFolder, selectCancel, selectDelete),
  );

  const page = el(
    'div',
    { class: 'shell shelf-page', 'data-testid': 'shell' },
    header,
    el('main', { class: 'main main--tabbed' }, hero, body),
    selectBar,
    renderTabBar('shelf', deps),
  );

  // ── 滚动：顶栏淡入玻璃 ──
  const onScroll = (): void => {
    header.setAttribute('data-scrolled', window.scrollY > 8 ? '1' : '0');
  };
  window.addEventListener('scroll', onScroll, { passive: true });

  // ── 选择模式 ──
  function enterSelection(docId: string): void {
    if (selecting) return;
    selecting = true;
    selected.clear();
    selected.add(docId);
    page.classList.add('shelf--selecting');
    selectBar.removeAttribute('hidden');
    paintCardsSelection();
    paintSelection();
  }

  function exitSelection(): void {
    if (!selecting) return;
    selecting = false;
    selected.clear();
    page.classList.remove('shelf--selecting');
    selectBar.setAttribute('hidden', '');
    paintCardsSelection();
  }

  function paintSelection(): void {
    const total = deps.getState().docs.length;
    selectCount.textContent = `已选 ${selected.size} 篇`;
    // 注意：disabled 是布尔属性，写 disabled="false" 仍然是禁用 —— 只能整体增删
    setDisabled(selectAll, selected.size >= total);
    setDisabled(selectDelete, selected.size === 0);
    setDisabled(selectTag, selected.size === 0);
    setDisabled(selectFolder, selected.size === 0);
    setDisabled(selectCover, selected.size !== 1);
  }

  function setDisabled(node: HTMLElement, disabled: boolean): void {
    if (disabled) node.setAttribute('disabled', '');
    else node.removeAttribute('disabled');
  }

  /** 只切现有卡片的选中态，不重建节点（长按后手指还按着，重建会打断手势）。 */
  function paintCardsSelection(): void {
    for (const card of page.querySelectorAll<HTMLElement>('[data-doc-id]')) {
      const id = card.getAttribute('data-doc-id') ?? '';
      card.setAttribute('aria-selected', selecting && selected.has(id) ? 'true' : 'false');
      card.classList.toggle('is-selected', selecting && selected.has(id));
    }
  }

  function toggleSelected(docId: string): void {
    if (selected.has(docId)) selected.delete(docId);
    else selected.add(docId);
    paintCardsSelection();
    paintSelection();
  }

  function confirmDelete(): void {
    const ids = [...selected];
    if (ids.length === 0) return;
    const spec: MenuSpec = {
      variant: 'dialog',
      title: `删除 ${ids.length} 篇文档？`,
      items: [
        {
          id: 'shelf-delete-confirm',
          label: `删除 ${ids.length} 篇`,
          danger: true,
          onSelect: () => {
            deps.requestDelete(ids);
            exitSelection();
          },
        },
        { id: 'shelf-delete-cancel', label: '取消', onSelect: () => undefined },
      ],
    };
    deps.openMenu(spec);
  }

  // ── 卡片 ──
  function bindCard(card: HTMLElement, doc: Doc): void {
    // 长按进入多选；短按才是打开
    let timer: number | null = null;
    let startX = 0;
    let startY = 0;
    const clear = (): void => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    card.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      startX = event.clientX;
      startY = event.clientY;
      clear();
      timer = window.setTimeout(() => {
        timer = null;
        enterSelection(doc.id);
      }, LONG_PRESS_MS);
    });
    card.addEventListener('pointermove', (event) => {
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > MOVE_TOLERANCE) clear();
    });
    card.addEventListener('pointerup', clear);
    card.addEventListener('pointercancel', clear);
    card.addEventListener('pointerleave', clear);
    card.addEventListener('click', () => {
      if (selecting) toggleSelected(doc.id);
      else deps.dispatch({ type: 'doc/opened', docId: doc.id });
    });
  }

  function gridCard(doc: Doc): HTMLElement {
    const card = el(
      'button',
      {
        class: 'book-card ui-press',
        type: 'button',
        'data-testid': 'doc-item',
        'data-doc-id': doc.id,
        'aria-selected': 'false',
      },
      coverBlock(doc, 'cover--card'),
      el('span', { class: 'book-card__title', text: doc.title }),
      el('span', { class: 'book-card__meta', text: relativeTime(doc.lastReadAt) }),
      progressBar(doc.progress?.percent, `doc-progress-${doc.id}`) ??
        el('span', { class: 'progress progress--empty' }),
      el('span', { class: 'book-card__check', 'aria-hidden': 'true' }, icon('check')),
    );
    bindCard(card, doc);
    return card;
  }

  function listRow(doc: Doc): HTMLElement {
    const row = el(
      'button',
      {
        class: 'book-row ui-press',
        type: 'button',
        'data-testid': 'doc-item',
        'data-doc-id': doc.id,
        'aria-selected': 'false',
      },
      coverBlock(doc, 'cover--row', true),
      el(
        'span',
        { class: 'book-row__body' },
        el('span', { class: 'book-row__title', text: doc.title }),
        el('span', {
          class: 'book-row__meta',
          text: `${relativeTime(doc.lastReadAt)} · 约 ${estimatedMinutes(doc.text)} 分钟`,
        }),
        progressBar(doc.progress?.percent, `doc-progress-${doc.id}`) ?? el('span', { class: 'progress progress--empty' }),
      ),
      el('span', { class: 'book-card__check', 'aria-hidden': 'true' }, icon('check')),
    );
    bindCard(row, doc);
    return row;
  }

  // ── 横幅 ──
  function currentQuote(state: State): { readonly text: string; readonly author: string } {
    if (state.settings.quotes.length > 0) {
      const idx = activeQuoteIdx % state.settings.quotes.length;
      return { text: state.settings.quotes[idx] ?? '', author: '墨读' };
    }
    const idx = activeQuoteIdx % BUILTIN_QUOTES.length;
    return BUILTIN_QUOTES[idx] ?? { text: '阅读，是为了遇见更大的世界。', author: '墨读' };
  }

  function currentBanner(state: State): { readonly src: string; readonly title: string | null } {
    if (state.settings.bannerImage !== null) {
      return { src: state.settings.bannerImage, title: null };
    }
    const preset = BUILTIN_BANNERS[activeBannerIdx % BUILTIN_BANNERS.length];
    return preset !== undefined ? { src: preset.src, title: preset.title } : { src: 'banners/01.webp', title: '秋日银杏' };
  }

  function advanceHeroShuffle(state: State): void {
    const quoteCount = state.settings.quotes.length > 0 ? state.settings.quotes.length : BUILTIN_QUOTES.length;
    const qRes = nextFromShuffleBag(quoteBag, quoteCount);
    quoteBag = qRes.next;
    activeQuoteIdx = qRes.index;

    if (state.settings.bannerImage === null) {
      const bRes = nextFromShuffleBag(bannerBag, BUILTIN_BANNERS.length);
      bannerBag = bRes.next;
      activeBannerIdx = bRes.index;
    }
  }

  function slideShell(className: string, testId: string, ...children: Array<Node | string>): HTMLElement {
    return el('article', { class: `hero-slide ${className}`, 'data-testid': testId }, ...children);
  }

  function paintHero(state: State): void {
    hero.replaceChildren();
    const slides: HTMLElement[] = [];
    const cont = continueDoc(state);
    const quote = currentQuote(state);
    const banner = currentBanner(state);

    if (state.docs.length === 0) {
      slides.push(
        slideShell(
          'hero-slide--import',
          'shelf-hero-import',
          el('p', { class: 'hero-slide__title', text: '把 Markdown 放进书架' }),
          el('p', { class: 'hero-slide__sub', text: '支持 .md / .txt，导入后离线可读。' }),
          heroImportButton(),
        ),
      );
    } else {
      const shuffleBtn = el(
        'button',
        {
          class: 'hero-slide__shuffle ui-press',
          type: 'button',
          'data-testid': 'hero-shuffle',
          'aria-label': '换一句与风景',
          title: '换一句与风景',
        },
        icon('refresh'),
        ...(banner.title !== null ? [el('span', { text: banner.title })] : []),
      );
      shuffleBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        pauseAutoAdvance(16_000);
        const current = deps.getState();
        advanceHeroShuffle(current);
        paintHero(current);
      });

      slides.push(
        slideShell(
          'hero-slide--quote',
          'shelf-hero-quote',
          // 装饰引号：纯 CSS 视觉锚点，不进无障碍树
          el('span', { class: 'hero-slide__mark', 'aria-hidden': 'true', text: '“' }),
          el('p', { class: 'hero-slide__quote', text: quote.text }),
          el(
            'div',
            { class: 'hero-slide__footer' },
            el('span', { class: 'hero-slide__by', text: `— ${quote.author}` }),
            shuffleBtn,
          ),
        ),
      );
      if (cont !== null) {
        const percent = cont.progress?.percent;
        slides.push(
          slideShell(
            'hero-slide--continue',
            'shelf-hero-continue',
            el('span', { class: 'hero-slide__eyebrow', text: '继续阅读' }),
            el('p', { class: 'hero-slide__title', text: cont.title }),
            el('p', {
              class: 'hero-slide__sub',
              text: `${percent === undefined ? '' : `${percent}% · `}约 ${estimatedMinutes(cont.text)} 分钟`,
            }),
            el('button', {
              class: 'hero-slide__hit',
              type: 'button',
              'aria-label': `继续阅读《${cont.title}》`,
              onclick: () => deps.dispatch({ type: 'doc/opened', docId: cont.id }),
            }),
          ),
        );
      }
      slides.push(
        slideShell(
          'hero-slide--import',
          'shelf-hero-import',
          el('p', { class: 'hero-slide__title', text: '导入新的文档' }),
          el('p', { class: 'hero-slide__sub', text: '从文件管理器选 .md / .txt，或分享到墨读。' }),
          heroImportButton(),
        ),
      );
    }

    // 横幅图：优先用户自定义图，否则使用内置随机风景；叠暗角后用 cover 铺满，文字始终浅色
    heroObserver?.disconnect();
    heroObserver = null;

    for (const slide of slides) {
      if (slide.classList.contains('hero-slide--import')) continue;
      slide.classList.add('hero-slide--photo');
      slide.style.setProperty('background-image', `var(--hero-scrim), url("${banner.src}")`);
      slide.style.setProperty('background-size', 'cover');
    }

    const track = el('div', { class: 'hero__track' }, ...slides);

    // 轮播步长 = 一张卡的实际宽度 + 轨道 gap。
    // 不能用 track.clientWidth：那包含左右留白，会让圆点跳转与索引判定都差一截；
    // gap 也必须算进去，否则每翻一页就累积 12px 误差，越往右越偏。
    const slideStride = (): number => {
      const first = track.firstElementChild as HTMLElement | null;
      const width = first?.offsetWidth ?? track.clientWidth;
      const gap = Number.parseFloat(getComputedStyle(track).columnGap) || 0;
      return width + gap;
    };

    // 圆点先建好，轮播监听里要用；只有一张时不显示圆点
    const dots = el('div', { class: 'hero__dots', role: 'tablist', 'aria-label': '横幅轮播' });
    if (slides.length > 1) {
      for (let i = 0; i < slides.length; i += 1) {
        const dot = el('button', {
          class: 'hero__dot',
          type: 'button',
          role: 'tab',
          'data-testid': `shelf-hero-dot-${i}`,
          'aria-label': `第 ${i + 1} 张`,
        });
        dot.addEventListener('click', () => {
          pauseAutoAdvance(16_000);
          track.scrollTo({ left: i * slideStride(), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        });
        dots.append(dot);
      }
      paintDots(dots, heroIndex);
    } else {
      dots.setAttribute('hidden', '');
    }

    // 不支持滚动驱动动画时，用 IntersectionObserver 给当前卡片加 .is-center
    // （只切类名，动画仍由 CSS 的 transform/opacity 过渡完成）。
    if (slides.length > 1 && !supportsScrollTimeline()) {
      heroObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          entry.target.classList.toggle('is-center', entry.intersectionRatio >= 0.95);
        }
      }, { root: track, threshold: [0.5, 0.95] });
      for (const slide of slides) heroObserver.observe(slide);
    }

    heroIndex = Math.min(heroIndex, slides.length - 1);
    track.addEventListener('scroll', () => {
      const stride = slideStride();
      if (stride <= 0) return;
      const next = Math.round(track.scrollLeft / stride);
      if (next !== heroIndex) {
        heroIndex = next;
        paintDots(dots, next);
      }
    }, { passive: true });
    // 手指一碰就暂停自动轮播，别跟用户抢
    track.addEventListener('pointerdown', () => pauseAutoAdvance(16_000), { passive: true });

    hero.append(track, dots);
    scheduleAutoAdvance(track, dots, slides.length, slideStride);
  }

  function heroImportButton(): HTMLElement {
    const btn = el('button', {
      class: 'hero-slide__cta ui-press',
      type: 'button',
      'data-testid': 'hero-import',
      text: '导入文档',
    });
    btn.addEventListener('click', () => deps.requestImport());
    return btn;
  }

  function paintDots(dots: HTMLElement, index: number): void {
    for (const [i, dot] of [...dots.children].entries()) {
      dot.setAttribute('aria-selected', i === index ? 'true' : 'false');
      dot.classList.toggle('is-active', i === index);
    }
  }

  /** 浏览器是否支持 CSS 滚动驱动动画（animation-timeline: view()）。 */
  function supportsScrollTimeline(): boolean {
    return typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
      && CSS.supports('animation-timeline: view()');
  }

  function prefersReducedMotion(): boolean {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  let autoPausedUntil = 0;

  /** 用户刚手动滑过就暂停自动轮播一会儿，别跟手指抢。 */
  function pauseAutoAdvance(ms: number): void {
    autoPausedUntil = Date.now() + ms;
  }

  function scheduleAutoAdvance(
    track: HTMLElement,
    dots: HTMLElement,
    count: number,
    slideStride: () => number,
  ): void {
    if (heroTimer !== null) {
      window.clearInterval(heroTimer);
      heroTimer = null;
    }
    if (destroyed || count <= 1) return;
    if (deps.getState().settings.motion === 'off') return;
    if (prefersReducedMotion()) return;
    heroTimer = window.setInterval(() => {
      if (document.hidden) return;
      if (Date.now() < autoPausedUntil) return;
      const stride = slideStride();
      if (stride <= 0) return;
      const next = (Math.round(track.scrollLeft / stride) + 1) % count;
      if (next === 0) {
        const current = deps.getState();
        advanceHeroShuffle(current);
        const quote = currentQuote(current);
        const banner = currentBanner(current);
        const quoteSlide = track.querySelector<HTMLElement>('[data-testid="shelf-hero-quote"]');
        if (quoteSlide !== null) {
          const qEl = quoteSlide.querySelector<HTMLElement>('.hero-slide__quote');
          const byEl = quoteSlide.querySelector<HTMLElement>('.hero-slide__by');
          const shuffleSpan = quoteSlide.querySelector<HTMLElement>('.hero-slide__shuffle span');
          if (qEl !== null) qEl.textContent = quote.text;
          if (byEl !== null) byEl.textContent = `— ${quote.author}`;
          if (shuffleSpan !== null && banner.title !== null) shuffleSpan.textContent = banner.title;
        }
        for (const slide of [...track.children] as HTMLElement[]) {
          if (slide.classList.contains('hero-slide--import')) continue;
          slide.style.setProperty('background-image', `var(--hero-scrim), url("${banner.src}")`);
        }
      }
      track.scrollTo({ left: next * stride, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }, 6000);
  }

  // ── 继续阅读 + 我的书架 ──
  function paintBody(state: State): void {
    body.replaceChildren();

    if (state.docs.length === 0) {
      body.append(emptyShelf());
      return;
    }

    const sorted = sortedDocs(state, sort);
    const docs = filterDocs(sorted, filter, state.bookmarks);

    // 继续阅读是「回到上次位置」的快捷入口：筛选时隐藏，避免与筛选结果自相矛盾
    if (!isFiltering(filter)) {
      const cont = continueDoc(state);
      if (cont !== null) {
        body.append(
          el(
            'section',
            { class: 'shelf-section', 'data-testid': 'shelf-continue' },
            sectionHead('继续阅读', { label: '查看全部', testId: 'shelf-continue-all', onClick: () => setViewMode('list') }),
            continueCard(cont),
          ),
        );
      }
    }

    const grid = el('div', { class: viewMode === 'grid' ? 'shelf-grid' : 'shelf-list', 'data-testid': 'shelf-grid' });
    // 卡片错峰进入：每张给一个索引，CSS 用 --stagger-i × --motion-stagger 算延迟；
    // off/simple 档 --motion-stagger 为 0（simple 换成纯淡入），不会漏出「半透明等延迟」的怪状态。
    docs.forEach((doc, index) => {
      const card = viewMode === 'grid' ? gridCard(doc) : listRow(doc);
      card.style.setProperty('--stagger-i', String(Math.min(index, CARD_STAGGER_MAX - 1)));
      grid.append(card);
    });

    const countText = isFiltering(filter)
      ? `筛选出 ${docs.length} 篇 / 共 ${sorted.length} 篇`
      : `共 ${docs.length} 篇`;
    body.append(
      el(
        'section',
        { class: 'shelf-section' },
        sectionHead('我的书架', {
          label: viewMode === 'grid' ? '查看全部' : '网格视图',
          testId: 'shelf-view-all',
          onClick: () => setViewMode(viewMode === 'grid' ? 'list' : 'grid'),
        }),
        filterStrip(state) ?? el('span'),
        docs.length > 0 ? grid : filteredEmpty(),
        el('p', { class: 'shelf-count', 'data-testid': 'shelf-count', text: countText }),
      ),
    );

    if (selecting) paintCardsSelection();
  }

  /**
   * 筛选条（阶段 E1）：全部 / 收藏 / 各标签 / 各文件夹。
   * 没有收藏、没有标签也没有文件夹时不渲染，避免空工具栏占位。
   * 点已选中的 chip 回到「全部」（单选 + 可取消）。
   */
  function filterStrip(state: State): HTMLElement | null {
    const facets = collectFacets(state.docs, state.bookmarks);
    if (facets.favorites === 0 && facets.tags.length === 0 && facets.folders.length === 0) return null;

    const row = el('div', {
      class: 'shelf-filters',
      'data-testid': 'shelf-filters',
      role: 'group',
      'aria-label': '筛选书架',
    });
    row.append(filterChip({ kind: 'all' }, '全部', facets.total, 'shelf-filter-all'));
    row.append(filterChip({ kind: 'favorites' }, '收藏', facets.favorites, 'shelf-filter-favorites'));
    facets.tags.forEach((tag, index) => {
      row.append(
        filterChip({ kind: 'tag', tag: tag.value }, `#${tag.value}`, tag.count, `shelf-filter-tag-${index}`),
      );
    });
    facets.folders.forEach((folder, index) => {
      row.append(
        filterChip(
          { kind: 'folder', folder: folder.value },
          folder.value,
          folder.count,
          `shelf-filter-folder-${index}`,
        ),
      );
    });
    return row;
  }

  function sameFilter(a: ShelfFilter, b: ShelfFilter): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'tag' && b.kind === 'tag') return a.tag.toLowerCase() === b.tag.toLowerCase();
    if (a.kind === 'folder' && b.kind === 'folder') return a.folder === b.folder;
    return true;
  }

  function filterChip(next: ShelfFilter, label: string, count: number, testId: string): HTMLElement {
    const on = sameFilter(filter, next);
    const chip = el('button', {
      class: on ? 'shelf-filter shelf-filter--on ui-press' : 'shelf-filter ui-press',
      type: 'button',
      'data-testid': testId,
      'aria-pressed': on ? 'true' : 'false',
      text: `${label} ${count}`,
    });
    chip.addEventListener('click', () => {
      // 再点一次已选中的：回到全部
      filter = on ? { kind: 'all' } : next;
      paintBody(deps.getState());
    });
    return chip;
  }

  /** 筛选后没有任何文档：明确告诉用户是筛选的结果，并给一键清除。 */
  function filteredEmpty(): HTMLElement {
    const clear = el('button', {
      class: 'btn shelf-empty__action ui-press',
      type: 'button',
      'data-testid': 'shelf-filter-clear',
      text: '清除筛选',
    });
    clear.addEventListener('click', () => {
      filter = { kind: 'all' };
      paintBody(deps.getState());
    });
    return el(
      'div',
      { class: 'shelf-filter-empty', 'data-testid': 'shelf-filter-empty' },
      el('p', { class: 'shelf-filter-empty__hint', text: '这个筛选下还没有文档。' }),
      clear,
    );
  }

  function continueCard(doc: Doc): HTMLElement {
    const percent = doc.progress?.percent;
    // 旧数据只有位置、没有百分比：显示时长而不是编一个百分数
    const meta = percent === undefined ? `约 ${estimatedMinutes(doc.text)} 分钟` : `${percent}% · 约 ${estimatedMinutes(doc.text)} 分钟`;
    const card = el(
      'button',
      { class: 'continue-card ui-press', type: 'button', 'data-testid': 'continue-open' },
      coverBlock(doc, 'cover--continue', true),
      el(
        'span',
        { class: 'continue-card__body' },
        el('span', { class: 'continue-card__title', text: doc.title }),
        el('span', { class: 'continue-card__meta', text: meta }),
        progressBar(percent, 'continue-progress') ?? el('span', { class: 'progress progress--empty' }),
      ),
      el('span', { class: 'continue-card__play', 'aria-hidden': 'true' }, icon('play')),
    );
    card.addEventListener('click', () => deps.dispatch({ type: 'doc/opened', docId: doc.id }));
    return card;
  }

  function emptyShelf(): HTMLElement {
    const importBtn = el('button', {
      class: 'btn btn--accent shelf-empty__action ui-press',
      type: 'button',
      'data-testid': 'empty-import',
      text: '导入文档',
    });
    importBtn.addEventListener('click', () => deps.requestImport());
    return el(
      'div',
      { class: 'shelf-empty', 'data-testid': 'shelf-empty' },
      el('div', { class: 'shelf-empty__mark', 'aria-hidden': 'true' }, icon('book')),
      el('h2', { class: 'shelf-empty__title', text: '书架空着' }),
      el('p', {
        class: 'shelf-empty__hint',
        text: '点下面的「＋」导入 .md / .txt，或在文件管理器里把笔记分享到墨读。',
      }),
      importBtn,
    );
  }

  function setViewMode(next: ViewMode): void {
    if (viewMode === next) return;
    viewMode = next;
    paintBody(deps.getState());
  }

  function setSort(next: SortMode): void {
    if (sort === next) return;
    sort = next;
    paintBody(deps.getState());
  }

  // ── 更多菜单：排序 / 视图 / 导入 / 设置 ──
  function openMoreMenu(anchorEl: HTMLElement): void {
    const rect = anchorEl.getBoundingClientRect();
    const spec: MenuSpec = {
      variant: 'popover',
      anchor: { top: rect.top, bottom: rect.bottom, right: rect.right },
      items: [
        { id: 'shelf-sort-recent', label: SORT_LABEL.recent, checked: sort === 'recent', onSelect: () => setSort('recent') },
        { id: 'shelf-sort-name', label: SORT_LABEL.name, checked: sort === 'name', onSelect: () => setSort('name') },
        { id: 'shelf-sort-imported', label: SORT_LABEL.imported, checked: sort === 'imported', onSelect: () => setSort('imported') },
        { id: 'shelf-view-grid', label: '网格视图', checked: viewMode === 'grid', onSelect: () => setViewMode('grid') },
        { id: 'shelf-view-list', label: '列表视图', checked: viewMode === 'list', onSelect: () => setViewMode('list') },
        { id: 'shelf-menu-import', label: '导入文档', icon: 'plus', onSelect: () => deps.requestImport() },
        { id: 'shelf-menu-settings', label: '设置', icon: 'settings', onSelect: () => deps.dispatch({ type: 'nav/tab', tab: 'settings' }) },
      ],
    };
    deps.openMenu(spec);
  }

  // ── 初次绘制与更新 ──
  paintHero(initial);
  paintBody(initial);

  return {
    el: page,
    update(state: State) {
      const nextDocs = docsSignature(state);
      if (nextDocs !== docsSig) {
        docsSig = nextDocs;
        // 被删掉的文档要从选择集合里清掉，避免「已选数量」包含不存在的项
        for (const id of [...selected]) if (!state.docs.some((d) => d.id === id)) selected.delete(id);
        if (state.docs.length === 0) exitSelection();
        paintHero(state);
        paintBody(state);
        if (selecting) paintSelection();
        return;
      }
      const nextHero = heroSignature(state);
      if (nextHero !== heroSig) {
        heroSig = nextHero;
        paintHero(state);
      }
      if (selecting) paintCardsSelection();
    },
    destroy() {
      destroyed = true;
      if (heroTimer !== null) window.clearInterval(heroTimer);
      heroTimer = null;
      heroObserver?.disconnect();
      heroObserver = null;
      window.removeEventListener('scroll', onScroll);
    },
  };
}
