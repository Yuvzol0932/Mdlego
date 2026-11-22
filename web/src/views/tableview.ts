/**
 * 表格全屏横屏查看浮层 —— 浮层的一种（LayerKind 'table'）。
 *
 * 交互与结构：
 *   - 打开时自动请求 Android 横屏并隐藏系统状态栏/导航栏，退出或系统返回时恢复。
 *   - 深拷贝表格节点并剥离 data-bid / data-kind，避免与正文块索引冲突。
 *   - 采用「真冻结窗格双容器」：顶部独立 .tableview__head-pane + 下方 .tableview__stage，
 *     实时同步列宽与横向滚动偏移，彻底避免 WebView position: sticky 滚动态漏风。
 *   - 右下角紧凑悬浮胶囊提供字号缩放（75%..150%）与退出按钮，不占用顶部视野。
 */

import { el, icon } from './app';

export interface TableView {
  readonly el: HTMLElement;
  destroy(): void;
}

const ZOOM_STEPS = [75, 85, 100, 115, 130, 150] as const;
const DEFAULT_ZOOM_INDEX = 2;

function measureTable(table: HTMLTableElement): { rows: number; cols: number } {
  const trs = table.querySelectorAll('tr');
  let cols = 0;
  for (const tr of trs) {
    let count = 0;
    for (const child of tr.children) {
      const span = Number((child as HTMLTableCellElement).getAttribute('colspan') ?? '1');
      count += Number.isFinite(span) && span > 0 ? span : 1;
    }
    if (count > cols) cols = count;
  }
  return { rows: trs.length, cols };
}

function cloneCleanTable(sourceTable: HTMLTableElement): HTMLTableElement {
  const clone = sourceTable.cloneNode(true) as HTMLTableElement;
  clone.removeAttribute('data-bid');
  clone.removeAttribute('data-kind');
  for (const node of clone.querySelectorAll('[data-bid], [data-kind]')) {
    node.removeAttribute('data-bid');
    node.removeAttribute('data-kind');
  }
  return clone;
}

export function createTableView(sourceTable: HTMLTableElement, onClose: () => void): TableView {
  let zoomIndex = DEFAULT_ZOOM_INDEX;

  const clone = cloneCleanTable(sourceTable);
  const { rows, cols } = measureTable(clone);

  const zoomOutBtn = el('button', {
    class: 'tableview__zoom-btn',
    type: 'button',
    'data-testid': 'table-zoom-out',
    'aria-label': '缩小表格字号',
    text: 'A−',
  });
  const zoomResetBtn = el('button', {
    class: 'tableview__zoom-btn',
    type: 'button',
    'data-testid': 'table-zoom-reset',
    'aria-label': '重置表格字号',
    text: '100%',
  });
  const zoomInBtn = el('button', {
    class: 'tableview__zoom-btn',
    type: 'button',
    'data-testid': 'table-zoom-in',
    'aria-label': '放大表格字号',
    text: 'A+',
  });

  const closeBtn = el('button', {
    class: 'icon-btn tableview__close',
    type: 'button',
    'data-testid': 'table-view-close',
    'aria-label': '退出全屏',
    title: '退出全屏',
  }, icon('close'));

  const tableHost = el('div', { class: 'tableview__table-host' }, clone);
  const stage = el('div', { class: 'tableview__stage', 'data-testid': 'table-view-stage' }, tableHost);

  const bodyThead = clone.querySelector('thead');
  const hasFrozenHead = bodyThead !== null && bodyThead.querySelector('tr') !== null;

  let headPane: HTMLElement | null = null;
  let syncHeader = (): void => {};
  let scheduleSync = (): void => {};
  let cleanupFrozenHead = (): void => {};

  if (hasFrozenHead && bodyThead !== null) {
    const headThead = bodyThead.cloneNode(true) as HTMLTableSectionElement;
    const headTable = el('table', { class: 'tableview__head-table' }, headThead);
    const headTrack = el('div', { class: 'tableview__head-track' }, headTable);
    headPane = el('div', { class: 'tableview__head-pane', 'data-testid': 'table-view-head' }, headTrack);

    clone.classList.add('is-head-frozen');
    bodyThead.setAttribute('aria-hidden', 'true');

    let rafId = 0;

    const syncScrollX = (): void => {
      headTrack.style.transform = `translate3d(${-stage.scrollLeft}px, 0, 0)`;
    };

    syncHeader = (): void => {
      const tableRect = clone.getBoundingClientRect();
      if (tableRect.width <= 0) return;

      const widthPx = `${tableRect.width}px`;
      headTable.style.width = widthPx;
      headTrack.style.width = widthPx;

      const srcCells = bodyThead.querySelectorAll<HTMLTableCellElement>('th, td');
      const dstCells = headThead.querySelectorAll<HTMLTableCellElement>('th, td');
      const count = Math.min(srcCells.length, dstCells.length);
      for (let i = 0; i < count; i += 1) {
        const srcCell = srcCells[i];
        const dstCell = dstCells[i];
        if (!srcCell || !dstCell) continue;
        const w = srcCell.getBoundingClientRect().width;
        const wPx = `${w}px`;
        const cellStyle = dstCell.style;
        cellStyle.width = wPx;
        cellStyle.minWidth = wPx;
        cellStyle.maxWidth = wPx;
      }

      const headHeight = bodyThead.getBoundingClientRect().height;
      stage.style.setProperty('--tv-head-h', `${headHeight}px`);
      syncScrollX();
    };

    scheduleSync = (): void => {
      if (rafId !== 0) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        syncHeader();
      });
    };

    stage.addEventListener('scroll', syncScrollX, { passive: true });
    window.addEventListener('resize', syncHeader);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        syncHeader();
      });
      observer.observe(clone);
      observer.observe(stage);
    }

    scheduleSync();

    cleanupFrozenHead = (): void => {
      if (rafId !== 0) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      stage.removeEventListener('scroll', syncScrollX);
      window.removeEventListener('resize', syncHeader);
      observer?.disconnect();
    };
  }

  const hud = el(
    'div',
    { class: 'tableview__hud glass', 'data-testid': 'table-view-hud' },
    zoomOutBtn,
    zoomResetBtn,
    zoomInBtn,
    el('span', { class: 'tableview__hud-sep', 'aria-hidden': 'true' }),
    closeBtn,
  );

  const layerChildren: HTMLElement[] = [];
  if (headPane !== null) layerChildren.push(headPane);
  layerChildren.push(stage, hud);

  const layer = el(
    'div',
    {
      class: hasFrozenHead ? 'tableview' : 'tableview tableview--no-head',
      'data-testid': 'table-view',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': `表格全屏查看，共 ${rows} 行 ${cols} 列`,
    },
    ...layerChildren,
  );

  const applyZoom = (): void => {
    const pct = ZOOM_STEPS[zoomIndex] ?? 100;
    layer.style.setProperty('--tv-scale', String(pct / 100));
    zoomResetBtn.textContent = `${pct}%`;
    zoomOutBtn.disabled = zoomIndex <= 0;
    zoomInBtn.disabled = zoomIndex >= ZOOM_STEPS.length - 1;
    syncHeader();
    scheduleSync();
  };

  zoomOutBtn.addEventListener('click', () => {
    if (zoomIndex <= 0) return;
    zoomIndex -= 1;
    applyZoom();
  });
  zoomInBtn.addEventListener('click', () => {
    if (zoomIndex >= ZOOM_STEPS.length - 1) return;
    zoomIndex += 1;
    applyZoom();
  });
  zoomResetBtn.addEventListener('click', () => {
    zoomIndex = DEFAULT_ZOOM_INDEX;
    applyZoom();
  });
  closeBtn.addEventListener('click', onClose);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  applyZoom();

  return {
    el: layer,
    destroy(): void {
      window.removeEventListener('keydown', onKeyDown);
      cleanupFrozenHead();
    },
  };
}
