# BUGS —— 阶段 F1 缺陷清单（真机走查）

> 设备：小米 M2102K1C（Android 14 / HyperOS，1440×3200，DTS 3.5，cutout 高 137px，圆角 196px）
> 安装包：`Mdlego-1.0.0-rc.1-E-preview.apk`（versionName 1.0.0-rc.1 / versionCode 1000051，debug 签名）
 > 第四轮（1.0.0）：F3 错误边界（BUG-001）、F4 性能（BUG-002/003）已修复；BUG-010/011 记档
> 第三轮（rc.3）：第 2 轮实测缺陷 BUG-012/BUG-013 已修复，见第二节末与「rc.3 修复」
> 第二轮：第 1 轮实测缺陷已全部修复并入 `1.0.0-rc.2`（见下方 BUG-004~BUG-009），回归 28/28 + smoke 128/128 + motion 34/34
> 证据边界见第二节：第 1 轮交互项以 Chrome 触摸模拟为主，真机锁屏只做冒烟
> 旧数据：0.1.0（versionCode 100）原地升级，升级前整目录备份到 `artifacts/device-backup-0.1.0/mdlego-0.1.0-data.tar`（7.9 MB，含 IndexedDB）
> 走查方式：真机 WebView + `adb forward` → CDP（`tools/device-eval.mjs`），屏幕锁定时也能读 DOM/截图；需要系统注入的操作（点击文件选择器、返回键、旋转、字体缩放）见「阻塞」一节
> 证据截图：`docs/screenshots/F/`

## 一、rc.1 真机走查记录（CDP 读取，非第 1 轮修复证据）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 0.1.0 → 1.0.0-rc.1 原地升级 | 安装成功，versionCode 100 → 1000051；5 篇旧文档、进度、设置全部可读，无迁移报错 | `02-shelf-home.png` |
| 书架首屏 | 横幅轮播 / 继续阅读 / 三列网格 / 底部五项导航 / 中间＋，无横向溢出，玻璃层 2 个 | `02-shelf-home.png` |
| 冷启动耗时 | 620 ms（`am start -W`） | — |
| 打开阅读页 | 顶栏、正文、底栏、进度文案正常；正文段落 17.5px/行高 32.9px | `03-reader-top.png` |
| 滚到底 | 最后一段不被底栏遮挡（`lastBottom=689 < barTop=852`） | `04-reader-bottom.png` |
| Aa 排版面板 | 字号 1–7 档：17.5px → 24.5px 即时生效；行距/段距/字体/主题齐备 | `05-typeset.png`、`06-typeset-max.png` |
| 主题切换 | 暖黑生效（body `rgb(26,21,18)`，正文 `rgb(239,230,216)`），重开后保持 | `07-reader-dark.png`、`26-relaunch-reader.png` |
| 文内搜索 | 「spect」命中 4 处，点击第 3 条跳转 341→539px，浮层关闭，命中块 flash，进度 58% | `08-search-layer.png`、`09-search-results.png`、`10-search-jump.png` |
| 目录 | 4 条（1 个 h1 + 3 个 h2，带层级），点第 4 条跳到 932px | `12-toc.png`、`13-toc-jump.png` |
| 划词工具栏 | 选区后出现 4 色 + 下划线 + 删除线 + 批注 + 查词 + 复制 | `13-toc-jump.png` |
| 高亮 | 黄色高亮写入 IndexedDB（`marks` 1 条，锚点 bid/start/end/quote 完整），CSS Highlight 组生效 | `14-highlight.png` |
| 批注 | 批注面板可输入（计数 13/500），保存后 `marks` 2 条、note 组生效、toast 提示 | `15-note-editor.png`、`16-note-saved.png` |
| 批注列表 | 「共 2 条」，逐条跳转/删除，导出 Markdown 复制成功（toast：已复制 2 条批注的 Markdown） | `17-marks-list.png`、`18-marks-export.png` |
| 收藏 | 顶栏书签 aria-pressed false→true，toast「已收藏」 | `19-reader-bookmarked.png` |
| 编辑原文 | 打开即带原文（334 字），改动后标记「未保存」→「271 字」 | `20-editor.png`、`21-editor-save.png` |
| 无原始 URI 时的保存降级 | 弹出「另存副本 / 取消」，不覆盖、不丢失；选副本后 toast「已存为应用内副本」，书架 5 → 6 篇 | `21`、`22-editor-copy.png` |
| 朗读降级 | Android WebView 无 Web Speech API（`speechSynthesis in window === false`），点朗读 → toast「当前系统不支持朗读」，不白屏 | `23-tts.png` |
| 材质=纯色降级 | `data-material=solid` 后全页 `backdrop-filter` 计数 0，底栏变为实色 `rgb(37,31,27)` | `28-material-solid.png` |
| 完整重启（force-stop → 冷启） | 主题 warm-night、字号 24.5px、2 条批注、阅读进度全部保留；无 JS 报错 | `25-relaunch.png`、`26-relaunch-reader.png` |

## 二、证据边界（第 1 轮）

- **主要证据 = Chrome 触摸模拟（393×873，DPR 3）**：`tools/repro-round1.mjs`，用 CDP `Input.dispatchTouchEvent` 真触摸，在动画进行中（80/160/240ms）抓帧；#4 在拖动到一半时抓帧。
- **#5 按压态**：headless Chrome 的 CDP 触摸不会进入 `:active`（实测 `matches(':active')=false`），几何测量改用 CDP `Input.dispatchMouseEvent` 按下（同一条浏览器输入管线，`:active=true`）并用 `CSS.forcePseudoState` 交叉复核；触摸按下截图仍保留（`05-plus-touch-pressed.png`）。
- **真机（518d68b2，rc.2 已安装 1000052）只做锁屏冒烟**：`tools/device-check-round1.mjs` → 3/5（安装版本 ✓、冷启动 ✓、首页 7 篇可读 ✓；`visibilityState=hidden` ✗、CDP 截图超时 ✗）。锁屏时 WebView 被系统冻结，**真机上的触摸/转场/截屏项一律标记「未经真触摸验证」**，见第四节「未验证项」。

## 三、缺陷与待办

### 第 1 轮真机实测缺陷（rc.1 → rc.2，已修复）

> 来源：作者在真机上实际使用 rc.1 后提出的 6 个问题（`MDLEGO-FIX-ROUND1.md`）。
> 复现方式：`tools/repro-round1.mjs`，**全部用真实触摸事件**（CDP `Input.dispatchTouchEvent`）+ 动画进行中抓帧/读数；`#5` 的按压态用 `CSS.forcePseudoState` 精确触发。
> 修复后全量复跑：**28/28 通过**（修前同一脚本 13/25，逐项证据见下）。

| ID | 级别 | 场景 | 现象（修前实测） | 根因 | 状态 / 证据 |
| --- | --- | --- | --- | --- | --- |
| BUG-004 | P1 | #1 打开书籍转场 | 点网格卡片标题，命名去做形变的是「继续阅读」那张封面（(44,368)），被点卡片封面在 (32,526)；屏幕上同时出现两个封面在飞 | `sourceCover` 用 `closest('[data-cover-doc]')`，点标题找不到（封面是兄弟节点）→ 回退 `coverForDoc` 永远取 DOM 第一个；返回路径同样；转场前也没清残留命名 | 已修复 · `screenshots/fix-round1/after/01-transition-*.png` |
| BUG-005 | P1 | #2 设置页排版 | 分区标题 13px/最淡色，比设置项 14.5px/正文色更小更淡；「玻璃」「纯色」「柔和半透明」被挤成竖排（Range 行数=2） | `.settings-section__title` 字号/颜色层级倒置；分段控件无 `nowrap`/最小宽度，被右侧 58% 控件区压扁 | 已修复 · `after/02-settings.png` |
| BUG-006 | P1 | #3 阅读页点空白 | 向下滚动后第一下点击无反应，第二下才切换（实测第一次后 `data-bars` 仍为 hidden） | `toggleImmersive` 按 `data-immersive` 取反而非实际可见性；残留选区命中 `selection.toString()>0` 直接 return 吞掉点击 | 已修复 · `after/03-*.png` |
| BUG-007 | P1 | #4 横幅轮播 | 相邻卡片间隙 0,0px，滑动时两张圆角卡片贴在一起；无缩放/变淡 | `.hero__track { gap: 0 }`；步长计算也没算 gap | 已修复 · `after/04-hero-drag-mid.png`（拖动中缝 19~23px） |
| BUG-008 | P1 | #5 加号按压 | 按住瞬间中心 x 由 196.5 跳到 225.5（Δ29px），松手弹回 → 横向扭动 | 居中用 `left:50% + transform: translateX(-50%)`，`:active` 的 `transform: scale()` 覆盖掉平移 | 已修复 · `after/05-plus-pressed.png`（位移 0.0px、宽度 94.0%） |
| BUG-009 | P2 | #6 两处 P2 | ① 排版面板「×」钉在屏幕顶 12~52px，压住正文首行；② 阅读页 scrollY=0 就有玻璃带（bg α=0.62 + blur 20px） | ① 关闭键 append 到整屏 layer 上按 safe-top 定位；② 阅读顶栏继承 `.appbar` 实底，`[data-material=glass]` 无条件加模糊 | 已修复 · `after/06-*.png`（× 484~524 贴面板上沿；顶部 rgba(0,0,0,0)+blur none） |

### F4 修复（块级懒挂载与性能）

| ID | 级别 | 场景 | 现象 / 根因 | 状态 / 证据 |
| --- | --- | --- | --- | --- |
| BUG-002 | P1 | 超长文档首屏 | 823k 字符 / 1.9MB 文档：点击到首帧 1378ms（目标 <300ms）。打开时同一帧同步解析整篇 + 全量 innerHTML | 已修复 · A2 的 Worker 解析 + 首片挂载已覆盖；真机 900KB / 10080 块实测点击→遮罩首帧 **34–60ms**，打开过程无 >100ms 长任务。证据 `screenshots/perf-f4/device-before|after/perf.json` |
| BUG-003 | P1 | 超长文档滚动 | 同文档 31 080 DOM 节点 / 9 660 块；脚本滚动 p95 73ms、max 274ms。根因：每帧写进度条/顶栏属性强制重排；每 400ms 全量 9.6k 次 getBoundingClientRect；滚动时 backdrop-filter 每帧重算 | 已修复 · 进度条同值不写 + 文档高度缓存 800ms；`data-scrolling` 期间关顶栏/底栏模糊；进度落库改缓存块表 + 二分（14 次 rect）；分片空闲补齐遇滚动暂停；真机实测 p95 **29.4ms**、max **39.8ms**（60Hz 两帧内）。残余：探针窗口偶发 1 次 ~72ms 长任务，attribution 为空、慢操作日志仅 15ms → 记档为 GC/合成，不作为应用回归 |

### F3 修复（错误边界）

| ID | 级别 | 场景 | 现象 / 根因 | 状态 / 证据 |
| --- | --- | --- | --- | --- |
| BUG-001 | P1 | 全局错误边界 | 源码无 `window.onerror` / `unhandledrejection` / 渲染兜底；`views/app.ts` 先渲染再挂载，渲染期异常会停在旧状态且无日志导出 | 已修复 · `core/diagnostics.ts` 采集 error/unhandledrejection/console.error（环形 100 条，localStorage 持久化，提示节流 15s）；`views/app.ts` 宿主级 try/catch 渲染兜底页（重试/回到书架，`data-testid="fatal-error/retry/home"`）；设置页「诊断与日志」可导出/清空 JSON（版本、构建号、环境、状态摘要、错误列表，不含正文）。证据 `screenshots/error-boundary/`，脚本 `tools/repro-error-boundary.mjs`（修前 3/15 → 修后 15/15） |

### rc.3 修复（第 2 轮）

| ID | 级别 | 场景 | 现象 / 根因 | 状态 / 证据 |
| --- | --- | --- | --- | --- |
| BUG-012 | P1 | 打包后「＋」右偏半个身位（回归） | `.tabbar__plus` 用独立 `translate: -50% 0` 居中；Vite 8 的 Lightning CSS 压缩时**整条丢弃**该声明（最小复现：`.a{left:50%;translate:-50% 0;transform:none}` → `.a{left:50%;transform:none}`），产物只剩 `left:50%` → 右偏 29px。开发服务器正常，装机后才发现 | 已修复 · 居中改 `left:0;right:0;margin-inline:auto`；新增 `tools/verify-built-layout.mjs`（打包产物断言加号中心=导航条中心 <1px，按压仍对齐）与 `tools/audit-built-css.mjs`（逐条核对产物里被丢弃/改写的声明）；`android:build` 末尾自动串联。证据 `screenshots/transition-rc3/{before,after}/00-built-plus-*.png`（修前 Δ29.0px → 修后 Δ0.0px） |
| BUG-013 | P1 | 书架⇄阅读页转场（真机录屏证实） | ① 返回时放大的封面从上往下飞过「继续阅读」卡片、该卡封面仍在原位、书架第一格暂时空着；② 打开时书架与阅读页文字半透明叠影；③ 打开瞬间卡顿。根因：View Transitions 共享矩形命名 + 整页交叉淡入，且打开时同步渲染整篇正文 | 已修复 · 改为 `clip-path` 遮罩：打开 300ms decel 从被点卡片（任意位置）矩形展开、关闭 240ms accel 收回重新测量的卡片矩形；阅读页层不透明（`background: var(--paper)`）；彻底移除页面 View Transitions；左缘手势复用关闭动画。证据 `screenshots/transition-rc3/`（修前 10/25 → 修后 25/25；open/close 各 0–300ms 抓帧，`frames-open.json`/`frames-close.json` 记录实际帧时间与 clip） |

| BUG-014 | P1 | 打开大文档卡顿/首帧超时（第 2 轮真机走查） | 900KB / 3751 块文档打开时同步解析+一次性挂载整篇正文：遮罩首帧 321ms、长任务 [290,108]ms、动画期间 3751 块全部在 DOM。根因：`renderMarkdown` 与 `innerHTML` 全量都在点击后的同一帧里做 | 已修复 · 正文按顶层块分片（首片 24 块）+ 解析/渲染移入 Worker + 转场结束后 `requestIdleCallback` 分批补挂；进度恢复在目标块未挂载时同步补齐并补滚。实测首帧 43ms、无 >50ms 长任务、动画期间 25 块、重开进度复位。证据 `screenshots/transition-rc3/lazy/{before,after}/`，脚本 `tools/repro-lazy-firstscreen.mjs`（修前 3/8 → 修后 8/8） |
### 待修复（后续阶段）

| ID | 级别 | 场景 | 现象 | 状态 |
| --- | --- | --- | --- | --- |

| BUG-015 | P1 | 预测式返回「开始后取消」→ 页面错位 / 白屏（1.2.0 真机） | 先做返回手势但不真正返回（取消），再回阅读页：本应在顶栏的「阅读中」滚到屏幕中间，另一台机直接白屏。真机取证：阅读页 `style` 从 `null` → `"transform: scale(0.9995);"` 永久残留，`.appbar top` Δ=8.77px。根因：`prepareGestureStage()` 没挂书架，`shelfBehindStage()` 取到的是**真实阅读页**，每帧给它写内联 `transform`，取消路径只拆临时层、不还原样式；带 transform 的祖先成为 `position:fixed` 后代的包含块 | 已修复 · 新增 `views/gesture-stage.ts`：所有写入只发生在临时层自己身上，真实页面只加类名并按原值还原；收尾收敛到幂等 `endGestureStage()`，接入 cancel/commit/visibilitychange/pagehide/路由变化；新增 `assertPageIntegrity()` 兜底重建；原生侧 `onBackStarted` 补发 `cancel`。证据 `docs/perf/1.2.1/evidence/A-gesture-sequences.json`，脚本 `tools/verify-gesture-integrity.mjs` **17/17**（修前 `.appbar` Δ=8.77px → 修后 **0.00px**） |
| BUG-016 | P1 | 转场中的「屏幕比例大矩形」（1.2.0 真机） | 打开时先收缩成屏幕比例矩形再展开；返回时以屏幕比例矩形出现。是一层比封面高一倍多的紫色圆角矩形，盖住卡片标题与邻居。根因：`fitToCard()` 算出的 `clipBottom` 被当布尔用，`clipPath` 写成零裁剪 `inset(0 0 0 0)`；且 `borderRadius` 每帧在主线程重绘圆角裁剪 | 已修复 · `core/morph.ts` 新增 `clipPathForScale()`：卡片态 `inset(0 0 clipBottom 0 round cardRadius)`、全屏态不裁剪，圆角改由 `clip-path` 承担；封面层高度改为 `cardUnscaledH` 不再 `inset:0`；`will-change` 修正为 `transform, clip-path`。证据 `docs/perf/1.2.1/evidence/cover-aspect/`，脚本 `tools/verify-cover-aspect.mjs` **13/13**（打开第 0 帧可见区域与封面 Δw=0.01px Δh=0.02px、宽高比误差 0.00%） |
| BUG-017 | P1 | 打开动画掉帧、卡一帧（1.2.0 真机） | 首帧（点击→遮罩出现）中位 40.8ms、最慢 48.6ms；首屏同步挂载 481 块。注意只看 gfxinfo 会误判达标（整轮抽样把首帧问题摊薄） | 已修复 · ①首屏窗口与补齐粒度拆开（`FIRST_WINDOW_BLOCKS=24`），首屏挂载 **481→64 块**；②删掉阅读层 opacity 动画（整屏离屏合成面）；③低端机自检只在开场 120ms 内判定，不再动画中途切模式；另删空转 rAF 与重复 `fitToCard`。实测首帧中位 **40.8→28.5ms**、长任务 **0**、janky 1.5%。证据 `docs/perf/1.2.1/{before,after,first-frame-*}.json`，脚本 `tools/perf-first-frame.mjs`。**遗留**：最慢单次仍 34–35ms（>30ms 红线） |
| BUG-018 | P1 | 刚打开时第一次长按没反应（1.2.0 真机） | 「刚打开软件后第一次进文档，长按英文词没反应；退出再进就好」。真机对比取证：首次与第二次的 `data-gen`/`blocks`/事件序列**完全一致**，任务书候选的「首次/二次走不同路径」不成立；真正差异在时间点 —— t+150ms（转场中）`caretRangeFromPoint` 命中 `DIV`，t+400ms 起命中 `#text`。根因：打开方向 `.page-mask__reader` 装的是**真实阅读页**，但该层声明 `pointer-events: none`（本意给关闭方向快照层用），于是转场期间 `article` 继承到 `none`，`pointerdown` 到不了正文，长按计时器不启动 | 已修复 · 新增 `.page-mask__reader--live { pointer-events: auto }`，**打开方向**加该类、关闭方向保持默认；`selection.ts` 新增 `toLayoutPoint()` 做视觉→布局坐标换算、`textPointAt()` 自动识别形变壳 scale；转场中取不到词时记位置并在 `transition-end`/`article-complete` 补判（4s 老化）。证据 `docs/perf/1.2.1/evidence/D-longpress-verify.json`，脚本 `tools/verify-longpress-firstopen.mjs` **12/12** |
| BUG-019 | **P0** | 阅读进度记忆失效（1.2.1 用户报告） | 「退出书籍再返回，不会同步回观看时停留的位置」，且间歇性。真机打点：`article` rect 高 39557 正常，但 `blocks[0]` 高度 0、top 0（detached 特征）→ `getBoundingClientRect()` 全 0 → `rect.bottom > baseline` 永不成立 → `chosen` 为 null → `persistProgress()` 直接 return，库里的值停在上次成功保存的时刻。根因：`progressBlockList()` 用 `${data-gen}|${childElementCount}` 当缓存 key，而 `generation` 是每个 PageView 的局部变量、每次 `createPage` 都从 0 计数 → `data-gen` 恒为 `"1"`；同篇文档块数也相同 → **跨会话撞键**，返回上一次会话里已 detach 的节点 | 已修复 · 缓存键改为「元素身份 + 块数 + `isConnected`」，同节点同块数才复用；同时修掉同源隐患 `page.dataset.anchored` 从不清理导致 `anchorFirstFrame()` 提前返回（一步定位都没做却报「已恢复」），改为每次 `mountInitialWindow()` 开始时清除。证据 `docs/perf/1.2.2/evidence/progress-memory.json`，脚本 `tools/verify-progress-memory.mjs` **7/7**（4 轮漂移 0/1/1/12px）；回归 #A 17/17、#D 12/12 |
| BUG-010 | P3 | 另存副本 | 副本标题与原文完全相同，书架出现同名篇目 | 待定 |
| BUG-011 | P3 | 朗读 | Android WebView 无 Web Speech API → 真机朗读不可用（降级提示正确）；要做需原生 TextToSpeech 桥 | 记档 |

## 四、阻塞项（需要手机侧配合或真机权限）

1. **屏幕锁定/息屏**：`screencap` 只能拿到系统截图，锁屏时是黑屏；状态栏/刘海/手势条适配必须解锁亮屏后截一张「系统层 + 应用」的图。
2. **`adb shell input` 被拒**：`SecurityException: INJECT_EVENTS`（HyperOS 未开「USB 调试（安全设置）」）。导致：
   - 系统返回键链路（F2 必测）无法自动验证；
   - 文件选择器（SAF 导入）无法自动点击 → 「导入 → 阅读」全链路、以及「编辑后写回原文件（需 SAF 持久授权 URI）」无法真机验证；
   - 旋转/字体缩放（`settings put` 也被拒绝，缺 `WRITE_SETTINGS`）无法自动改。
3. 已绕过：WebView 内容层的一切走查用 `tools/device-eval.mjs`（CDP）完成，不依赖注入。

## 五、复现命令（可重复）

### 第 1 轮 6 个缺陷（修前应失败、修后应全绿）

```bash
npm run build
node tools/repro-round1.mjs --out=after          # 全量 28 项断言
node tools/repro-round1.mjs --only=4 --out=after # 只跑 #4
```

### 真机 CDP 走查

```bash
adb -s 518d68b2 forward tcp:9333 localabstract:webview_devtools_remote_$(adb -s 518d68b2 shell pidof cn.mdlego.reader | tr -d '\r')
node tools/device-eval.mjs --file tools/f1-helpers.js
node tools/device-eval.mjs --shot docs/screenshots/F/x.png '(async()=>{ __f1.click("doc-item"); await __f1.s(1200); return __f1.metrics(); })()'
```

## 六、第 1 轮未验证项（不得当作通过）

| 项 | 原因 | 复验方式 |
| --- | --- | --- |
| #1/#3/#4/#5 在**真机**上的触摸手感 | 手机锁屏，WebView `visibilityState=hidden`，触摸注入与 View Transition 均不可靠 | 解锁并保持亮屏后：`npm run android:install` + 手测，或开「USB 调试（安全设置）」后跑 `node tools/device-check-round1.mjs` 的真机触摸版 |
| #5 触摸按下态的真实浏览器表现 | headless Chrome 触摸不产生 `:active`（已用鼠标输入 + forcePseudoState 复核） | 真机解锁后按住加号观察 |
| #1 转场观感（是否仍有「两个封面飞」） | 抓帧在 headless 下不含 View Transition 伪元素层，只能证明「命名的封面是我点的那张」（rect 级证据） | 真机解锁后点书架卡片观察 |
| 锁屏状态下的真机截图 | WebView 冻结，`Page.captureScreenshot` 超时 | 解锁后重跑 `tools/device-check-round1.mjs` |
