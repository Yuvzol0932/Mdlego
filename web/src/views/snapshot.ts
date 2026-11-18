/**
 * 退书转场的「视口轻量快照」提取（转场改造 Step 2）。
 *
 * 问题：退书时整篇长文的所有分片都已挂在 DOM 里（900KB 文档实测 3751 块、
 * 三万多节点）。把这样的整树塞进转场层再逐帧动 `clip-path`，浏览器每帧
 * 都要重新光栅化整篇内容 —— 实测掉到约 6fps，且收拢时正文被矩形框硬裁断。
 *
 * 做法：只克隆**当前视口内可见的十来个块**，按它们相对视口的精确偏移
 * 放进一个 `height:100vh; overflow:hidden` 的轻量层。这样转场期间只需
 * 光栅化一屏静态内容，与原文多长无关。
 *
 * 约束（与项目红线一致）：
 *   - 纯 DOM 读 + 克隆，不改任何状态，不 dispatch；
 *   - 不 `cloneNode(true)` 整篇；
 *   - 不改原文节点（只读 rect 与计算样式）。
 */

/** 快照里保留的视口外缓冲（px）：略微超出视口，避免形变时露出边缘。 */
export const SNAPSHOT_BUFFER_PX = 120;

/** 一个被复制的可视块：克隆节点 + 它相对快照层顶部的偏移。 */
export interface SnapshotBlock {
  /** 克隆出来的块节点（已剥离 id / data-bid 之外的重事件无关属性由调用方决定）。 */
  readonly node: HTMLElement;
  /** 相对快照层顶部（即视口顶部）的偏移 px。 */
  readonly top: number;
}

/** 视口快照。 */
export interface ViewportSnapshot {
  /** 克隆的正文块，按文档顺序。 */
  readonly blocks: readonly SnapshotBlock[];
  /** 正文容器在视口坐标系里的载入内容总高度（用于背景定位）。 */
  readonly articleScrollY: number;
  /** 是否至少抓到一个块（false 表示调用方应退回整树克隆或直接淡出）。 */
  readonly hasContent: boolean;
}

/**
 * 挑出「与视口相交（含缓冲）」的正文块并克隆。
 *
 * @param article 阅读页正文容器（`<article>`）
 * @param viewportHeight 视口高度 px
 * @param buffer 视口上下各留多少缓冲 px
 */
export function snapshotViewport(
  article: HTMLElement,
  viewportHeight: number,
  buffer: number = SNAPSHOT_BUFFER_PX,
): ViewportSnapshot {
  const blocks: SnapshotBlock[] = [];
  const top = -buffer;
  const bottom = viewportHeight + buffer;

  for (const child of article.children) {
    if (!(child instanceof HTMLElement)) continue;
    const rect = child.getBoundingClientRect();
    // 完全在缓冲窗口之外 → 不要
    if (rect.bottom < top || rect.top > bottom) continue;
    const clone = child.cloneNode(true) as HTMLElement;
    // 克隆体不参与交互与锚点索引：去掉 data-bid / id，避免与原文形成重复锚点，
    // 也让批注高亮/选区逻辑扫不到它（它只是画面）。
    stripIdentity(clone);
    blocks.push({ node: clone, top: rect.top });
  }

  return {
    blocks,
    articleScrollY: window.scrollY,
    hasContent: blocks.length > 0,
  };
}

/** 递归去掉克隆体里的 id 与 data-bid（保留可见内容与样式类）。 */
function stripIdentity(node: HTMLElement): void {
  node.removeAttribute('id');
  node.removeAttribute('data-bid');
  for (const el of node.querySelectorAll('[id]')) el.removeAttribute('id');
  for (const el of node.querySelectorAll('[data-bid]')) el.removeAttribute('data-bid');
}

/**
 * 把快照铺进一个固定视口尺寸的层里。
 *
 * 每个块用 `position: absolute; top: <原视口偏移>px; left/right: 0` 定位，
 * 所以画面与原件逐像素对齐 —— 用户看不出这是「复制」出来的。
 */
export function buildSnapshotLayer(snapshot: ViewportSnapshot, className: string): HTMLElement {
  const layer = document.createElement('div');
  layer.className = className;
  for (const block of snapshot.blocks) {
    block.node.style.position = 'absolute';
    block.node.style.left = '0';
    block.node.style.right = '0';
    block.node.style.top = `${block.top}px`;
    layer.append(block.node);
  }
  return layer;
}

/**
 * 能否用快照替代整树克隆。
 *
 * 快照只适合「正文是正常流式排版」的情况；文章容器里若有 sticky/fixed 的
 * 子元素（例如吸顶目录），`position: absolute` 会改变其定位上下文。
 * 这里只做一层保守判断：抓到内容就用快照，抓不到（例如全文为空）返回 false。
 */
export function canSnapshot(snapshot: ViewportSnapshot): boolean {
  return snapshot.hasContent;
}
