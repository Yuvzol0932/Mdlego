# 墨读 1.2.0 发布说明

发布日期：2026-11-18 · APK：`Mdlego-1.2.0-official.apk`（debug 签名，预览用）
版本：versionName `1.2.0` / versionCode `1020099`

本版是一次**转场体系的全量重做**：把书架 ⇄ 阅读页从「`clip-path` 裁切」升级为
**FLIP 双层形变 + 视口快照 + 景深联动 + Android 14 预测式返回**，并顺手把
「重新打开偏出几行」的锚点漂移彻底修掉。

按《Mdlego Transition Upgrade Plan》执行：Phase 0 只读盘点 → Step 1 窗口直出 →
Step 2 单帧原子切换 → Step 3 FLIP 形变 → Step 4 预测式返回 → 全量门禁。
零新增第三方运行时依赖（Web 只加原生 TS + DOM + Web Animations API，
Android 只用系统 SDK `android.window.*`）。

## 四步改造

| 步骤 | 做了什么 | 实测 |
| :--- | :--- | :--- |
| **Step 1** 以目标 `bid` 为中心的窗口直出 | 首屏不再固定挂「文档开头第一片」，由 `core/window.ts` 算出以阅读进度锚点为中心的 64 块窗口，映射到分片区间后同步挂载；上下补齐用双游标 + 参考元素视口偏移补偿 | 900KB / 3751 块文档：首帧 **321ms → 42ms**，长任务 `[290,108] → []`，动画期间挂载 **3751 → 25 块**，重新打开锚点 **−3px**（判据 ±80px） |
| **Step 2** 退书单帧原子切换 + 视口快照 | 快照 → 挂转场层 → 切底层 → 量卡片，四步在同一同步栈内完成（中间不 await、不等帧）；只克隆屏内十来块而不是整篇 | 退书全程 **0/28 帧**书架裸露（修前约 166ms 空窗）；快照 **10 块** vs 全文 3751 块 |
| **Step 3** FLIP 双层形变 + 书封交叉溶解 + 景深 | 形变壳只做 `transform` / `border-radius`，滚动永远在内层 `.page-mask__reader`；封面层与阅读层交叉溶解；底层书架 1↔0.95 景深联动 | 起始缩放 **0.2655**（= 卡片宽/视口宽，精确）、圆角反向补偿后可见 **18.0px**、封面 1.00→0.00 / 阅读 0.15→1.00、景深 1.000→0.950 |
| **Step 4** Android 14 预测式返回 | `OnBackAnimationCallback`（API 34）/ `OnBackInvokedCallback`（API 33）分版本注册；按路由栈深度动态注册与注销；Web 侧跟手阻尼缩窗 | 真机（小米 11 Ultra / Android 14 / HyperOS OS2.0）**23/23**：阻尼曲线 `1-0.15·damped` 逐点吻合、圆角 0→24px、cancel 200ms 回弹、commit 不弹回全屏、层与卡片隐身全部清理 |

## 修掉的 5 个真实缺陷

这一轮不是「照着计划书写完就算」，真机与验收脚本逼出了 5 个真的会让用户遇到的问题：

1. **重新打开偏出约 300px（Step 1 的回归）**
   根因是 `.article > p:first-of-type { text-indent: 2em }` 这个**位置选择器**。
   分片窗口会在文档前段**前插**分片，「DOM 里的第一个 p」随之滑动：
   ① 缩进跑到中段段落上（视觉错乱）；② 原首段丢掉一行（−34px），
   而前插补偿按「参考元素视口位移」计算，算不到这个高度变化 → 每批多滚 34px，
   八批累积 ≈300px。
   改成解析阶段打**内容级**标记 `data-lede`，CSS 只认属性不认位置。

2. **转场期间坐标系混用**
   `getBoundingClientRect()` 给的是**变换后**的视觉坐标，`scrollTop` 是**布局**坐标。
   形变壳 `scale(0.26)` 时两者差 `1/scale` 倍，且随动画推进自己变化 ——
   表现是「锚点每趟都接近一点但永远收敛不到位」。
   改成「相对滚动容器顶边」的差值算法（translate 在差值里自动抵消），
   **一趟收敛**（residual 0）。

3. **息屏/切后台后点返回没反应**
   Web Animations 的 `Animation.finished` 只在时间线推进时 resolve。
   Android WebView 在 `document.hidden` 期间**冻结动画时间线**，
   `finished` 永不 resolve，于是所有收尾逻辑（拆层、恢复卡片隐身、提交导航）
   全部挂死。实测息屏下 500ms 后仍是 `running`。
   新增 `settleAnimation(anim, ms, done)`，让「动画结束」与「超时」赛跑。

4. **跟手缩窗缺景深联动**
   `prepareGestureStage` 只建了压暗层，没接底层书架缩放，
   计划书要求的 `0.95 → 0.97` 同步微调缺失 —— 整页浮起来、底下书架僵着，
   跟手段与 commit 后的关闭动画断成两截。

5. **卡片隐身缺少兜底**
   新写的单测直接暴露：`settlePageTransition()` 只依赖各转场的 `finish()` 回调清账，
   一旦异常没跑到，书架会**永久**少一个封面。
   改成 `finally` 里无条件 `clearMorphSlot()`。

## 验证矩阵

| 门禁 | 结果 |
| :--- | :--- |
| `npm run verify`（boundaries / tokens / selectors / state + tsc + vitest + build） | ✅ **735 条测试 / 50 文件**（基线 640/46，净增 95 条） |
| `npm run verify:transition` | ✅ Step 1 **8/8** + Step 2 **8/8** + Step 3 **21/21** |
| `npm run verify:predictive-back`（真机 Android 14） | ✅ **23/23** |
| Android 构建 | ✅ `./gradlew assembleDebug` BUILD SUCCESSFUL；`lintDebug` 零 NewApi 错误 |
| 架构门禁 | ✅ `views→state→core` / `state→data` 单向；core 零 DOM 引用；无裸 CSS 选择器；无硬编码色值 |

新增单测：
`core/window.test.ts` 22 条（窗口边界、前插补偿零跳动）、
`core/morph.test.ts` 30 条（FLIP 几何、圆角反向补偿、阻尼曲线）、
`core/back-gesture.test.ts` 20 条（退栈优先级、拦截时机）、
`views/page-mask.test.ts` 11 条（槽位隐身必恢复，含异常路径）、
`core/markdown-chunks.test.ts` +10 条（分片契约 + `data-lede` 与挂载区间解耦）。

## 已知限制

1. **帧间隔只在 headless Chrome 量过**（首帧 42ms、无 >50ms 长任务）。
   真机验证的是**行为**（矩阵、回弹、落地、层清理），不是逐帧耗时 ——
   低端机的真实帧率仍需在目标机型上补测。
2. **预测式返回依赖 Android 13+ 与真机**。`verify:predictive-back` 需要 `adb` 可用；
   设备息屏时 WebView DevTools socket 会挂住（脚本会先唤醒屏幕），
   且**必须保持亮屏且应用在前台**，否则 `document.hidden = true` 会冻结时间线，
   只能验证 1200ms 超时兜底，测不出真实手感。
3. **Android 10–12 无预测式返回**，退化为应用内左缘右滑；系统返回键仍是主路径。
4. **多行任务的划线**只穿过首行（单行任务观感正确）；逐行划线需要 `background-size`
   动画（违反只动 transform/opacity 的红线）或 `text-decoration` 过渡（无法半程），暂不采用。

## 与 1.0.1 的兼容性

- 数据格式未变（IndexedDB schema 未改），可直接覆盖安装，书架/进度/批注/生词本全部保留。
- 唯一的行为变化：**首段缩进从「DOM 第一个 p」改为「文档真正的第一个段落」**，
  即向上滚动也不会再出现「中段段落莫名缩进」。
- 版本号从 1.0.1 跨到 1.2.0（跳号以体现这是一次结构性改造，不是补丁）。
