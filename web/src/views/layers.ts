/**
 * 浮层宿主：让 DOM 里的浮层与 state.nav.layers 保持一致。
 *
 * 浮层栈是唯一事实：谁在栈里谁就挂着，不在栈里就摘掉。
 * 打开/关闭浮层只需要 dispatch layer/opened、layer/closed（或 nav/back），
 * 不再有「手写优先级链」与「重渲染后手动重新挂浮层」。
 */

import type { LayerKind, SearchHit, State, StateAction } from '../core/types';
import { allowsTransform, sheetDuration, type MotionLevel } from '../core/motion';
import { closeLookupCard, isLookupCardOpen } from './lookup';
import { createImageView } from './imageview';
import { renderMenu, type MenuItem, type MenuSpec } from './menu';
import { createSearchOverlay, renderTocDrawer } from './overlays';
import { enableSheetDrag, type SheetDragControl } from './sheet-drag';
import { createTypesetSheet, sheetLayer, type SheetView } from './typeset';

export interface LayerHandlers {
  /** 目录里点了某一项。 */
  pickToc: (bid: string) => void;
  /** 当前正在读的块（目录里高亮用）。 */
  activeBid: () => string | null;
  /** 搜索框输入了新关键词（已防抖）。 */
  query: (query: string) => void;
  /** 搜索结果里点了某一条。 */
  pickHit: (hit: SearchHit) => void;
  /** 当前菜单规格（main.ts 持有；不在栈里时返回 null）。 */
  menuSpec: () => MenuSpec | null;
  /** 当前要全屏查看的图片地址（main.ts 持有）。 */
  imageSrc: () => string | null;
  /** 排版面板里改设置要派发的 action（面板自身只改 state，不做 IO）。 */
  dispatch: (action: StateAction) => void;
  /** 当前生效的动效强度（决定是否挂下拉手势）。 */
  motionLevel: () => MotionLevel;
  /** 用户点遮罩/关闭按钮。 */
  close: (layer: LayerKind) => void;
}

export interface LayerHost {
  sync(state: State): void;
}

export function createLayerHost(root: HTMLElement, handlers: LayerHandlers): LayerHost {
  let tocEl: HTMLElement | null = null;
  let search: { el: HTMLElement; update: (state: State) => void } | null = null;
  let menuEl: HTMLElement | null = null;
  let menuSpecRef: MenuSpec | null = null;
  let menuDrag: SheetDragControl | null = null;
  let typeset: { readonly sheet: SheetView; readonly layer: HTMLElement; readonly drag: SheetDragControl } | null = null;
  let image: { readonly el: HTMLElement; readonly destroy: () => void } | null = null;

  /** 当前是否允许「完整」动效（只有 full 才挂下拉手势，simple/off 用按钮关闭）。 */
  const dragEnabled = (): boolean => allowsTransform(handlers.motionLevel());

  return {
    sync(state) {
      const layers = state.nav.layers;

      // 目录
      if (layers.includes('toc') && state.render !== null) {
        if (tocEl === null) {
          tocEl = renderTocDrawer(
            state.render.toc,
            handlers.activeBid(),
            handlers.pickToc,
            () => handlers.close('toc'),
          );
          root.append(tocEl);
        }
      } else if (tocEl !== null) {
        tocEl.remove();
        tocEl = null;
      }

      // 搜索
      if (layers.includes('search')) {
        if (search === null) {
          search = createSearchOverlay(
            state,
            handlers.query,
            handlers.pickHit,
            () => handlers.close('search'),
          );
          root.append(search.el);
          const input = search.el.querySelector<HTMLInputElement>('[data-testid="search-input"]');
          window.setTimeout(() => input?.focus(), 60);
        } else {
          search.update(state);
        }
      } else if (search !== null) {
        search.el.remove();
        search = null;
      }

      // 查词卡片：节点由 lookup.ts 自己管，这里只负责「栈里没有了就关掉」
      if (!layers.includes('lookup') && isLookupCardOpen()) closeLookupCard();

      // 菜单 / 底部面板 / 确认框：规格变了就换一个，栈里没有就拆掉
      if (layers.includes('menu')) {
        const spec = handlers.menuSpec();
        if (spec !== null && (menuEl === null || spec !== menuSpecRef)) {
          menuEl?.remove();
          menuDrag?.destroy();
          menuDrag = null;
          menuSpecRef = spec;
          menuEl = renderMenu(
            spec,
            (item: MenuItem) => {
              // 先关浮层再执行回调：回调里可能打开另一个菜单（删除确认），
              // 关在前才能让新菜单拿到干净的栈。
              handlers.close('menu');
              item.onSelect();
            },
            () => handlers.close('menu'),
          );
          root.append(menuEl);
          // sheet 变体的菜单支持下拉关闭（任务书 §4.2）
          if (spec.variant === 'sheet') {
            const panel = menuEl.querySelector<HTMLElement>('.menu-panel');
            const scrim = menuEl.querySelector<HTMLElement>('.menu-layer__scrim');
            const handle = menuEl.querySelector<HTMLElement>('.menu-panel__handle');
            if (panel !== null) {
              menuDrag = enableSheetDrag({
                panel,
                scrim,
                handle,
                enabled: dragEnabled(),
                durationMs: sheetDuration(handlers.motionLevel()),
                onDismiss: () => handlers.close('menu'),
              });
            }
          }
        }
      } else if (menuEl !== null) {
        menuDrag?.destroy();
        menuDrag = null;
        menuEl.remove();
        menuEl = null;
        menuSpecRef = null;
      }

      // 排版面板（Aa）：开着时随设置变化同步控件值，不重建面板（拖动中的滑块不能被换掉）
      if (layers.includes('typeset')) {
        if (typeset === null) {
          const sheet = createTypesetSheet(state, handlers.dispatch);
          const layer = sheetLayer(sheet.el, () => handlers.close('typeset'));
          const drag = enableSheetDrag({
            panel: sheet.el,
            scrim: layer.querySelector<HTMLElement>('.sheet-layer__scrim'),
            handle: sheet.el.querySelector<HTMLElement>('.sheet-panel__handle'),
            enabled: dragEnabled(),
            durationMs: sheetDuration(handlers.motionLevel()),
            onDismiss: () => handlers.close('typeset'),
          });
          typeset = { sheet, layer, drag };
          root.append(layer);
        }
        typeset.sheet.update(state);
      } else if (typeset !== null) {
        typeset.drag.destroy();
        typeset.layer.remove();
        typeset = null;
      }

      // 全屏图片：地址变了就换一张（通常只会打开一次）
      if (layers.includes('image')) {
        const src = handlers.imageSrc();
        if (src !== null && image === null) {
          image = createImageView(src, () => handlers.close('image'));
          root.append(image.el);
        }
      } else if (image !== null) {
        image.destroy();
        image.el.remove();
        image = null;
      }
    },
  };
}
