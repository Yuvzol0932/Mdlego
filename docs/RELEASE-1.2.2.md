# 墨读 1.2.2 发布说明

发布日期：2026-11-19 · APK：`Mdlego-1.2.2-official.apk`（debug 签名，预览用）
版本：versionName `1.2.2` / versionCode `1020299`

本版修 **1 项 P0 回归**：阅读进度记忆失效（退出书籍再返回，不会回到原位置）。
不含新功能。

## 现象

「现在这个进度记忆功能完全失效，退出书籍再返回进度的话，不会同步回观看时停留的状态。」

而且是**间歇性**的：有时正常，有时完全回到文档开头。

## 真机取证

逐轮打点后发现关键对比（`article` 是正文容器，`blocks[0]` 是它第一个块）：

```
正常轮次: article rect 高 39557，blocks[0] 高度 32、top -11487   ← 有真实布局
失效轮次: article rect 高 39557，blocks[0] 高度 0、  top 0        ← 块已 detach
```

**`article` 自身高度正常（39557），但它的块高度全是 0** —— 这是
「缓存里存的是已经脱离文档的旧节点」的确定特征。

对 detached 元素调 `getBoundingClientRect()` 一律返回 0，于是：

```
rect.bottom > baseline   // 0 > 64 → 永远不成立
→ 二分找不到「顶栏下沿那个块」
→ chosen === null
→ persistProgress() 直接 return
→ 库里的值停在上一次成功保存的时刻
```

用户看到的就是「进度记忆完全失效」。

## 根因

`main.ts` 的 `progressBlockList()` 用字符串签名当缓存 key：

```ts
const key = `${article.getAttribute('data-gen') ?? ''}|${article.childElementCount}`;
if (key === progressBlocksKey) return progressBlocks;   // ← 命中就返回旧数组
```

看起来很稳，实际会**跨会话撞键**：

- `generation` 是**每个 PageView 各自的局部变量**，每次重新进入阅读页
  都会 `createPage` 出新 view，`generation` 从 0 重新计数 → `data-gen` **恒为 `"1"`**；
- 同一篇文档、字体设置不变时 `childElementCount` 也相同。

两者一撞，第二次进入就命中上一次会话的缓存，返回那批**已经 detach 的节点**。

这也解释了为什么是「间歇」的：缓存是被**模块级变量**持有的，
是否命中取决于两次进入之间块数有没有变化、节点有没有被重建。

## 修法

**① 缓存键改用「元素身份 + 块数 + 连通性」**（`main.ts`）：

```ts
function progressBlockList(article: HTMLElement): HTMLElement[] {
  if (
    article === progressBlocksArticle
    && article.childElementCount === progressBlocksCount
    && progressBlocks.every((el) => el.isConnected)   // ← 连通性兜底
  ) {
    return progressBlocks;
  }
  progressBlocks = Array.from(article.querySelectorAll<HTMLElement>('[data-bid]'));
  progressBlocksArticle = article;
  progressBlocksCount = article.childElementCount;
  return progressBlocks;
}
```

同一个 article 节点且块数未变才复用；换了节点必然重建。**不可能撞键。**

**② 顺带修掉一个同源隐患**（`reader.ts`）：首帧锚定标记 `page.dataset.anchored`
也从不清理。阅读页根节点由宿主缓存复用，第二次进入时 `main.ts` 的
`anchorFirstFrame()` 看到上次留下的 `'1'` 就提前返回 ——
**一步定位都没做，却返回「已恢复」**。改为 `mountInitialWindow()` 每次挂载
开始时清除，锚定成功后再设上，让标记生命周期只覆盖一次挂载。

## 验收

新增 `tools/verify-progress-memory.mjs`（真机，**7/7**）。
连续 4 轮「滚到不同位置 → 退出 → 重新打开」，全部回到原位：

| 轮次 | 滚动到 | 退出前锚点 | 重开后 | 漂移 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | 25% | `li-…-0@-29px` | `-29px` | **0px** |
| 2 | 50% | `p-…-58@-109px` | `-108px` | **1px** |
| 3 | 70% | `p-…-82@-14px` | `-13px` | **1px** |
| 4 | 40% | `li-…-0@-10px` | `-22px` | **12px** |

> 为什么必须多轮：这个 bug 是「缓存跨会话残留」，只测一轮可能恰好命中
> 正常分支。连续进入/退出会反复复用同一个阅读页节点，正好把残留暴露出来。

回归：`#A` 手势完整性 **17/17**、`#D` 冷启动长按 **12/12** 均无回退；
`npm run verify` **766 测试 / 54 文件**、四道架构门禁全绿。

## 排查过程中的两个坑（已写进脚本注释）

1. **断言读值时机错了**：最初把「落库值」放在「重新打开之后」读，
   那时 `openDoc` 已经又更新了一轮，导致 `savedMatch` 永远不匹配 ——
   把「已经修好」误报成失败。必须**退出后、重新打开前**读。
2. **断言本身过严**：`persistProgress` 存的是「顶栏下沿那个块」+ 块内比例，
   与测试记录的「第一个 `bottom>0` 的块」本来就可能差一个块
   （顶栏 64px 内可能压着上一块的尾部）。判据应改为「位置能否还原」，
   而不是「bid 是否逐字相等」。

## 与 1.2.1 的兼容性

- 数据格式未变（IndexedDB schema 未改），可直接覆盖安装。
- 无行为变化；本版只让「进度保存」重新可靠工作。
