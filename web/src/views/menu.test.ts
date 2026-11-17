// @vitest-environment jsdom
/**
 * 菜单浮层（阶段 C2）：popover / sheet / dialog 三种形态与关闭语义。
 * 只验结构与回调顺序，位置计算（anchor）由真实 Chrome 冒烟覆盖。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderMenu, type MenuSpec } from './menu';

beforeEach(() => {
  document.body.innerHTML = '';
});

const base: MenuSpec = {
  variant: 'popover',
  anchor: { top: 10, bottom: 40, right: 380 },
  items: [
    { id: 'sort-recent', label: '最近阅读', checked: true, onSelect: () => undefined },
    { id: 'sort-name', label: '按名称', onSelect: () => undefined },
  ],
};

describe('菜单浮层', () => {
  it('popover：渲染全部条目，锚点用行内 top/right 定位', () => {
    const el = renderMenu(base, () => undefined, () => undefined);
    document.body.append(el);
    expect(el.getAttribute('data-testid')).toBe('menu-layer');
    const panel = el.querySelector('[data-testid="menu-panel"]');
    expect(panel?.classList.contains('menu-layer--popover')).toBe(false);
    expect(el.classList.contains('menu-layer--popover')).toBe(true);
    expect(panel?.getAttribute('style')).toContain('top');
    expect(el.querySelectorAll('[data-testid^="menu-sort-"]')).toHaveLength(2);
    expect(el.querySelector('[data-testid="menu-sort-recent"]')?.getAttribute('aria-checked')).toBe('true');
  });

  it('点条目：先回调 onPick（含条目本身），由上层决定先关浮层', () => {
    const picks: string[] = [];
    const closes: string[] = [];
    const el = renderMenu(base, (item) => picks.push(item.id), () => closes.push('close'));
    document.body.append(el);
    el.querySelector<HTMLButtonElement>('[data-testid="menu-sort-name"]')?.click();
    expect(picks).toEqual(['sort-name']);
  });

  it('点遮罩关闭', () => {
    const onClose = vi.fn();
    const el = renderMenu(base, () => undefined, onClose);
    document.body.append(el);
    el.querySelector<HTMLElement>('[data-testid="menu-scrim"]')?.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dialog：带标题与 role=alertdialog', () => {
    const el = renderMenu(
      { variant: 'dialog', title: '删除 2 篇文档？', items: [{ id: 'confirm', label: '删除', danger: true, onSelect: () => undefined }] },
      () => undefined,
      () => undefined,
    );
    document.body.append(el);
    expect(el.classList.contains('menu-layer--dialog')).toBe(true);
    expect(el.querySelector('[data-testid="menu-panel"]')?.getAttribute('role')).toBe('alertdialog');
    expect(el.textContent).toContain('删除 2 篇文档？');
    expect(el.querySelector('[data-testid="menu-confirm"]')?.classList.contains('menu-item--danger')).toBe(true);
  });

  it('sheet：类名用于底部面板布局', () => {
    const el = renderMenu({ variant: 'sheet', items: base.items }, () => undefined, () => undefined);
    expect(el.classList.contains('menu-layer--sheet')).toBe(true);
  });
});
