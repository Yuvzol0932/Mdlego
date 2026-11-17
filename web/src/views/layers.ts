/**
 * 浮层宿主：让 DOM 里的浮层与 state.nav.layers 保持一致。
 *
 * 浮层栈是唯一事实：谁在栈里谁就挂着，不在栈里就摘掉。
 * 打开/关闭浮层只需要 dispatch layer/opened、layer/closed（或 nav/back），
 * 不再有「手写优先级链」与「重渲染后手动重新挂浮层」。
 */

import type { LayerKind, SearchHit, State } from '../core/types';
import { closeLookupCard, isLookupCardOpen } from './lookup';
import { createSearchOverlay, renderTocDrawer } from './overlays';

export interface LayerHandlers {
  /** 目录里点了某一项。 */
  pickToc: (bid: string) => void;
  /** 当前正在读的块（目录里高亮用）。 */
  activeBid: () => string | null;
  /** 搜索框输入了新关键词（已防抖）。 */
  query: (query: string) => void;
  /** 搜索结果里点了某一条。 */
  pickHit: (hit: SearchHit) => void;
  /** 用户点遮罩/关闭按钮。 */
  close: (layer: LayerKind) => void;
}

export interface LayerHost {
  sync(state: State): void;
}

export function createLayerHost(root: HTMLElement, handlers: LayerHandlers): LayerHost {
  let tocEl: HTMLElement | null = null;
  let search: { el: HTMLElement; update: (state: State) => void } | null = null;

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
    },
  };
}
