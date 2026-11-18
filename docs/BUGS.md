# BUGS —— 阶段 F1 缺陷清单（真机走查）

> 设备：小米 M2102K1C（Android 14 / HyperOS，1440×3200，DTS 3.5，cutout 高 137px，圆角 196px）
> 安装包：`Mdlego-1.0.0-rc.1-E-preview.apk`（versionName 1.0.0-rc.1 / versionCode 1000051，debug 签名）
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

### rc.3 修复（第 2 轮）

| ID | 级别 | 场景 | 现象 / 根因 | 状态 / 证据 |
| --- | --- | --- | --- | --- |
| BUG-012 | P1 | 打包后「＋」右偏半个身位（回归） | `.tabbar__plus` 用独立 `translate: -50% 0` 居中；Vite 8 的 Lightning CSS 压缩时**整条丢弃**该声明（最小复现：`.a{left:50%;translate:-50% 0;transform:none}` → `.a{left:50%;transform:none}`），产物只剩 `left:50%` → 右偏 29px。开发服务器正常，装机后才发现 | 已修复 · 居中改 `left:0;right:0;margin-inline:auto`；新增 `tools/verify-built-layout.mjs`（打包产物断言加号中心=导航条中心 <1px，按压仍对齐）与 `tools/audit-built-css.mjs`（逐条核对产物里被丢弃/改写的声明）；`android:build` 末尾自动串联。证据 `screenshots/transition-rc3/{before,after}/00-built-plus-*.png`（修前 Δ29.0px → 修后 Δ0.0px） |
| BUG-013 | P1 | 书架⇄阅读页转场（真机录屏证实） | ① 返回时放大的封面从上往下飞过「继续阅读」卡片、该卡封面仍在原位、书架第一格暂时空着；② 打开时书架与阅读页文字半透明叠影；③ 打开瞬间卡顿。根因：View Transitions 共享矩形命名 + 整页交叉淡入，且打开时同步渲染整篇正文 | 已修复 · 改为 `clip-path` 遮罩：打开 300ms decel 从被点卡片（任意位置）矩形展开、关闭 240ms accel 收回重新测量的卡片矩形；阅读页层不透明（`background: var(--paper)`）；彻底移除页面 View Transitions；左缘手势复用关闭动画。证据 `screenshots/transition-rc3/`（修前 10/25 → 修后 25/25；open/close 各 0–300ms 抓帧，`frames-open.json`/`frames-close.json` 记录实际帧时间与 clip） |

### 待修复（后续阶段）

| ID | 级别 | 场景 | 现象 | 状态 |
| --- | --- | --- | --- | --- |
| BUG-001 | P1 | F3 全局错误边界 | 源码无 `window.onerror` / `unhandledrejection` / 渲染兜底；`views/app.ts:140` 先 `render(state)` 再 `replaceChildren`，构建期异常会停在旧状态且无日志导出 | 待修复（F3） |
| BUG-002 | P1 | F4 超长文档首屏 | 823k 字符 / 1.9MB 文档：点击到首帧 1378ms（目标 < 300ms） | 待修复（F4） |
| BUG-003 | P1 | F4 超长文档滚动 | 同文档 31 080 DOM 节点 / 9 660 块，脚本滚动 p95 73ms、max 274ms | 待修复（F4） |
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
