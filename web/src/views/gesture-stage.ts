/**
 * 跟手缩窗的形变层生命周期（1.2.1 #A）。
 *
 * ## 为什么单独抽一个模块
 *
 * v1.2.0 把这块逻辑写在 `main.ts` 与 `page-mask.ts` 里，结果出了两个叠加的
 * 问题，用户看到的是「开始后取消 → 页面错位 / 白屏」：
 *
 * 1. `prepareGestureStage()` 只盖了快照层与压暗层，**没有挂书架**
 *    （它不调 `update()`）。于是「转场层前面那个兄弟节点」不是书架，
 *    而是**真实阅读页**。
 * 2. 逐帧写景深时 `shelfBehindStage()` 拿到的就是那个阅读页，每帧给它写
 *    `style.transform = scale(0.95…1)`。
 * 3. 取消路径只拆临时层，**没有还原这些内联样式**，阅读页就永久带着
 *    `transform`。带 transform 的祖先会成为 `position: fixed` 后代的包含块，
 *    顶栏于是不再贴屏幕顶部 —— 表现为「阅读中」跑到屏幕中间、整页错位；
 *    个别机型叠加残留图层后直接白屏。
 *
 * ## 这一版的三条铁律
 *
 * - **绝不向真实页面（阅读页 / 书架）写内联样式。**
 *   需要「让底下露出书架」的观感时，只改**类名**，并且按 record/restore
 *   语义在收尾时还原到手势前的原值（不假设原来是空）。
 *
 * - **所有写入都发生在临时层自己身上**（`.page-mask` / `.page-mask__reader`
 *   / `.page-mask-scrim`），收尾时整层移除即可，不需要逐项还原。
 *
 * - **收尾只有一个出口 `endGestureStage()`**，幂等，且必须被调用：
 *   取消、提交、新手势开始（上一手势没有结束事件）、`visibilitychange`、
 *   `pagehide`、路由变化，任一情形都先调它。
 *
 * 模块本身**不做场景判断**（不读 store、不看路由），只负责「把这一层
 * 干净地建起来 / 干净地拆掉」。判断留给调用方，保证可单测。
 *
 * ## 景深怎么做（不碰真实页面）
 *
 * 手势期间底下不挂书架（`update()` 会重渲染书架，代价大且会打断手势）。
 * 所以景深由**压暗层 + 形变壳自身的轻微暗化**表达，真实阅读页只是被类名
 * 隐藏。这样既没有「整页浮起来、底下僵着」的割裂，也彻底断掉了
 * 「往真实页面写样式」这条污染路径。
 */

import { transformOf, type MorphState } from '../core/morph';
import { buildSnapshotLayer, canSnapshot, snapshotViewport } from './snapshot';

/** 形变层句柄。`end()` 幂等，可以安全地重复调用。 */
export interface GestureStage {
  /** 形变壳元素（`.page-mask`），逐帧把矩阵写给它。 */
  readonly element: HTMLElement;
  /** 应用一帧矩阵（只动临时层自己）。 */
  apply(state: MorphState): void;
  /** 收尾：拆除所有临时层并还原真实页面的类名。幂等。 */
  end(): void;
  /** 是否已经收尾。 */
  readonly ended: boolean;
}

export interface BeginGestureStageOptions {
  /** 真实的阅读页根节点（会被类名隐藏，**不会**被写内联样式）。 */
  readonly page: HTMLElement | null;
  /** 视口尺寸（每次手势开始时读一次）。 */
  readonly viewport: () => { readonly width: number; readonly height: number };
}

/** 真实页面在跟手期间被临时隐藏时使用的类名（不用内联样式）。 */
export const GESTURE_HIDDEN_CLASS = 'is-gesture-hidden';

/** 当前未收尾的形变层（同时最多一个）。 */
let openStage: GestureStage | null = null;

/** 是否有未收尾的形变层（诊断与测试用）。 */
export function hasOpenGestureStage(): boolean {
  return openStage !== null;
}

/**
 * 收掉当前形变层（如果有）。
 *
 * 这是**唯一**的收尾入口，所有异常路径都应该调它。
 * 幂等：没有打开的层时是空操作。
 */
export function endGestureStage(): void {
  const stage = openStage;
  openStage = null;
  if (stage === null) return;
  try {
    stage.end();
  } catch {
    /* 收尾本身不允许抛错，否则会把调用方（例如 visibilitychange）打断 */
  }
}

/**
 * 建一个跟手用的形变层。
 *
 * 结构（与 `runCloseMask` 的关闭方向同构，方便 commit 时直接接着播动画）：
 *
 * ```
 * [真实阅读页]                       ← 加类名隐藏，不写内联样式
 * [.page-mask-scrim]                ← 压暗层
 * [.page-mask]                      ← 形变壳（本函数返回的 element）
 *   [.page-mask__reader]            ← 快照层（一屏静态内容）
 * ```
 *
 * 返回 `null` 表示当前无法准备（没有阅读页 / 页面已脱离文档），
 * 调用方应退回普通返回、不做跟手。
 */
export function beginGestureStage(options: BeginGestureStageOptions): GestureStage | null {
  // 上一手势可能没有结束事件（原生漏发 / 应用被切走）：先收掉。
  // 这一步保证「同时只有一个形变层」，否则多层叠加就是白屏。
  endGestureStage();

  const page = options.page;
  if (page === null || !page.isConnected) return null;

  const viewport = options.viewport();
  const root = page.parentElement ?? document.body;

  const layer = document.createElement('div');
  layer.className = 'page-mask page-mask--closing';
  layer.setAttribute('data-testid', 'page-mask');
  layer.dataset['phase'] = 'gesture';
  layer.dataset['morph'] = 'flip';
  layer.dataset['snapshot'] = '0';
  layer.style.transformOrigin = '0 0';

  const reader = document.createElement('div');
  reader.className = 'page-mask__reader';
  reader.setAttribute('data-testid', 'page-mask-reader');
  layer.append(reader);

  const scrim = document.createElement('div');
  scrim.className = 'page-mask-scrim';
  scrim.setAttribute('data-testid', 'page-mask-scrim');
  scrim.style.opacity = '1';

  // 快照：只克隆屏内十来个块，与全文长度无关。
  // 抓不到内容时保持空层（纯色压暗 + 缩一个纯色壳），比整页错位好得多。
  const article = page.querySelector<HTMLElement>('[data-testid="article"]');
  if (article !== null) {
    try {
      const snapshot = snapshotViewport(article, viewport.height);
      if (canSnapshot(snapshot)) {
        reader.append(buildSnapshotLayer(snapshot, 'page-mask__snapshot'));
        layer.dataset['snapshot'] = '1';
      }
    } catch {
      /* 抓不到快照就降级，绝不打断手势 */
    }
  }

  // 真实页面用**类名**隐藏：类名可以按原值还原，内联样式不行。
  const hadHidden = page.classList.contains(GESTURE_HIDDEN_CLASS);
  page.classList.add(GESTURE_HIDDEN_CLASS);

  root.append(scrim, layer);

  let ended = false;
  const stage: GestureStage = {
    element: layer,
    get ended() {
      return ended;
    },
    apply(state: MorphState): void {
      if (ended) return;
      // 只写临时层自己：真实页面一个字节都不碰。
      // 圆角走 GPU 合成的 clip-path: inset(0 round R)，既符合 #B 约束，
      // 又让跟手缩窗自然呈现柔和圆角卡片观感，告别生硬直角矩形。
      layer.style.transform = transformOf(state);
      const r = Math.max(0, Math.round(state.radius * 10) / 10);
      layer.style.clipPath = `inset(0px 0px 0px 0px round ${r}px)`;
    },
    end(): void {
      if (ended) return;
      ended = true;
      if (openStage === stage) openStage = null;
      try {
        layer.remove();
      } catch { /* 已脱离文档 */ }
      try {
        scrim.remove();
      } catch { /* 已脱离文档 */ }
      // 还原类名：只在「原本没有」时才移除，避免抹掉别处加的同类名。
      if (!hadHidden) page.classList.remove(GESTURE_HIDDEN_CLASS);
    },
  };

  openStage = stage;
  return stage;
}
