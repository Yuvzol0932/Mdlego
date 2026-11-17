/**
 * 图标精灵：统一线性风格（24 栅格、2px 描边、圆头圆角、currentColor）。
 *
 * 所有图标是一份 <symbol> 精灵，整个文档只注入一次；
 * 页面里用 <use href="#i-名字"> 引用，不重复携带路径数据，也不依赖图标字体。
 */

export type IconName =
  | 'settings' | 'back' | 'type' | 'plus' | 'list' | 'search' | 'close' | 'trash'
  | 'book' | 'shelf' | 'chart' | 'more' | 'bookmark' | 'play' | 'check' | 'chevron'
  | 'drop' | 'underline' | 'strike' | 'note' | 'copy' | 'sun' | 'moon' | 'palette' | 'image'
  | 'database' | 'info' | 'download' | 'clock' | 'flame' | 'sliders' | 'sparkle';

/** 每个图标的路径（可含多段）。 */
export const ICON_PATHS: Readonly<Record<IconName, string>> = {
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
  back: 'M19 12H5M11 18l-6-6 6-6',
  type: 'M3 18 7.5 6 12 18M4.6 14h5.8M14 18l3-8 3 8M15.2 15.2h3.6',
  plus: 'M12 5v14M5 12h14',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.35-4.35',
  close: 'M18 6 6 18M6 6l12 12',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  // 书（打开的两页）
  book: 'M2 5.5C4.5 4 8 4 12 6.5 16 4 19.5 4 22 5.5V19c-2.5-1.5-6-1.5-10 1-4-2.5-7.5-2.5-10-1V5.5ZM12 6.5V20',
  // 书架：三本竖放的书
  shelf: 'M4 4h4v16H4zM10 4h4v16h-4zM16.2 5.2l3.8-1 3.2 15.6-3.8 1z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  more: 'M12 5h.01M12 12h.01M12 19h.01',
  bookmark: 'M6 3h12v18l-6-4.5L6 21V3Z',
  play: 'M8 5.5v13l11-6.5-11-6.5Z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  chevron: 'M9 6l6 6-6 6',
  // 水滴（高亮）
  drop: 'M12 3s6 6.2 6 10.5A6 6 0 0 1 6 13.5C6 9.2 12 3 12 3Z',
  underline: 'M7 4v7a5 5 0 0 0 10 0V4M5 20h14',
  strike: 'M4 12h16M7 7.2c1.2-.8 2.8-1.2 4.4-1.2 2.5 0 4.6 1 4.6 2.6 0 1.2-1 2-2.8 2.4M7.3 17.1c1.3.8 2.9 1.2 4.6 1.2 2.8 0 4.8-1 4.8-2.7',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  // 批注（带折角的方框）
  note: 'M5 4h14v11l-5 5H5V4ZM14 20v-5h5M8.5 9h7M8.5 12.5h4',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z',
  palette: 'M12 3a9 9 0 1 0 0 18c1.4 0 2-1 1.6-2-.5-1.2.3-2.5 1.7-2.5H17a4 4 0 0 0 4-4C21 7 17 3 12 3ZM7.5 11h.01M10 7.5h.01M14.5 7.5h.01',
  image: 'M4 5h16v14H4V5ZM4 16l5-5 4 4 3-3 4 4M9 9.5h.01',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3ZM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8h.01',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  flame: 'M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 .3 1.2 1 2 2 2 0-3-.5-5 1-8Z',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M9 14v6',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM19 16l.7 1.8L21.5 18.5l-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7L19 16Z',
};

/** 生成整份精灵（<svg hidden> 包着一堆 <symbol>）。 */
export function spriteMarkup(): string {
  const symbols = (Object.keys(ICON_PATHS) as IconName[])
    .map((name) => `<symbol id="i-${name}" viewBox="0 0 24 24"><path d="${ICON_PATHS[name]}"/></symbol>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">${symbols}</svg>`;
}

/** 精灵只注入一次。 */
export function ensureSprite(doc: Document = document): void {
  if (doc.getElementById('mdlego-sprite') !== null) return;
  const holder = doc.createElement('div');
  holder.id = 'mdlego-sprite';
  holder.setAttribute('aria-hidden', 'true');
  holder.innerHTML = spriteMarkup();
  doc.body.prepend(holder);
}
