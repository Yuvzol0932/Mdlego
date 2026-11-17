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
| 1 | 书架 → 阅读器 | 封面矩形形变展开为整页（View Transitions） | page 420ms / standard（命名元素用 decel/accel 自定义 keyframes） | `views/motion.ts::runPageTransition` + `styles/motion.css` | 无 VT / simple：新页淡入 + 上移 12px；off：直接出现 | ✅（近似：矩形形变 + 交叉淡入，见 §4） |
| 2 | 阅读器 → 书架 | 反向收回（命名对象互换） | 同上 | 同上 | 同上 | ✅ |
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
| 左缘右滑返回 | 左缘 24px 内起手 | 横向位移 > 纵向 1.5 倍才接管；`dx > 96px` 或 `vx > 0.5px/ms` | 页面滑出淡出 → `nav/back`（跳过这一次 VT，避免把滑出画面拍进快照）→ 新页补进入动画 | `views/edge-back.ts` + `main.ts` | 仅「完整」档；起点在 `.hero__track / pre / .table-wrap` 内不启动；Android 手势导航可能在系统层拦截（见 §5） |

## 4. 与「共享元素动画」的差别（说清楚，不含糊）

书架封面 → 阅读页的转场**不是**真正的共享元素形变：阅读页里没有与封面一一对应的元素。
做法是把旧快照的封面与新快照的阅读页根节点都命名 `page-surface`，让浏览器做「封面矩形 → 整页矩形」的几何形变 + 内容交叉淡入。
观感上就是「封面展开成阅读页」，但 `MOTION.md` 与代码注释都不声称元素级 morph。

无 View Transitions 时旧页面由宿主**立即卸载**，所以没有退场动画；降级只有新页面的「淡入 + 上移 12px」。

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
