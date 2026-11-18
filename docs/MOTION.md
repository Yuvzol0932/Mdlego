# 动效说明（阶段 D）

> 任务书 §4 的实现记录。设计决策见 `docs/DECISION-phase-D.md`；本文是**逐项动效的说明书 + 验收证据**。
> 原则：只动画 `transform` / `opacity`；时长与缓动只出现在令牌与 `core/motion.ts`；组件不自己写。

## 1. 强度与令牌

`core/motion.ts` 是唯一判定处：`effectiveMotion(设置, 系统 reduce)`，系统 `prefers-reduced-motion: reduce` 一律折算为 `off`（无论设置选了什么）。

| 令牌 | full | simple | off / 系统 reduce |
| :--- | :--- | :--- | :--- |
| `--motion-transform-dur` | 220ms | 0ms | 0ms |
| `--motion-fade-dur` | 220ms | 220ms | 0ms |
| `--motion-page-dur` | 420ms | 220ms | 0ms |
| `--motion-sheet-dur` | 360ms | 220ms | 0ms |
| `--motion-stagger` | 40ms | 0ms | 0ms |
| `--motion-highlight-dur` | 1200ms | 1200ms | 0ms |
| `--anim-*`（keyframes 名） | 各自几何动画 | `motion-fade-in` | `none` |

- 缓动：`--ease-standard` / `-decel` / `-accel` / `--ease-spring`（`linear()` 近似，`@supports` 回退 standard）。
- `simple` = 只保留淡入淡出：几何时长归零、几何 keyframes 换纯淡入。
- `off` 还有一道总闸（`motion.css`）：`*` 的 `animation/transition` duration 压到 0.01ms，兜住漏改组件。
- 数值一致性由 `motion.test.ts` 用 `tokens.css?raw` 交叉校验（改了一处忘另一处会红）。

## 2. 任务书 §4.2 逐项对照

| # | 位置 | 动效 | 时长 / 缓动 | 实现位置 | 退化 | 状态 |
| :-- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 书架 → 阅读器 | FLIP：形变壳从**被点封面的矩形**（`scale=卡片宽/视口宽`、圆角反向补偿）放大到全屏；封面层淡出、阅读层淡入交叉溶解；底层书架 1→0.95 沉下 | 400ms / `cubic-bezier(0.22,1,0.36,1)` | `views/page-mask.ts::runOpenMask` + `core/morph.ts` + `styles/motion.css` | simple：新页淡入；off：瞬时；找不到矩形：屏幕中心 70% 起步 | ✅（rc.3 重做，见 §4） |
| 2 | 阅读器 → 书架 | 反向 FLIP：阅读页缩回**关闭时重新测量**的卡片矩形；阅读层快速淡出 + 封面层升起交叉溶解；底层书架 0.95→1 浮起 | 440ms / 同上 | `views/page-mask.ts::runCloseMask` | simple：淡出；off：瞬时；找不到目标：中心 scale 0.94 + 淡出 | ✅ |
| 3 | 书架卡片进入 | 错峰淡入上移（间隔 40ms，最多 12 张） | sheet 360ms / decel，延迟 = `--stagger-i × --motion-stagger` | `views/shelf.ts` + `styles/shelf.css::card-in` | simple：纯淡入；off：直接出现 | ✅ |
| 4 | 底部导航切换 | 选中图标上浮 + 缩放 1.12；指示点滑动 | 220ms / spring；指示点位置由 `@property --tab-index` 过渡 | `views/tabbar.ts` + `styles/tabbar.css` + `styles/motion.css` | simple/off：图标直接到位、指示点瞬移（旧 WebView 同理） | ✅ |
| 5 | 目录抽屉 | 左侧滑入 + 遮罩渐变 | sheet 360ms / decel；遮罩 fade 220ms | `views/overlays.ts` + `styles/library.css::drawer-in` | simple：淡入；off：直接出现 | ✅ |
| 6 | Bottom sheet | 底部滑入；下拉关闭，松手按速度吸附 | 滑入 sheet 360ms / decel；拖动跟手；关闭/回弹 sheetDuration / accel / spring | `views/sheet-drag.ts` + `typeset.ts`/`menu.ts`/`layers.ts` | simple/off：不挂手势，仍可点遮罩/关闭按钮 | ✅ |
| 7 | 选词工具栏 | 缩放 0.94→1 + 上浮 6px + 淡入，出现在选区上方 | transform 220ms / decel（`--anim-toolbar-in`） | `styles/marks.css`（`.sel-toolbar`）+ `motion.css::sel-toolbar-in` + `core/motion` 令牌 | simple：纯淡入；off：不动 | ✅（阶段 E2 落地） |
| 8 | 任务勾选 | 勾线绘制（stroke-dashoffset）+ 文字划线从左到右 | transform 220ms / standard | `core/markdown.ts`（`.task-text`）+ `styles/typography.css` | off：直接显示勾线与划线 | ✅（多行任务只画一条穿过首行的线，见 §5） |
| 9 | 目录 / 搜索跳转 | 目标块高亮底色后 1.2s 渐隐 | highlight 1200ms / --ease-out | `main.ts::scrollToBid` + `styles/library.css::flashBg` | off：不闪（时长为 0，直接到终态） | ✅ |
| 10 | 主题切换 | 从切换按钮位置圆形扩散；降级交叉淡入 | sheet 360ms / standard（clip-path） | `views/motion.ts::runThemeReveal` + `styles/motion.css` | 无 VT：短淡入（`theme-crossfade`）；off：直接换色 | ✅ |
| 11 | 顶栏 | 随滚动方向 translateY 收放 | base 220ms / standard | `views/reader.ts` + `styles/reader-shell.css` | off：瞬移 | ✅（阶段 C3 已有，D 改为语义令牌） |
| 12 | 统计柱状图 | 自下而上生长，错峰 | sheet 360ms / decel，延迟 = `--stagger-i × --motion-stagger` | `views/stats.ts` + `styles/stats.css::stats-bar-grow` | simple：纯淡入（transform 还原）；off：直接出现 | ✅ |
| 13 | 按钮 | 按下 scale(.96)，松开回弹 | fast 120ms / spring | `styles/components.css::.ui-press` | simple/off：瞬变（无过渡） | ✅ |

## 3. 手势

| 手势 | 触发 | 判定 | 提交 | 实现 | 限制 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Bottom sheet 下拉关闭 | 面板把手 `pointerdown`，拖动跟手 | `dy > 96px` 或 `vy > 0.55px/ms` | 滑出 110% 后关闭浮层 | `views/sheet-drag.ts`，接入 Aa 面板与 menu 的 sheet 变体 | 仅「完整」档；内容区滚动不拦截 |
| 左缘右滑返回 | 左缘 24px 内起手 | 横向位移 > 纵向 1.5 倍才接管；`dx > 96px` 或 `vx > 0.5px/ms` | 手势**不自己播滑出**：把当前跟随位移交给关闭遮罩动画（`startOffsetX`），从当前拖动位置接着缩回卡片 | `views/edge-back.ts` + `views/page-mask.ts` + `main.ts` | 仅「完整」档；起点在 `.hero__track / pre / .table-wrap` 内不启动；Android 手势导航可能在系统层拦截（见 §5） |
| 预测式返回（Android 14+） | 系统侧滑手势，原生 `OnBackAnimationCallback` 逐帧回调 | 退栈优先级：顶层浮层 → 阅读页 → 交还系统；书架根页面必须**注销回调** | `commit` 以松手瞬间的实时矩阵作为关闭动画起始关键帧（严禁先弹回全屏）；`cancel` 200ms 回弹 | `core/back-gesture.ts`（纯决策）+ `views/back-gesture.ts`（手势→矩阵）+ `MdlegoNative.java` | 仅在「完整」档且原生桥接可用时启用，此时自动禁用 `edge-back.ts` 防双触发；原生侧按 API 34/33/33- 分版本注册 |

## 4. 页面转场：FLIP 双层形变（rc.3 重做）

**书架 ⇄ 阅读页不再使用 View Transitions，也不再使用 `clip-path` 裁切**
（View Transitions 只剩主题切换的圆形扩散）。rc.3 的 `clip-path` 方案虽然消除了
闪屏，但它只能「裁」，不能「缩放」—— 裁切边角会把原文大字硬切掉，复刻不出系统级
「窗口缩成悬浮卡片」的观感。当前方案改用 **FLIP 几何形变 + 双层交叉溶解 + 景深联动**。

### 4.1 图层结构

```
.page-mask-scrim      背景压暗层（fixed 全屏，只动 opacity）
.page-mask            几何形变壳（transform-origin: 0 0，只动 transform + border-radius）
  .page-mask__reader    阅读视口层（100vw × 100vh，**唯一滚动容器**，承载正文/快照）
  .page-mask__cover     书籍封面克隆层（交叉溶解，收尾精准落入卡槽）
底图：真实书架页（关闭方向）或冻结的旧页（打开方向的 .page-mask-behind）
```

为什么必须把「形变壳」和「滚动层」拆开：滚动容器一旦被 `transform: scale()`
缩放，内部 `scrollTop` 的语义就会被乘上 scale，锚点定位全部错位。所以壳只做几何，
滚动永远发生在内层。

### 4.2 两条路径

**打开**（400ms，`cubic-bezier(0.22, 1, 0.36, 1)`）：

1. 从**被点卡片的封面**（不是整张卡）取矩形：`scale = 卡片宽 / 视口宽`，
   位移落到卡片左上角，圆角做反向补偿 `visibleRadius = radius / scale`
   —— 这样即便形变壳被缩到 0.26，用户看到的圆角仍正好是 18px。
2. 形变壳从该矩阵动画到 `translate3d(0,0,0) scale(1)`；
   同时封面层 opacity 1 → 0、阅读层 0.15 → 1（交叉溶解，消灭「白底黑字硬切」）。
3. 底层书架 `scale(1) → scale(0.95)` 沉下去，压暗层 0 → 1。

**关闭**（440ms）：

1. 阅读页整体从全屏缩回**关闭时重新测量**的卡片矩形（网格卡片优先，其次「继续阅读」卡）。
2. 阅读层快速淡出（前 38%）、封面层 10%→48% 升起，后半程由清晰书封精准落位。
3. 底层书架 `scale(0.95) → 1` 浮起，压暗层淡出。
4. 目标不可见/找不到 → 屏幕中心 `scale(0.94)` + 淡出兜底。

### 4.3 硬约束与踩过的坑

- **起止矩形取 `.cover` 而不是 `.book-card`**：`.book-card` 的 `border-radius` 是 0，
  18px 圆角与 3:4 比例都在内部封面上。取错会让圆角补偿算出 0（一上来就是直角）。
- **原卡槽必须隐身**：转场期间给书架上那张卡加 `.is-morph-slot-hidden`
  （`visibility: hidden` 保留占位），否则屏幕上出现两个相同封面。
  该隐身类的摘除走 `settlePageTransition()` 的 `finally` 兜底 ——
  任何异常/打断都不允许把卡片永久留在隐身态。
- **单帧原子准备（关闭方向）**：快照 → 挂转场层 → 切底层 → 量卡片，四步在**同一个
  同步调用栈**里完成，中间不 await、不等帧。旧实现先切底层再等 3 帧量卡片，
  中间约 166ms 书架裸露，就是「退书闪一下」的根因。
- **动画收尾必须有超时兜底**：Web Animations 的 `Animation.finished` 只在时间线推进时
  resolve。Android WebView 在 `document.hidden`（息屏/切后台/锁屏）期间会冻结时间线，
  `finished` 永不 resolve，收尾逻辑（拆层、恢复卡片、提交导航）全部挂死 ——
  用户回来看到的是「点了返回没反应」。所以统一用 `settleAnimation(anim, ms, done)`
  让「动画结束」与「超时」赛跑。实测息屏下 500ms 后仍是 `running`。
- **形变期间不能直接用 `getBoundingClientRect()` 算 `scrollTop`**：前者是**变换后**的
  视觉坐标，后者是**布局**坐标，混用会差 `1/scale` 倍且随动画推进自己变化。
  必须换算：`scrollTop = 当前滚动量 + (块视觉 top − 容器视觉 top) / scale − 顶栏高 + ratio × 块高`。
  这个坑曾让锚点每趟都「接近一点但永远收敛不到位」。

### 4.4 打断与降级

- 新一次转场会先把上一段直接定位到终态（`settlePageTransition`），不闪烁；
  动画期间重复点击被忽略。
- 低端机：连续 3 帧 > 32ms → 本次动画立即降级为 `opacity` 淡入。

### 4.5 首屏窗口直出（Step 1）

markdown 解析/渲染在 **Worker**（`core/render-async.ts` + `core/render-worker.ts`）里做。
首屏不再固定挂「文档开头第一片」，而由 `core/window.ts` 以目标 `bid` 为中心算出一个
64 块的窗口（`WINDOW_SIZE`，向上留 `LEAD_BLOCKS = 12` 块缓冲），映射到分片区间后
**同步挂载**。上下补齐用双游标（`headChunk` / `tailChunk`）：

- 向下：`appendTailBatch` 追加；
- 向上：`prependHeadBatch` 前插 + **参考元素视口偏移补偿**
  （`scrollTop += 参考块插入前后 rect.top 的差值`）。
  **不用 `scrollHeight` 差值法** —— 在 fixed 遮罩容器里它读到的是不含内容的布局高度，
  累积起来会让正文越滑越偏（实测偏出 4700px）。

转场结束（`mdlego:transition-end`）后才用 `requestIdleCallback` 每批约 2 片补齐。

**首段缩进不能用 `:first-of-type`**（这条最隐蔽）：分片窗口会**在文档前段前插分片**，
DOM 里的「第一个 p」随之滑动，于是
① 缩进跑到中段段落上；② 原首段丢一行（−34px），而前插补偿按「参考元素视口位移」计算，
算不到这个高度变化 → 每批多滚 34px，八批累积 ≈300px。
所以改成解析阶段打内容级标记 `data-lede`（`core/markdown.ts::markLeadingParagraph`），
CSS 只认属性不认位置。

### 4.6 实测证据

| 项 | 结果 |
| :--- | :--- |
| 首帧（遮罩出现） | **42ms**（红线 50ms） |
| 转场期间 >50ms 长任务 | **[]** |
| 动画期间挂载块数 | **25 块**（全量 3751 块） |
| 重新打开锚点 | 原 `h2-…-495@-2px` → **`anchorTop=-3px`**（判据 ±80px） |
| 退书「书架裸露」帧 | **0 / 28 帧** |
| 退书快照块数 | **10 块**（全文 3751 块） |
| 打开起始缩放 | 实测 **0.2655** / 期望 0.2655（卡片宽/视口宽） |
| 圆角反向补偿 | 补偿后可见 **18.0px** / 卡片 18.0px |
| 封面/阅读层交叉溶解 | 封面 1.00→0.00，阅读 0.15→1.00 |
| 景深联动 | 打开 1.000→0.950，关闭 0.950→1.000 |

验收脚本：

- `tools/repro-lazy-firstscreen.mjs` —— Step 1，8 项（`npm run verify:transition`）
- `tools/verify-close-transition.mjs` —— Step 2，8 项
- `tools/verify-flip-morph.mjs` —— Step 3，21 项

## 5. 已知限制

1. **帧间隔只在 headless Chrome 量过**：长任务与首帧数据来自 headless（见 §6）。
   真机上验证的是**行为**（跟手矩阵/回弹/落地/层清理，23/23），不是逐帧耗时 ——
   低端机的真实帧率仍需在目标机型上补测。
2. **Android 10+ 手势导航**：系统在屏幕边缘拦截滑动，WebView 收不到事件。
   Android 13+ 走原生预测式返回桥接（`OnBackAnimationCallback` / `OnBackInvokedCallback`）；
   更低版本退化为 `edge-back.ts` 的左缘右滑，只是应用内增强，系统返回键仍是主路径。
3. **预测式返回依赖真机**：`tools/verify-predictive-back.mjs` 需要一台 Android 13+ 设备
   且 `adb` 可用；WebView 的 DevTools socket 在设备息屏时会挂住，脚本会先唤醒屏幕。
   另外**屏幕必须保持亮屏且应用在前台**，否则 `document.hidden = true` 会让 WebView
   冻结动画时间线（此时只能验证 1200ms 超时兜底，测不出真实手感）。
4. **多行任务的划线**：`::after` 是一条绝对定位的线，只穿过首行；单行任务（绝大多数）观感正确。要做到逐行划线需要 `background-size` 动画（违反 §4.3 红线）或 `text-decoration` 过渡（无法半程），暂不采用。
5. **simple 档的按钮按压**：transform 过渡被关闭，按下是瞬时缩放（符合「只淡入淡出」的定义，但手感不如 full）。
6. **卡片错峰只在数据/视图变化后重新播放**：切排序/视图会重放，正常滚动不会。最多 12 张，之后的卡片不再叠加延迟。
7. **主题扩散在无 VT 的环境不伪造**：只做一次很短的整页淡入，不模拟 `clip-path` 动画。

## 6. 验收证据（可复现）

| 项 | 结果 |
| :--- | :--- |
| `npm run verify` | 四道门禁 + 类型 + **735 条测试 / 50 文件** + 构建全绿 |
| `npm run verify:transition` | Step 1 **8/8** + Step 2 **8/8** + Step 3 **21/21**（`tools/repro-lazy-firstscreen.mjs` / `verify-close-transition.mjs` / `verify-flip-morph.mjs`） |
| `npm run verify:predictive-back` | 真机（小米 11 Ultra / Android 14 / HyperOS OS2.0）**23/23**：接收器安装、书架不拦截、单帧原子准备、快照、景深、阻尼曲线、圆角、cancel 回弹、commit 不弹回、层清理、原生开关时机 |
| Android 构建 | `./gradlew assembleDebug` **BUILD SUCCESSFUL**，API 34/33/33- 分版本守卫零报错 |
| `npm run smoke` | 真实 Chrome 393×873 **69/69** 不回归（含阅读/设置/统计全流程） |
| `npm run verify:motion` | **34/34** 通过：full 档 View Transitions 计数、指示点位移=一个槽宽、主题扩散中途标记与半径、simple/off/reduce 三档退化、左缘右滑跟手/提交/纵向不误触、帧间隔探针有效且最长 20–50ms（<150ms 卡线） |
| 截图 | `docs/screenshots/D/`：`d-reader-full`、`d-theme-reveal-mid`（能直接看到圆形边界）、`d-edge-swipe-mid`（页面右移跟手）、`d-reader-simple`、`d-reader-off`、`d-shelf-full` |

帧间隔的说明：headless 下 `PerformanceObserver('longtask')` 记录不到（探针验证过），所以用 rAF 帧间隔代替并先用 90ms 忙等证明探针有效；实测转场/切 tab 期间最长帧 20–50ms，属于可接受范围（任务书红线是 >50ms 长任务）。

**新增单测（本阶段）**：`core/window.test.ts` 22 条（窗口边界/前插补偿零跳动）、
`core/morph.test.ts` 30 条（FLIP 几何、圆角反向补偿、阻尼曲线）、
`core/back-gesture.test.ts` 20 条（退栈优先级、拦截时机）、
`views/page-mask.test.ts` 11 条（槽位隐身必恢复，含异常路径）、
`core/markdown-chunks.test.ts` +10 条（分片契约 + `data-lede` 与挂载区间解耦）。

## 7. 文件索引

| 文件 | 职责 |
| :--- | :--- |
| `web/src/core/motion.ts` / `motion.test.ts` | 强度判定、时长查询、降级类名（纯函数 + 令牌交叉校验） |
| `web/src/styles/tokens.css` | `--motion-*` / `--anim-*` 语义令牌与强度覆盖 |
| `web/src/styles/motion.css` | 关闭总闸、`motion-fade-in`、页面降级 keyframes、VT 伪元素、`@property --tab-index` |
| `web/src/views/motion.ts` | `runPageTransition` / `runCrossfade` / `runThemeReveal` |
| `web/src/core/window.ts` / `window.test.ts` | 首屏块窗口计算、分片区间映射、前插补偿（纯函数） |
| `web/src/core/morph.ts` / `morph.test.ts` | FLIP 几何（`fitToCard` / `stateForCard` / `followState`）、圆角反向补偿、阻尼曲线、时长常量 |
| `web/src/core/back-gesture.ts` / `back-gesture.test.ts` | 预测式返回的退栈优先级与拦截时机（纯函数，含原生桥接状态） |
| `web/src/views/page-mask.ts` / `page-mask.test.ts` | FLIP 双层形变、视口快照挂载、槽位隐身账本、`settlePageTransition` 兜底 |
| `web/src/views/snapshot.ts` | 退书视口轻量快照（只克隆屏内块） |
| `web/src/views/back-gesture.ts` | `window.__mdlegoBackGesture` 接收器（手势 → 形变矩阵） |
| `android/.../MdlegoNative.java` | `setBackIntercept` + API 34/33 分版本回调注册 |
| `tools/verify-predictive-back.mjs` | 真机预测式返回验收（23 项） |
| `web/src/views/sheet-drag.ts` | Bottom sheet 下拉手势（6 条单测） |
| `web/src/views/edge-back.ts` | 左缘右滑返回（8 条单测） |
| `tools/verify-motion.mjs` | 真实 Chrome 动效验收（34 条断言 + 截图） |
| `docs/DECISION-phase-D.md` | 本阶段设计说明（边界、退化矩阵、方案取舍） |
