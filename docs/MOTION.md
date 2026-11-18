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
| 1 | 书架 → 阅读器 | 阅读页挂在书架之上，`clip-path: inset(...)` 从**被点卡片矩形**（含卡片圆角）扩到全屏；内容始终真实尺寸，不缩放 | 300ms / `--ease-decel` | `views/page-mask.ts::runOpenMask` + `styles/motion.css::.page-mask` | simple：新页淡入 160ms；off：瞬时；找不到卡片矩形：屏幕中心 70% 矩形起步 | ✅（rc.3 重做，见 §4） |
| 2 | 阅读器 → 书架 | 反向：阅读页可见窗口从 `inset(0)` 缩回**关闭时重新测量**的卡片矩形（网格优先，其次继续阅读卡） | 240ms / `--ease-accel` | `views/page-mask.ts::runCloseMask` | simple：淡出 160ms；off：瞬时；找不到目标/不在可视区：中心 scale 0.94 + 淡出 200ms | ✅ |
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

## 4. 页面转场：遮罩展开（rc.3 起）

**书架 ⇄ 阅读页不再使用 View Transitions**（View Transitions 只剩主题切换的圆形扩散）。

做法（`views/page-mask.ts`）：

1. 打开：阅读页立即挂载成一个不透明的全屏层（`.page-mask`，`background: var(--paper)`），
   旧书架冻结成同尺寸滚动容器（`.page-mask-behind`，保留滚动位置与 sticky 顶栏）垫在下面；
   对阅读页层做 `clip-path: inset(top right bottom left round R)` 从「被点卡片矩形」动画到 `inset(0)`。
   点卡片任意位置（封面/标题/空白）都取整张卡片的矩形，不依赖点中封面。
2. 关闭：阅读页层 `clip-path` 从 `inset(0)` 缩回**关闭时重新测量**的卡片矩形
   （网格卡片优先，其次「继续阅读」卡片；阅读后文档会排到最前，所以必须重新量）。
   目标不可见/找不到 → 屏幕中心 `scale(0.94)` + 淡出。
3. 收尾：动画结束把阅读页放回文档流、删除遮罩层、恢复窗口滚动位置，并补发 `scroll` 事件
   （顶栏两态与进度条依赖它）。进入阅读页时阅读进度恢复（`scrollToBid`）在动画期间同步到遮罩层的 `scrollTop`。
4. 打断：新一次转场会先把上一段直接定位到终态（`settlePageTransition`），不闪烁；
   动画期间重复点击被忽略。
5. 低端机：连续 3 帧 > 32ms → 本次动画立即降级为 `opacity` 淡入。
6. 帧预算：点击后第一帧动画 ≤ 50ms 内开始（实测 39–46ms），转场期间无 >50ms 长任务
   （`PerformanceObserver('longtask')` 断言，实测空数组）。

证据：`docs/screenshots/transition-rc3/{before,after}/`，打开与关闭各
0/60/120/180/240/300ms 帧（`frames-open.json` / `frames-close.json` 记录每帧实际时间与 clip）；
验收脚本 `tools/repro-transition-rc3.mjs`（打包产物 + 真触摸，25 项断言）。

## 5. 已知限制

1. **未真机验证**：帧间隔与长任务只在 headless Chrome 里量过（见 §6），Android WebView 的真实表现未测。
2. **Android 10+ 手势导航**：系统在屏幕边缘拦截滑动，WebView 不一定收到事件。左缘右滑只作为应用内增强，不能替代系统返回键；系统返回键仍是主路径（阶段 A 已接线）。
3. **多行任务的划线**：`::after` 是一条绝对定位的线，只穿过首行；单行任务（绝大多数）观感正确。要做到逐行划线需要 `background-size` 动画（违反 §4.3 红线）或 `text-decoration` 过渡（无法半程），暂不采用。
4. **simple 档的按钮按压**：transform 过渡被关闭，按下是瞬时缩放（符合「只淡入淡出」的定义，但手感不如 full）。
5. **卡片错峰只在数据/视图变化后重新播放**：切排序/视图会重放，正常滚动不会。最多 12 张，之后的卡片不再叠加延迟。
6. **主题扩散在无 VT 的环境不伪造**：只做一次很短的整页淡入，不模拟 `clip-path` 动画。

## 6. 验收证据（可复现）

| 项 | 结果 |
| :--- | :--- |
| `npm run verify` | 四道门禁 + 类型 + **462 条测试** + 构建全绿（新增 motion 10 / sheet-drag 6 / edge-back 8） |
| `npm run smoke` | 真实 Chrome 393×873 **69/69** 不回归（含阅读/设置/统计全流程） |
| `npm run verify:motion` | **34/34** 通过：full 档 View Transitions 计数、指示点位移=一个槽宽、主题扩散中途标记与半径、simple/off/reduce 三档退化、左缘右滑跟手/提交/纵向不误触、帧间隔探针有效且最长 20–50ms（<150ms 卡线） |
| 截图 | `docs/screenshots/D/`：`d-reader-full`、`d-theme-reveal-mid`（能直接看到圆形边界）、`d-edge-swipe-mid`（页面右移跟手）、`d-reader-simple`、`d-reader-off`、`d-shelf-full` |

帧间隔的说明：headless 下 `PerformanceObserver('longtask')` 记录不到（探针验证过），所以用 rAF 帧间隔代替并先用 90ms 忙等证明探针有效；实测转场/切 tab 期间最长帧 20–50ms，属于可接受范围（任务书红线是 >50ms 长任务，真机数据待补）。

## 7. 文件索引

| 文件 | 职责 |
| :--- | :--- |
| `web/src/core/motion.ts` / `motion.test.ts` | 强度判定、时长查询、降级类名（纯函数 + 令牌交叉校验） |
| `web/src/styles/tokens.css` | `--motion-*` / `--anim-*` 语义令牌与强度覆盖 |
| `web/src/styles/motion.css` | 关闭总闸、`motion-fade-in`、页面降级 keyframes、VT 伪元素、`@property --tab-index` |
| `web/src/views/motion.ts` | `runPageTransition` / `runCrossfade` / `runThemeReveal` |
| `web/src/views/sheet-drag.ts` | Bottom sheet 下拉手势（6 条单测） |
| `web/src/views/edge-back.ts` | 左缘右滑返回（8 条单测） |
| `tools/verify-motion.mjs` | 真实 Chrome 动效验收（34 条断言 + 截图） |
| `docs/DECISION-phase-D.md` | 本阶段设计说明（边界、退化矩阵、方案取舍） |
