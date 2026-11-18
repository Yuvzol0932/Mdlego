# 1.2.0 改动总览（给第一次看这份 diff 的人）

> 一句话：**书架 ⇄ 阅读页的转场被整个重做了**，从「`clip-path` 裁切」换成
> 「FLIP 双层形变 + 视口快照 + 景深联动 + Android 14 预测式返回」，
> 顺带修掉「重新打开书籍偏出几行」的锚点漂移。
>
> 本文是导航图：**先看这张表，再看下面按文件分组的说明**，就能知道每个改动是干什么的。
> 发布说明见 [`RELEASE-1.2.0.md`](RELEASE-1.2.0.md)，动效细节见 [`MOTION.md`](MOTION.md)。

- 基线：`v1.0.1`（commit `d522859`）
- 本版：`v1.2.0`（commit `09d48ad`）
- 规模：**33 个文本文件 `+5454 / −338`**，另加 **13 个** 证据截图（二进制）
- 零新增第三方运行时依赖

---

## 一、先看这张表：改动的 6 个层次

| 层 | 你会在 diff 里看到什么 | 为什么改 |
| :--- | :--- | :--- |
| **纯逻辑（core）** | 3 个**全新**文件 `window.ts` / `morph.ts` / `back-gesture.ts`，都无 DOM 依赖 | 把「该挂哪一段」「怎么变形」「该退哪一层」变成可单测的纯函数 |
| **视图（views）** | `page-mask.ts` 几乎重写、`reader.ts` 大改、2 个新文件 `snapshot.ts` / `back-gesture.ts` | 转场宿主从「裁切一个框」换成「缩放一个壳」；首屏从「从头挂」换成「围绕锚点挂」 |
| **编排（main.ts）** | +331/−23，新增跟手缩窗控制器与坐标系换算 | 把原生手势帧、store 状态、转场宿主编在一起 |
| **渲染契约（core/types + markdown）** | `RenderResult` 多出 3 个字段；解析阶段多打一个 `data-lede` | 视图需要「随机访问任意分片」和「知道每片覆盖哪些块」 |
| **原生（Android）** | `MdlegoNative.java` +250、Manifest +1 行 | 接入 `OnBackAnimationCallback`，按路由栈深度动态注册/注销 |
| **验收（tools + tests）** | 5 个新脚本、5 个新测试文件（+95 条测试） | 把主观的「丝滑」变成可断言的红线 |

---

## 二、新增文件（8 个，全部是「新增」，不存在兼容风险）

### 1. `web/src/core/window.ts`（183 行）+ `window.test.ts`（217 行，22 条）

**首屏该挂哪一段**的计算。原来阅读页首屏固定挂「文档开头第一片」，打开一本读到
60% 的书要先露第一屏再瞬移。现在以阅读进度锚点 `bid` 为中心取一个 64 块窗口。

| 导出 | 作用 |
| :--- | :--- |
| `computeBlockWindow(blockCount, anchor, blockIds, size)` | 算出窗口 `[startIdx, endIdx)`，向上留 12 块缓冲；靠文末时向前修正保证窗口满长 |
| `chunksForBlockWindow(ranges, window)` | 块窗口 → 需要同步挂载的**分片**区间（DOM 插入最小粒度是分片，不是块） |
| `headBatch` / `tailBatch` | 上下补齐各取哪一批 |
| `compensatedScrollTop` / `scrollCompensation` | 向上前插时的零跳动补偿（数学保证，单测覆盖「连续前插两批后视口内容位置不变」） |

> **注意**：实际实现里前插补偿**没有**用这两个函数的 `scrollHeight` 差值法，
> 而是用「参考元素视口位移」（见第三节 `reader.ts`）。这两个函数保留是因为
> 它们是「补偿量应该是多少」的纯数学表述，被单测当契约守着。

### 2. `web/src/core/morph.ts`（254 行）+ `morph.test.ts`（275 行，30 条）

**FLIP 几何**。整块转场的数学都在这里，`page-mask.ts` 只负责把结果写进 style。

```ts
fitToCard(card, viewport)      // 卡片矩形 → { scale, tx, ty, radius }
stateForCard(card, viewport)   // 同上，返回可直接喂给 transformOf 的状态
transformOf(state)             // MorphState → "translate3d(...) scale(...)"
followState(progress, edge, touchY, startY, viewport)  // 跟手矩阵
behindScale(progress, opening) // 底层书架景深 1 ↔ 0.95
scrimOpacity(progress, opening)// 压暗层
openFade / closeFade           // 封面层与阅读层的交叉溶解曲线
MORPH / MORPH_EASING           // 400ms / 440ms / 200ms + cubic-bezier(0.22,1,0.36,1)
```

**最容易被忽略但最关键的一行**：`cardRadius = cardRadius / scale`。
书封有 18px 圆角，形变壳被缩到 0.26 时如果直接写 `border-radius: 18px`，
用户看到的圆角只有 4.7px，收尾会「圆角突然变圆」。反向补偿后可见圆角恒为 18px。

### 3. `web/src/core/back-gesture.ts`（120 行）+ `back-gesture.test.ts`（134 行，20 条）

**预测式返回该退哪一层**。纯决策，无 DOM。

```ts
decideBackAction(stack)      // → 'close-layer' | 'close-reader' | 'pop-page' | 'system'
shouldInterceptBack(stack)   // 原生侧要不要注册回调
canFollowMorph(stack)        // 能不能整页缩窗（有浮层时只能关浮层）
normalizePhase / normalizeProgress  // 对外部输入极其宽容，非法值一律忽略
```

**硬约束**：书架根页面且无浮层时 `shouldInterceptBack` 必须返回 `false`。
如果这时还挂着应用级回调，系统会认为「应用要自己消费返回」，
**废掉小米澎湃 OS 退回桌面时的图标收拢动画**。

### 4. `web/src/views/snapshot.ts`（110 行）

**退书时的视口轻量快照**。原来关闭转场 `cloneNode(true)` 克隆整篇文档
（900KB 文档 3751 块 / 三万多节点），光栅化规模与文章长度成正比 → 6fps。
现在只克隆**与视口相交的十来个块**，块位置按原视口偏移逐块写入。

```ts
snapshotViewport(article, vh, buffer = 120)  // 只取屏内块
buildSnapshotLayer(snapshot, className)       // 拼成一层轻量 DOM
canSnapshot(snapshot)                         // 拿不到块时退回整页克隆
```

克隆体剥掉 `id` / `data-bid`，避免与原文形成重复锚点。

### 5. `web/src/views/back-gesture.ts`（164 行）

**手势帧 → 形变矩阵**。挂 `window.__mdlegoBackGesture`，原生层每帧通过
`bridge.eval` 调用（不走 Capacitor 事件，避免每帧序列化 JSONObject 造成 GC 抖动）。

职责边界：`core/back-gesture.ts` 决定「退哪层」→ 本文件负责「手指到矩阵」→
`page-mask.ts` 负责「矩阵到动画」。

### 6. `web/src/views/page-mask.test.ts`（161 行，11 条）

**卡片隐身 `.is-morph-slot-hidden` 的生命周期**。转场期间书架上那张卡必须临时隐身，
否则屏幕上有两个相同封面。这个类名一旦漏摘，书架会**永久**少一个封面。

> 这个测试写出来当场就抓到了一个真 bug：`settlePageTransition()` 原来只依赖
> 各转场的 `finish()` 回调清账，异常路径会漏。已改成 `finally` 无条件清理。

### 7-8. 验收脚本 `tools/verify-close-transition.mjs` / `verify-flip-morph.mjs` / `verify-predictive-back.mjs`

分别覆盖 Step 2（8 项）/ Step 3（21 项）/ Step 4（23 项实跑，真机）。见第五节。

---

## 三、重写的文件（改动最大，值得重点看）

### `web/src/views/page-mask.ts` —— +609 / −96（几乎重写）

这是整块转场的宿主。**看懂这一个文件就懂了一半**。

**图层结构变了**：

```
旧：.page-mask 一层，用 clip-path 裁角
新：.page-mask-scrim      压暗层（只动 opacity）
    .page-mask            几何形变壳（只动 transform + border-radius）
      .page-mask__reader    阅读视口层 ← 唯一滚动容器
      .page-mask__cover     书籍封面克隆层（交叉溶解）
```

**为什么必须拆开**：滚动容器一旦被 `transform: scale()` 缩放，
内部 `scrollTop` 的语义会被乘上 scale，锚点定位全部错位。
所以壳只做几何，滚动永远发生在内层。

**新增的 4 个公开函数**：

| 函数 | 作用 |
| :--- | :--- |
| `prepareGestureStage(src)` | 跟手前的「空转」形变层：摆好宿主、拍快照，但**不播动画** |
| `markMorphSlotHidden(el)` | 测试/诊断入口，把卡片设为隐身 |
| `settleAnimation(anim, ms, done)` | **超时兜底**，见下方「三个隐蔽 bug」 |
| `clearMorphSlot` / `hasHiddenMorphSlot` | 槽位账本（原来就有，语义收紧） |

**关闭方向改成「严格单帧原子准备」**——这是 Step 2 的核心：

```
1. 从还在屏上的阅读页提取视口快照
2. 立刻把转场层压在最上层（视觉零跳变）
3. 再把底层切成书架（在转场层之下，用户看不见）
4. 同一帧内强制一次布局，量出目标卡片矩形
```

四步全在同一个同步调用栈里，中间没有 `await` / `rAF`。
旧实现「先切底层，再连等 3 帧量卡片」，中间约 166ms 书架裸露 —— 就是「退书闪一下」的根因。

### `web/src/views/reader.ts` —— +420 / −52

**首屏挂载逻辑换了，并新增双游标分片管理**。

| 新函数 | 作用 |
| :--- | :--- |
| `mountInitialWindow(render, anchor)` | 按锚点窗口同步挂首屏（替代原来固定挂首片） |
| `anchorToBlock(bid, ratio)` | 首帧同步定位到锚点，含**坐标系换算**（见下） |
| `appendTailBatch` / `prependHeadBatch` | 双游标补齐：向下追加、向上前插 |
| `armRemainder` / `releaseRemainder` / `scheduleRemainder` | 转场结束后的空闲分批补齐 |
| `scrollContainer()` | 转场期间返回内层 `.page-mask__reader`（不是外层 `.page-mask`） |

**前插补偿用的是「参考元素视口位移法」，不是 `scrollHeight` 差值法**：

```ts
scrollTop += (参考块插入后的 rect.top − 插入前的 rect.top)
```

`scrollHeight` 差值法在 `position: fixed` 容器里会读到不含内容的布局高度，
累积起来就是「重开时正文越滑越偏」（实测偏出 4700px）。

**`anchorToBlock` 里有一段坐标系换算，别删**：

转场期间形变壳带 `transform: translate() scale()`，`getBoundingClientRect()`
返回**视觉**坐标而 `scrollTop` 是**布局**坐标。所以用相对容器顶边的差值：

```ts
top = 当前滚动量 + (块视觉 top − 容器视觉 top) / scale − 顶栏高 + ratio × 块高
```

`translate` 在同一个变换空间里两边都有，做差自动抵消。改之前：
锚点每趟都「接近一点但永远收敛不到位」；改之后：**一趟收敛（residual 0）**。

### `web/src/main.ts` —— +331 / −23

**新增三块**：

1. **跟手缩窗控制器**：`prepareCloseForGesture` / `applyGestureMorph` /
   `reboundFromGesture` / `shelfBehindStage`。`commit` 时把松手瞬间的实时矩阵
   作为关闭动画的**起始关键帧**——严禁先弹回全屏再重播。
2. **`visualScale(el)`**：视觉→布局缩放比换算，供 `scrollToBid` / `anchorFirstFrame` 用。
   用 `offsetHeight`（不受 transform 影响）比读计算样式稳。
3. **`syncBackIntercept()`**：每次导航状态变化同步原生开关，幂等（原生侧去重）。

**改了一处易错细节**：`appbarBottom()` 从 `getBoundingClientRect().bottom`
改成 `offsetHeight`。因为顶栏滚动态会给自己 `translateY(-100%)`，
`rect` 于是返回负值 —— 保存进度时顶栏收起、恢复时顶栏显示，
同一个 `bid` 会差一整条顶栏（实测 64px，正好是顶栏高度）。

### `web/src/core/markdown.ts` —— +113 / −15

`RenderResult` 多了三个字段（视图需要随机访问分片）：

```ts
htmlChunkAt(index): string | null   // 随机取任一片（懒渲染时按需渲染）
blockIds: string[]                  // 块顺序，用于把 bid 定位到索引
chunkBlockRanges: ChunkBlockRange[] // 每片覆盖哪些块
```

**并且新增了一个内容级标记 `data-lede`**，替掉 CSS 的 `:first-of-type`
（配合 `styles/app.css` 的一行改动）。原因见下方「三个隐蔽 bug」第 1 条。

### `android/.../MdlegoNative.java` —— +250

`setBackIntercept({enabled})` + 分版本回调：

| SDK | 实现 |
| :--- | :--- |
| ≥ 34 | `OnBackAnimationCallback`：`onBackStarted` / `onBackProgressed` / `onBackInvoked` / `onBackCancelled` 逐帧 `bridge.eval("window.__mdlegoBackGesture(...)")` |
| == 33 | `OnBackInvokedCallback` 降级，`onBackInvoked` 直接发 `("commit", 1f, 0, 0, 0)` |
| < 33 | 保持原有 Capacitor `backButton` + 应用内 `edge-back.ts` |

`backCallback` 故意存成 `Object` 而不是 `OnBackInvokedCallback` —— 低于 34 的设备上
加载这个类时不会因缺类而 `NoClassDefFoundError`。`handleOnDestroy` 里注销。

### `android/app/src/main/AndroidManifest.xml` —— +1 行

`android:enableOnBackInvokedCallback="true"`。

---

## 四、三个隐蔽 bug（每一处都值得单独看 diff）

这三个都不是「按计划书写就能避免」的，是被验收脚本和真机逼出来的。

### 1. `.article > p:first-of-type` 是**位置**选择器 → 重开偏出 300px

```css
/* 改前 */ .article > p:first-of-type { text-indent: 2em; }
/* 改后 */ .article > p[data-lede='true'] { text-indent: 2em; }
```

分片窗口会**在文档前段前插分片**，「DOM 里的第一个 p」随之滑动：

- ① 缩进跑到中段段落上（视觉错乱）；
- ② 原首段丢掉一行（**−34px**），而前插补偿按「参考元素视口位移」计算，
  算不到这个高度变化 → 每批多滚 34px，**八批累积 ≈300px**。

修法：解析阶段打内容级标记，CSS 只认属性不认位置。

### 2. WAAPI 的 `finished` 在时间线冻结时**永不 resolve**

```ts
// 新增的兜底（page-mask.ts）
function settleAnimation(anim, durationMs, done) {
  let settled = false;
  const finish = () => { if (settled) return; settled = true; clearTimeout(timer); done(); };
  const timer = setTimeout(finish, durationMs + 120);
  anim.finished.then(finish, finish);
}
```

Android WebView 在 `document.hidden`（息屏 / 切后台 / 锁屏）期间会冻结动画时间线。
`finished` 永远 pending，而所有收尾逻辑（拆层、恢复卡片隐身、提交导航）都挂在
`.then` 上 → **一次转场就能把应用卡死**，用户看到的是「点了返回没反应」。
实测息屏下 500ms 后 `playState` 仍是 `running`。

### 3. `settlePageTransition()` 缺异常兜底 → 书架永久少一个封面

```ts
// 改前：running?.finish();   ← 只靠各转场自己清账
// 改后：
try { running?.finish(); } finally { clearMorphSlot(); }
```

这是写 `page-mask.test.ts` 时当场发现的。

---

## 五、怎么验证（跑什么、看什么）

```bash
npm run verify                  # 四道架构门禁 + tsc + 735 测试 + build
npm run verify:transition       # Step 1/2/3 三套浏览器验收
npm run verify:predictive-back  # Step 4 真机（Android 13+）
npm run android:build           # build + push-web + assembleDebug + 产物断言 + CSS 审计
npm run android:verify          # 独立反读 APK 校验
```

| 脚本 | 断言数 | 看的是什么 |
| :--- | :--- | :--- |
| `tools/repro-lazy-firstscreen.mjs` | 8 | 首帧 ≤50ms、无 >50ms 长任务、动画期间挂载 ≤40 块、重开锚点 ±80px |
| `tools/verify-close-transition.mjs` | 8 | 书架裸露帧数 = 0、快照块数 ≤40、转场层全部清理 |
| `tools/verify-flip-morph.mjs` | 21 | 缩放/位移/圆角逐项对账、两层交叉溶解、景深、槽位隐身 |
| `tools/verify-predictive-back.mjs` | 23¹ | 真机阻尼曲线逐点、cancel 回弹、commit 不弹回、原生开关时机 |

¹ 共定义 24 条，其中「有子浮层时只关浮层」是条件断言——目录抽屉按钮可用时才跑，
本次实跑 23 条（该条件未触发），结果 **23/23**。

**一键跑完的实测结果**（本机 + 小米 11 Ultra / Android 14 / HyperOS OS2.0）：

```
首帧 42ms ｜ 长任务 [] ｜ 动画期间 25 块（全量 3751）｜ 重开锚点 -3px
书架裸露 0/28 帧 ｜ 快照 10 块 ｜ 起始缩放 0.2655（精确）｜ 可见圆角 18.0px
景深 1.000↔0.950 ｜ 阻尼 0.958→0.913→0.880→0.859→0.850（与公式逐点吻合）
```

---

## 六、兼容性与风险

**不破坏现有功能**：离线查词、高亮批注、目录跳转、全文搜索、原文编辑、TTS
全部走原路径，`views/reader.ts` 里那部分只是在外围加了分片管理，交互逻辑未改。
735 条测试（含原有 640 条）全绿即为证据。

**数据格式未变**：IndexedDB schema 没动，可直接覆盖安装。

**唯一的行为变化**：首段缩进从「DOM 第一个 p」改成「文档真正的第一个段落」。
副作用是**更好的**——向上滚动也不会再出现「中段段落莫名缩进」。

**已知限制**（详见 `RELEASE-1.2.0.md`）：

1. 帧间隔只在 headless Chrome 量过；真机验证的是**行为**不是逐帧耗时，
   低端机真实帧率仍需补测。
2. 预测式返回需要 Android 13+ 真机，且**必须亮屏 + 应用在前台**，
   否则 `document.hidden` 冻结时间线，只能验证超时兜底。
3. Android 10–12 无预测式返回，退化为应用内左缘右滑。

---

## 七、文件清单速查

### 新增（8 + 3 工具）

```
web/src/core/window.ts          183  首屏块窗口计算（纯函数）
web/src/core/window.test.ts     217  22 条
web/src/core/morph.ts           254  FLIP 几何（纯函数）
web/src/core/morph.test.ts      275  30 条
web/src/core/back-gesture.ts    120  退栈决策（纯函数）
web/src/core/back-gesture.test.ts 134  20 条
web/src/views/snapshot.ts       110  退书视口快照
web/src/views/back-gesture.ts   164  手势帧 → 形变矩阵
web/src/views/page-mask.test.ts 161  11 条（槽位隐身必恢复）
tools/verify-close-transition.mjs  270
tools/verify-flip-morph.mjs        364
tools/verify-predictive-back.mjs   463
tools/device-cdp.mjs               136  真机 WebView CDP 驱动（预测式返回验收用）
tools/ui-capture.mjs               197  真机 UI 截图工具
```

### 修改（按改动量）

```
web/src/views/page-mask.ts        +609 −96   转场宿主（几乎重写）
web/src/views/reader.ts           +420 −52   首屏窗口 + 双游标分片
web/src/main.ts                   +331 −23   跟手控制器 + 坐标换算 + 拦截同步
android/.../MdlegoNative.java     +250       预测式返回原生侧
web/src/core/markdown.ts          +113 −15   RenderResult 三字段 + data-lede
web/src/styles/motion.css          +84        scrim / reader / cover 图层
web/src/core/markdown-chunks.test.ts +210 −96  分片契约 + data-lede 解耦
web/src/core/types.ts              +20       RenderResult 类型扩展
web/src/data/native.ts             +34       setBackIntercept 桥接
web/src/state/store.test.ts        +11 −1    测试夹具补新字段
web/src/core/render-worker.ts       +9       透传新字段
web/src/core/render-async.ts        +5       透传新字段
web/src/styles/app.css              +7 −2    首段缩进改属性选择器
android/.../AndroidManifest.xml     +1       enableOnBackInvokedCallback
package.json                        +3 −1    verify:predictive-back 脚本
docs/MOTION.md                    +144 −43   §4 重写为 FLIP 架构
README.md                           +7 −5    版本横幅
docs/RELEASE-1.2.0.md              +95       发布说明
docs/CHANGES-1.2.0.md              （本文）   改动导航图
tools/repro-lazy-firstscreen.mjs   +53 −4    断言改为「锚点块贴近视口顶部」
```

（另有 4 张新增证据截图在 `docs/screenshots/transition-rc3/{close-v2,flip,lazy/verify,predictive-back}/`）
