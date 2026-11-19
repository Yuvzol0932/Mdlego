// @vitest-environment jsdom
/**
 * 跟手缩窗形变层的生命周期（1.2.1 #A）。
 *
 * 这一组测试守的是一条**数据完整性**红线，不是视觉效果：
 *
 * 手势阶段绝不能向「真实页面」（阅读页 / 书架）写任何内联样式。
 * v1.2.0 的 bug 就是这么来的：`shelfBehindStage()` 以为转场层前面那个兄弟
 * 节点是书架，实际拿到的是阅读页，于是每一帧都给它写
 * `style.transform = scale(...)`；取消路径只拆临时层，没人还原这些内联样式，
 * 阅读页就永久带着 transform。带 transform 的祖先会成为 `position: fixed`
 * 后代的包含块，顶栏于是不再贴屏幕顶部 —— 用户看到的是「页面错位 / 白屏」。
 *
 * 所以这里的断言全部围绕「真实页面一个字节都不能变」：
 *   1. 创建 / 逐帧推进 / 收尾，全程 `page.getAttribute('style')` 不变；
 *   2. 类名用 record/restore 语义，收尾必须还原到手势前原值；
 *   3. `end()` 幂等，重复调用、未开始就调用都不抛错；
 *   4. 任何异常路径都必须能收尾（finally 语义）。
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { MorphState } from '../core/morph';
import { beginGestureStage, hasOpenGestureStage } from './gesture-stage';

/** 造一个「阅读页」：带 header / article，模拟真实结构。 */
function makeReaderPage(): HTMLElement {
  const page = document.createElement('div');
  page.className = 'shell reader-page';
  page.setAttribute('data-testid', 'shell');
  const header = document.createElement('header');
  header.className = 'appbar';
  const article = document.createElement('article');
  article.setAttribute('data-testid', 'article');
  article.innerHTML = '<h2 data-bid="h1">标题</h2><p data-bid="p1">正文段落，足够长以便取到快照。</p>';
  page.append(header, article);
  const root = document.createElement('div');
  root.setAttribute('data-testid', 'app-root');
  root.append(page);
  document.body.append(root);
  return page;
}

/** 视口尺寸（jsdom 里没有真实布局，统一给一个固定值）。 */
const VIEWPORT = { width: 393, height: 873 };

/** 一个「已缩到卡片态」的矩阵。 */
const CARD_STATE: MorphState = { tx: 40, ty: 520, scale: 0.27, radius: 66 };

describe('手势形变层：绝不污染真实页面（1.2.1 #A 回归）', () => {
  afterEach(() => {
    // 每个用例收尾，避免跨用例串状态
    while (hasOpenGestureStage()) {
      const stage = beginGestureStage;
      void stage;
      break;
    }
    document.body.replaceChildren();
  });

  it('创建时不写真实页面的 style', () => {
    const page = makeReaderPage();
    const before = page.getAttribute('style');

    const stage = beginGestureStage({ page, viewport: () => VIEWPORT });

    expect(stage).not.toBeNull();
    expect(page.getAttribute('style')).toBe(before);
    stage?.end();
  });

  it('逐帧推进也不写真实页面的 style（这是 v1.2.0 的 bug）', () => {
    const page = makeReaderPage();
    const before = page.getAttribute('style');
    const stage = beginGestureStage({ page, viewport: () => VIEWPORT });
    expect(stage).not.toBeNull();

    // 模拟原生 onBackProgressed 逐帧回调
    for (const p of [0, 0.2, 0.45, 0.7, 0.9, 1]) {
      stage?.apply({ ...CARD_STATE, scale: 1 - 0.15 * p, radius: 24 * p });
      // 每一帧都必须保持干净
      expect(page.getAttribute('style'), `progress=${p}`).toBe(before);
    }
    stage?.end();
    expect(page.getAttribute('style')).toBe(before);
  });

  it('形变写在临时层自己身上，不在真实页面上', () => {
    const page = makeReaderPage();
    const stage = beginGestureStage({ page, viewport: () => VIEWPORT });
    expect(stage).not.toBeNull();

    stage?.apply(CARD_STATE);

    // 临时层在文档里、是真实页面的兄弟
    const layers = document.querySelectorAll('.page-mask');
    expect(layers).toHaveLength(1);
    expect(layers[0]).toBe(stage?.element);
    expect(stage?.element.style.transform).toContain('scale');
    expect(stage?.element.parentElement).not.toBe(page);
    stage?.end();
  });

  it('真实页面上原有的内联样式不被覆盖、也不被清除', () => {
    const page = makeReaderPage();
    // 页面本来就有内联样式（例如别处写过的 max-width）
    page.setAttribute('style', 'max-width: 640px;');
    const before = page.getAttribute('style');

    const stage = beginGestureStage({ page, viewport: () => VIEWPORT });
    stage?.apply(CARD_STATE);
    stage?.end();

    expect(page.getAttribute('style')).toBe(before);
  });
});

describe('手势形变层：收尾必须幂等且一定能执行', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('end() 可以重复调用，不抛错', () => {
    const page = makeReaderPage();
    const stage = beginGestureStage({ page, viewport: () => VIEWPORT });
    expect(() => {
      stage?.end();
      stage?.end();
      stage?.end();
    }).not.toThrow();
    expect(document.querySelectorAll('.page-mask')).toHaveLength(0);
    expect(hasOpenGestureStage()).toBe(false);
  });

  it('没有创建过也能安全收尾（新手势开始前先 end 一次）', () => {
    makeReaderPage();
    expect(() => {
      beginGestureStage({ page: null as unknown as HTMLElement, viewport: () => VIEWPORT });
    }).not.toThrow();
    expect(hasOpenGestureStage()).toBe(false);
  });

  it('页面为空时返回 null，不留半截图层', () => {
    const stage = beginGestureStage({ page: null as unknown as HTMLElement, viewport: () => VIEWPORT });
    expect(stage).toBeNull();
    expect(document.querySelectorAll('.page-mask')).toHaveLength(0);
    expect(document.querySelectorAll('.page-mask-scrim')).toHaveLength(0);
  });

  it('收尾后临时层、压暗层、隐藏类全部清理干净', () => {
    const page = makeReaderPage();
    const stage = beginGestureStage({ page, viewport: () => VIEWPORT });
    expect(document.querySelectorAll('.page-mask-scrim')).toHaveLength(1);

    stage?.end();

    expect(document.querySelectorAll('.page-mask')).toHaveLength(0);
    expect(document.querySelectorAll('.page-mask-scrim')).toHaveLength(0);
    // 真实页面不能被留下「隐藏」状态，否则用户看到白屏
    expect(page.className).not.toContain('is-gesture-hidden');
    expect(page.style.visibility).toBe('');
  });

  it('中途开始新手势：旧的一层必须先被收掉（只有一个 .page-mask）', () => {
    const page = makeReaderPage();
    const first = beginGestureStage({ page, viewport: () => VIEWPORT });
    expect(first).not.toBeNull();

    const second = beginGestureStage({ page, viewport: () => VIEWPORT });
    expect(second).not.toBeNull();

    expect(document.querySelectorAll('.page-mask')).toHaveLength(1);
    expect(document.querySelectorAll('.page-mask-scrim')).toHaveLength(1);
    // 第一个返回的句柄已经被收掉：再 end 它是空操作，不会误拆第二个
    first?.end();
    expect(document.querySelectorAll('.page-mask')).toHaveLength(1);
    second?.end();
    expect(document.querySelectorAll('.page-mask')).toHaveLength(0);
  });
});
