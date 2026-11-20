/**
 * 锚定菜单 / 底部面板 / 确认框（阶段 C2）。
 *
 * 三者共用一种浮层（LayerKind 'menu'）：内容不进 state（state 只记「开着」），
 * 由 main.ts 持有当前 MenuSpec，关闭时清掉 —— 这样 reducer 保持纯函数，
 * 菜单项的回调也不会被写进状态树。
 *
 * 返回路径不变：系统返回键 / 遮罩点击 → dispatch layer/closed('menu')。
 */

import { el, icon } from './app';
import type { IconName } from './icons';

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  /** 显式 data-testid；缺省用 `menu-${id}`。需要与既有 testid 约定对齐时用（如 open-toc）。 */
  readonly testId?: string;
  /** 右侧补充说明（如「按名称排序」）。 */
  readonly hint?: string;
  readonly icon?: IconName;
  /** 当前选中项（排序/视图切换用）。 */
  readonly checked?: boolean;
  /** 破坏性操作（删除）用危险色。 */
  readonly danger?: boolean;
  /** 主推荐操作（如首选更新线路）用强调色底。 */
  readonly accent?: boolean;
  readonly onSelect: () => void;
}

export interface MenuSpec {
  readonly variant: 'popover' | 'sheet' | 'dialog';
  /** 面板标题（dialog 必填，sheet/popover 可选）。 */
  readonly title?: string;
  /** 副标题或版本对比说明。 */
  readonly description?: string;
  /** 要点列表（纯文本条目，如更新日志）。 */
  readonly notes?: readonly string[];
  readonly items: readonly MenuItem[];
  /**
   * popover 的锚点（视口坐标，取触发按钮的 getBoundingClientRect()）。
   * panel 会贴着它的下沿右对齐展开，并自动避让屏幕左右边缘。
   */
  readonly anchor?: { readonly top: number; readonly bottom: number; readonly right: number };
}

/** 面板宽度上限（与 CSS 的 max-width 对应，用于避让计算）。 */
const PANEL_MAX_W = 248;
const PANEL_GAP = 8;

/** 渲染菜单浮层。点击遮罩关闭；点菜单项先执行回调再关闭。 */
export function renderMenu(
  spec: MenuSpec,
  onPick: (item: MenuItem) => void,
  onClose: () => void,
): HTMLElement {
  const layer = el('div', {
    class: `menu-layer menu-layer--${spec.variant}`,
    'data-testid': 'menu-layer',
    role: 'presentation',
  });

  const scrim = el('div', { class: 'menu-layer__scrim', 'data-testid': 'menu-scrim' });
  scrim.addEventListener('click', () => onClose());
  layer.append(scrim);

  const panel = el('div', {
    class: 'menu-panel glass',
    role: spec.variant === 'dialog' ? 'alertdialog' : 'menu',
    'data-testid': 'menu-panel',
    ...(spec.title !== undefined ? { 'aria-label': spec.title } : {}),
  });

  if (spec.variant === 'sheet') {
    // 底部面板：顶部给一个把手，供下拉关闭手势抓取（阶段 D3）
    panel.append(el('span', { class: 'menu-panel__handle', 'aria-hidden': 'true' }));
  }

  if (spec.title !== undefined) {
    panel.append(el('div', { class: 'menu-panel__title', text: spec.title }));
  }

  if (spec.description !== undefined) {
    panel.append(el('div', { class: 'menu-panel__desc', 'data-testid': 'menu-desc', text: spec.description }));
  }

  if (spec.notes !== undefined && spec.notes.length > 0) {
    const listEl = el('ul', { class: 'menu-panel__notes', 'data-testid': 'menu-notes' });
    for (const line of spec.notes) {
      listEl.append(el('li', { text: line }));
    }
    panel.append(listEl);
  }

  const list = el('div', { class: 'menu-panel__list' });
  for (const item of spec.items) {
    // 图标槽位始终占位，没有图标的条目也能让文字对齐
    const iconSlot = el('span', { class: 'menu-item__icon', 'aria-hidden': 'true' });
    if (item.icon !== undefined) iconSlot.append(icon(item.icon));
    const itemClass =
      item.danger === true
        ? 'menu-item menu-item--danger'
        : item.accent === true
          ? 'menu-item menu-item--accent'
          : 'menu-item';
    const btn = el(
      'button',
      {
        class: itemClass,
        type: 'button',
        'data-testid': item.testId ?? `menu-${item.id}`,
        role: 'menuitem',
        ...(item.checked === true ? { 'aria-checked': 'true' } : {}),
      },
      iconSlot,
      el('span', { class: 'menu-item__label', text: item.label }),
      item.hint !== undefined
        ? el('span', { class: 'menu-item__hint', text: item.hint })
        : item.checked === true
          ? el('span', { class: 'menu-item__check', 'aria-hidden': 'true' }, icon('check'))
          : el('span', { class: 'menu-item__hint' }),
    );
    btn.addEventListener('click', () => onPick(item));
    list.append(btn);
  }
  panel.append(list);

  if (spec.variant === 'popover' && spec.anchor !== undefined) {
    // 贴锚点下沿、右对齐到触发按钮的右边缘，并夹在屏幕内（左右各留 8px）
    const viewport = window.innerWidth;
    const maxRight = Math.max(PANEL_GAP, viewport - PANEL_MAX_W - PANEL_GAP);
    const right = Math.min(maxRight, Math.max(PANEL_GAP, viewport - spec.anchor.right));
    panel.style.setProperty('top', `${Math.round(spec.anchor.bottom + PANEL_GAP)}px`);
    panel.style.setProperty('right', `${Math.round(right)}px`);
    panel.style.setProperty('max-width', `${PANEL_MAX_W}px`);
  }

  layer.append(panel);
  return layer;
}
