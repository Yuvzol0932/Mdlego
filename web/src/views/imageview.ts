/**
 * 正文图片全屏查看（阶段 C4）—— 浮层的一种（LayerKind 'image'）。
 *
 * 交互：单击遮罩/关闭按钮退出；双击图片在 1x / 2x 之间切换；
 * 双指缩放（1x–4x）+ 放大后单指拖动平移。
 * 只动 transform / opacity，符合动效红线。
 */

import { el, icon } from './app';

export interface ImageView {
  readonly el: HTMLElement;
  destroy(): void;
}

const MAX_SCALE = 4;
const DOUBLE_TAP_MS = 280;

export function createImageView(src: string, onClose: () => void): ImageView {
  let scale = 1;
  let tx = 0;
  let ty = 0;

  const layer = el('div', { class: 'imgview', 'data-testid': 'image-view', role: 'dialog', 'aria-label': '图片查看' });
  const scrim = el('div', { class: 'imgview__scrim' });
  const img = el('img', { class: 'imgview__img', src, alt: '' });
  const close = el('button', {
    class: 'icon-btn imgview__close',
    type: 'button',
    'data-testid': 'image-view-close',
    'aria-label': '关闭图片',
  }, icon('close'));
  const hint = el('p', { class: 'imgview__hint', text: '双击放大 · 双指缩放' });
  const stage = el('div', { class: 'imgview__stage' }, img);

  function apply(): void {
    img.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
    layer.setAttribute('data-zoomed', scale > 1 ? '1' : '0');
  }

  function reset(): void {
    scale = 1;
    tx = 0;
    ty = 0;
    apply();
  }

  function clampPan(): void {
    if (scale <= 1) {
      tx = 0;
      ty = 0;
      return;
    }
    // 允许的平移范围随放大倍数增长；留一点弹性余量
    const rect = stage.getBoundingClientRect();
    const maxX = (rect.width * (scale - 1)) / 2 + 24;
    const maxY = (rect.height * (scale - 1)) / 2 + 24;
    tx = Math.max(-maxX, Math.min(maxX, tx));
    ty = Math.max(-maxY, Math.min(maxY, ty));
  }

  // ── 双击放大 ──
  let lastTap = 0;
  img.addEventListener('click', (event) => {
    event.stopPropagation();
    const now = Date.now();
    if (now - lastTap < DOUBLE_TAP_MS) {
      lastTap = 0;
      if (scale > 1) reset();
      else {
        scale = 2;
        // 双击位置作为放大中心（相对视口中心）
        tx = (window.innerWidth / 2 - event.clientX) * 0.6;
        ty = (window.innerHeight / 2 - event.clientY) * 0.6;
        clampPan();
        apply();
      }
      return;
    }
    lastTap = now;
  });

  // ── 双指缩放 + 放大后拖动 ──
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { dist: number; scale: number } | null = null;
  let drag: { x: number; y: number; tx: number; ty: number } | null = null;

  stage.addEventListener('pointerdown', (event) => {
    stage.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0)), scale };
      drag = null;
    } else if (pointers.size === 1 && scale > 1) {
      drag = { x: event.clientX, y: event.clientY, tx, ty };
    }
  });

  stage.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch !== null && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0));
      if (pinch.dist > 0) {
        scale = Math.max(1, Math.min(MAX_SCALE, (dist / pinch.dist) * pinch.scale));
        clampPan();
        apply();
      }
      return;
    }
    if (drag !== null && pointers.size === 1) {
      tx = drag.tx + (event.clientX - drag.x);
      ty = drag.ty + (event.clientY - drag.y);
      clampPan();
      apply();
    }
  });

  const endPointer = (event: PointerEvent): void => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) drag = null;
    if (scale <= 1.02) reset();
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  scrim.addEventListener('click', onClose);
  close.addEventListener('click', onClose);
  apply();

  layer.append(scrim, stage, close, hint);
  return {
    el: layer,
    destroy() {
      img.removeAttribute('src');
    },
  };
}
