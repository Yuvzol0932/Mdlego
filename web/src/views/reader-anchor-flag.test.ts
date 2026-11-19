// @vitest-environment jsdom
/**
 * 阅读进度恢复的幂等性（1.2.2 回归）。
 *
 * ## 真机现象
 *
 * 「退出书籍再返回，进度不会同步回观看时停留的状态。」
 * 而且**间歇性**：有时正常，有时停在文档开头。
 *
 * ## 根因
 *
 * `reader.ts` 在首帧锚定成功后给阅读页根节点打了一个标记
 * `page.dataset['anchored'] = '1'`，用来告诉 `main.ts` 的
 * `anchorFirstFrame()`「首屏已经在同一同步栈内定位过了，别再写一次
 * scrollTop」（重复写会叠加出约 300px 偏差 —— 见 1.2.0 的修复记录）。
 *
 * 但这个标记**从来没有被清除**。而阅读页根节点是宿主按页面 key 缓存、
 * 反复复用的 —— 同一个 DOM 节点会在多次「进入 → 退出 → 再进入」之间活着。
 *
 * 于是第二次进入时，`main.ts` 看到上次留下的 `anchored === '1'`，就
 * 走提前返回分支：**一步定位都没做，却返回「已恢复」**。
 * 用户于是停在文档开头（或上次的滚动位置），看起来就是「进度记忆失效」。
 *
 * 为什么表现为「间歇」：是否命中取决于这次进入时该节点上是否还留着旧标记 ——
 * 节点被重建（换文档、渲染结果变化）就正常，被复用就失效。
 *
 * ## 修法
 *
 * 标记必须表达「**这一次**首屏挂载已经定位过了」，所以它的生命周期必须与
 * 「一次挂载」绑定：`mountInitialWindow()` 一开始就清掉，锚定成功后再设上。
 * 这样任何一次新的首屏挂载都会重新定位一次，不多不少。
 *
 * 本文件用一个最小复现守这个契约：模拟「同一节点被复用两次」，
 * 断言第二次挂载会把标记重置。
 */

import { beforeEach, describe, expect, it } from 'vitest';

/**
 * 与 `reader.ts::mountInitialWindow` 的标记语义一致的最小实现。
 *
 * 这里不引入整个 reader（它依赖大量视图工具），只把**标记的生命周期**
 * 抽出来验证 —— 契约只有一条：每次挂载开始时清、锚定成功后才设。
 */
function mountOnce(page: HTMLElement, anchor: { bid: string } | null, doAnchor: () => boolean): boolean {
  // 挂载开始：清掉上一次留下的标记（这是修复的核心）
  delete page.dataset['anchored'];
  if (anchor === null) return false;
  const ok = doAnchor();
  if (ok) page.dataset['anchored'] = '1';
  return ok;
}

/** 与 `main.ts::anchorFirstFrame` 的提前返回逻辑一致。 */
function needsExternalAnchor(page: HTMLElement): boolean {
  return page.dataset['anchored'] !== '1';
}

describe('anchored 标记：生命周期必须与单次挂载绑定', () => {
  let page: HTMLElement;

  beforeEach(() => {
    document.body.replaceChildren();
    page = document.createElement('div');
    page.className = 'shell reader-page';
    document.body.append(page);
  });

  it('第一次挂载并锚定后，标记存在', () => {
    mountOnce(page, { bid: 'b1' }, () => true);
    expect(page.dataset['anchored']).toBe('1');
  });

  it('**第二次挂载必须重新锚定**（这是失效的直接原因）', () => {
    // 第一次：正常挂载 + 锚定
    mountOnce(page, { bid: 'b1' }, () => true);
    expect(needsExternalAnchor(page)).toBe(false);

    // 第二次：同一个节点被宿主复用，再次进入阅读页
    let anchoredThisTime = false;
    mountOnce(page, { bid: 'b2' }, () => {
      anchoredThisTime = true;
      return true;
    });

    // 关键断言：这一次真的执行了锚定（而不是被上次的标记骗过去）
    expect(anchoredThisTime).toBe(true);
    expect(page.dataset['anchored']).toBe('1');
  });

  it('锚定失败时不留下标记（否则下次会被误认为已定位）', () => {
    mountOnce(page, { bid: 'b1' }, () => false);
    expect(page.dataset['anchored']).toBeUndefined();
    expect(needsExternalAnchor(page)).toBe(true);
  });

  it('没有锚点（第一次读这本书）时不留标记', () => {
    mountOnce(page, null, () => true);
    expect(page.dataset['anchored']).toBeUndefined();
  });

  it('连续多次挂载：每一次都会重新锚定', () => {
    const anchorCalls: string[] = [];
    for (const bid of ['b1', 'b2', 'b3']) {
      mountOnce(page, { bid }, () => {
        anchorCalls.push(bid);
        return true;
      });
    }
    expect(anchorCalls).toEqual(['b1', 'b2', 'b3']);
  });
});
