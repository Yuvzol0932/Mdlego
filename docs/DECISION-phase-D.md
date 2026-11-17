# 阶段 D 设计说明 · 动效（Motion）

> 任务书 §4 要求「统一写入 `motion.ts` + 令牌，禁止各处自写」。本文先把边界、退化矩阵、每项动效的实现方式定下来，再按 D1–D5 小步落地；每步都有可复现的断言或截图。
> 阶段 C 已完成并发布 v0.6.0（`docs/PHASE-C.md`）。本阶段只改动效与手势，不改版面与数据。

## 0. 完成定义（DoD）

1. `core/motion.ts` 是动效强度的**唯一判定处**；CSS 只消费令牌 `--motion-*`，组件不自己写时长/缓动。
2. 任务书 §4.2 表中每一项要么实现、要么在 `docs/MOTION.md` 里写明「不适用/未做」的原因。
3. `prefers-reduced-motion` 与设置「动效：关」下全部退化（无 transform 动画、无位移、无持续长任务）；「简约」只保留淡入淡出。
4. `node tools/verify-motion.mjs` 在真实 Chrome 里断言：三种强度下计算样式符合矩阵、转场期间无 >50ms 长任务、页面截图可复现。
5. `npm run verify` 全绿、`npm run smoke` 不回归、`npm run shot:c` 不回归。

## 1. 强度判定（唯一来源）

```
effectiveMotion(设置值, 系统 reduce):  reduce ? 'off' : 设置值
```

- `off`：所有 transition/animation 时长归零（保留终态），JS 不启动 View Transitions、不挂手势、不做错峰。
- `simple`：只允许 `opacity`（与颜色）过渡；一切 `transform` 位移/缩放时长为 0，keyframes 换成纯淡入。
- `full`：按任务书时长/缓动执行，允许 View Transitions 与手势。

`<html data-motion>` 写的是**生效值**（reduce 时是 off），设置页仍显示用户选择。系统偏好变化时实时重算，不需要重启。

## 2. 令牌

沿用阶段 B 的 `--dur-*` / `--ease-*`（`--ease-spring` 已是 `linear()` 弹性近似 + standard 回退），新增一层**语义令牌**，组件只准用语义令牌：

| 令牌 | full | simple | off |
| :--- | :--- | :--- | :--- |
| `--motion-transform-dur` | `var(--dur-base)` | `0ms` | `0ms` |
| `--motion-fade-dur` | `var(--dur-base)` | `var(--dur-base)` | `0ms` |
| `--motion-page-dur` | `var(--dur-page)` | `var(--dur-base)` | `0ms` |
| `--motion-sheet-dur` | `var(--dur-slow)` | `var(--dur-base)` | `0ms` |
| `--motion-stagger` | 40ms | 0ms | 0ms |
| `--anim-*`（keyframes 名） | 各自的几何动画 | `motion-fade-in` | `none` |

`tool/check-tokens` 继续保证颜色只在令牌层；动效时长同样只写在 `tokens.css` / `motion.css`。

## 3. 页面转场（书架 ↔ 阅读器）

**主路径：View Transitions API**（Android WebView / Chrome 支持）。

- 前向（打开文档）：旧快照里把来源封面（`[data-cover-doc]`）命名 `page-surface`；新快照里把宿主挂载的阅读页根节点命名 `page-surface`。浏览器会把「封面矩形 → 整页矩形」做几何形变 + 内容交叉淡入 —— 观感就是「封面放大展开成阅读页」。
- 反向（退回书架）：命名对象互换（阅读页根 → 对应文档封面）。书架页被宿主缓存，节点可能不在 DOM 里，回调里先等宿主挂载再命名。
- 时序：`startViewTransition(() => { dispatch(action) })`。`host.update` 在 store 订阅里同步执行，新快照天然包含新页面，不需要额外帧。
- 结束后立刻移除临时 `view-transition-name`（避免污染后续快照与 `getComputedStyle` 断言）。

**降级**（无 VT / simple / off）：新页面挂载后加 `.page-enter--forward|back` 类，`full` 是「淡入 + 上移 12px」，`simple` 只有淡入，`off` 不加类。旧页面由宿主直接移除，不做退场动画（没有 VT 时无法同时持有两页快照）。

**为什么不是共享元素真形变**：阅读页没有与封面一一对应的元素（正文首屏是 H1，不是封面）。用 `page-surface` 命名做「矩形形变 + 交叉淡入」是**近似**，不声称是共享元素动画；`MOTION.md` 会注明。

## 4. 主题圆形扩散

- 触发：`settings/changed` 且 `patch.theme` 存在、强度 full、VT 可用。
- 原点：main 记录的**最后一次 pointerdown 坐标**（设置页/阅读页/排版面板都走同一条 dispatch，不入侵各视图 API）。
- 实现：VT 期间给 `::view-transition-new(root)` 加 `clip-path: circle(0 at x y)` → `circle(半径 at x y)` 的 keyframes；半径取「原点到四角最远距离」，用 CSS 变量传入。
- 降级：无 VT 时不做扩散，直接换色（`:root` 颜色本身有 `--motion-fade-dur` 过渡的组件会自然淡变）；simple 下只做一次 220ms 的整页淡入。**不伪造**扩散效果。

## 5. 微交互

| 项 | 方案 | 退化 |
| :--- | :--- | :--- |
| 底部导航指示点 | `@property --tab-index`（number）注册在 `<html>`，指示条 `left: calc((var(--tab-index) + .5) * 20% - 9px)`；切 tab 时只变 `--tab-index`，由属性过渡驱动位移（Chrome 支持；不支持则瞬移） | simple/off 关闭过渡（瞬移） |
| 卡片错峰进入 | 书架卡片挂载时按索引设 `--stagger-i`，`animation-delay: calc(var(--stagger-i) * var(--motion-stagger))`，最多 12 张 | off 不加动画；simple 换纯淡入 |
| 任务勾选 | C4 已有 SVG 勾线（stroke-dashoffset）；补「文字划线从左到右」：任务文本包 `<span class="task-text">`，`::after` 用 `scaleX(0→1)`（transform，合规） | off 直接显示划线 |
| 跳转高亮 | 已有 `.flash` 1.2s 背景渐隐；时长改用 `--motion-fade-dur` 的 1.2s 常量 `--motion-highlight-dur` | off 不闪 |
| 按钮按压 | `.ui-press:active { scale(.96) }` + spring（已有） | simple/off 关闭 transform 过渡 |
| 统计柱 | 已有错峰生长（scaleY，`--grow-delay`），延迟改用 `--motion-stagger` | simple 换淡入，off 直接终态 |
| 抽屉 / 面板 | 抽屉：slide-in + 遮罩淡入（transform/opacity）；Bottom sheet：滑入 + 下拉手势（见 §6） | simple 只淡入；off 直接出现 |

## 6. 手势

### 6.1 Bottom sheet 下拉关闭

- 作用域：Aa 排版面板、菜单的 `sheet` 变体（`menu-sheet-in`）。
- 抓取：面板顶部把手 / 面板头部 `pointerdown`；`pointermove` 更新 `translateY(dy)` + 遮罩 `opacity`；`pointerup` 判定：
  - `dy > 96px` 或 `vy > 0.55px/ms` → 继续下滑到 100% 后调用关闭（`layer/closed`）；
  - 否则 spring 回 0。
- 只影响 transform/opacity；不做 `height` 动画。`simple/off` 不挂手势（仍可用遮罩/关闭按钮）。
- 与内部滚动不冲突：把手/头部区域才启动拖动；面板内容滚动不拦截。

### 6.2 左缘右滑返回

- 触发区：屏幕左缘 24px；`pointermove` 中 `|dx| > |dy| * 1.5` 且 `dx > 0` 才算手势（避免与纵向滚动抢）。
- 跟手：当前挂载页根节点 `translateX(dx * 0.55)`（带阻尼），上限 120px。
- 提交：`dx > 96px` 或 `vx > 0.5px/ms` → 动画滑出后 `dispatch({type:'nav/back'})`；否则回弹。
- 只在「可返回」时启用：`nav.pages.length > 1 || layers.length > 0`（书架栈底不拦截）。
- 排除区域内横向滚动：手势起点在 `.hero__track` / `pre` / `table-wrap` 内不启动。
- **已知限制**：Android 10+ 手势导航在系统层拦截边缘滑动，WebView 不一定收到事件；不声称「替代系统返回」，只做「应用内左缘滑动」的增强。

## 7. 文件与测试

| 文件 | 内容 |
| :--- | :--- |
| `web/src/core/motion.ts` | 纯函数：强度判定、时长查询、标志位；`motion.test.ts` |
| `web/src/styles/motion.css` | 语义令牌、退化覆盖、页面降级 keyframes、VT 伪元素、`@property` |
| `web/src/views/motion.ts` | `runPageTransition()` / `markPageEnter()` / `supportsViewTransitions()`（DOM 层） |
| `web/src/views/sheet-drag.ts` | Bottom sheet 下拉手势（新模块，`sheet-drag.test.ts`） |
| `web/src/views/edge-back.ts` | 左缘右滑返回（新模块，`edge-back.test.ts`） |
| `tools/verify-motion.mjs` | 真实 Chrome：三种强度的计算样式矩阵、VT 使用标记、长任务统计、截图 |
| `docs/MOTION.md` | 逐项动效表（触发/属性/时长/缓动/退化/文件）+ 实现与未做清单 |

## 8. 明确不做（写进 MOTION.md，不偷偷跳过）

- **选词工具栏**（任务书 §4.2 一行）：依赖划词批注，属阶段 E2/E4，界面上还没有这个构件。
- 页面转场的**真实共享元素形变**：阅读页无对应元素，只有矩形形变 + 交叉淡入（见 §3）。
- 旧页面退场动画（无 VT 时宿主立即卸载旧页，没有可动画的节点）。
- 任何 `width/height/top/left/margin` 动画。
