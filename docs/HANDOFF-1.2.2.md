# 交接文档 · 墨读 Mdlego 1.2.2

> **读者**：接手这个仓库的下一个 Agent（或人）。
> **目标**：读完本文 + 扫一眼仓库，你就知道 —— ① 这软件是干啥的；② 代码怎么组织的；③ 这几天我们改了什么、为什么改；④ 现在是什么状态；⑤ 怎么自己验证一遍；⑥ 哪些坑绝不能再踩。
>
> **权威顺序**：本文写「已落地的事实」。若与其它文档冲突，以 `README.md` + `package.json` + 实际代码为准；`docs/MOTION.md` §4.3/§4.3.1 是动效的硬约束，不要绕过。
>
> 写于 HEAD `3b0d990`（tag `v1.2.2`），工作区干净。

---

## 0. 五分钟上手（照做，别跳）

```bash
cd Mdowner
npm ci
npm run verify        # 期望：4 道门禁 + 766 条测试/54 文件 + typecheck + build，全绿
```

看到 `Test Files 54 passed (54) / Tests 766 passed (766)` 就说明你接手的是绿的。

要出 APK（需要 JDK 21 + Android SDK 36，环境要求见 §2.2）：

```bash
npm run android:build   # 期望末尾打印产物路径 + 体积
```

**不要**在没有读懂 §7「坑」的情况下改动 `views/page-mask.ts`、`views/reader.ts`、`views/gesture-stage.ts`、`core/morph.ts` —— 这四个文件承载了 1.2.0–1.2.2 全部的返工血泪。

---

## 1. 这个软件是什么

**墨读 Mdlego**：一个**完全离线**的 Android Markdown 阅读器。为「英语备考笔记 + 学习计划」这类**每天要反复翻、反复画重点**的长文档而做。

它不是一个「Markdown 编辑器」，也不是「文件管理器」。核心场景是：**你有一堆自己写的 `.md` 笔记，想躺着在手机上一段一段读、查词、画重点、下次接着上次的位置读。**

| 维度 | 事实 |
| :--- | :--- |
| 平台 | Android（Capacitor 壳 + WebView 前端），`minSdkVersion 24` / `targetSdkVersion 36` |
| 包名 | `cn.mdlego.reader` |
| 联网 | **不申请 INTERNET 权限**，完全离线。没有 WebDAV、没有云同步、没有埋点 |
| 存储 | 导入时把 Markdown 正文复制进应用内 IndexedDB；原文件只读，除非用户主动「编辑原文」回写 |
| 体积 | APK 13.85 MB，其中离线词典 **716 个分片 `.tsv.gz` 共 9.24 MB**（ECDICT 10 万词条，按首字母+短语分桶懒加载） |
| 版本 | web `1.2.2`；Android `versionName 1.2.2` / `versionCode 1020299` |

### 1.1 现在能做的事（都是完整可用的，不是占位）

| 能力 | 一句话 |
| :--- | :--- |
| **导入** | 系统文件选择器多选 / 从别的 App 分享进来；按内容 sha256 去重，重复导入不覆盖已有阅读状态 |
| **书架** | 三列封面网格（标题哈希取色 + 首字）↔ 列表切换；三种排序；长按多选删除；继续阅读卡；横幅轮播（今日一句 / 继续阅读 / 导入引导，语录与背景图可自定义） |
| **底部导航** | 书架 / 搜索 / ＋导入 / 统计 / 设置五项玻璃悬浮条，中间凸起强调色导入按钮 |
| **渲染** | CommonMark + GFM（表格、删除线、任务清单、`==高亮==`）；原文 HTML 一律转义不执行；表格与代码块各自横向滚动；代码块有复制按钮与轻量高亮 |
| **阅读页** | 顶栏随滚动方向收放；点正文空白进沉浸模式；底栏显示已读百分比、Aa 排版面板、明暗快捷切换、下一章；图片全屏（双击/双指缩放） |
| **目录 / 搜索** | 目录抽屉（点击跳转并高亮）；单篇搜索；全库搜索（按文档分组、关键词高亮、默认范围切换） |
| **查词 / 生词本 / 历史** | 工具条「查词」弹玻璃底释义卡（音标/释义/词形提示/生词本按钮）；一键收藏生词（去重、上限 500）；查词自动记历史（同词留最近、上限 100） |
| **批注 / 高亮** | 长按选词 → 工具条 → 高亮 / 写批注；标记渲染与原文位置解耦（用锚点，不靠偏移量） |
| **编辑原文** | 阅读页「更多 → 编辑原文」：编辑/预览分段、实时预览、未保存保护；原生环境比对原文件指纹后写回（外部改动弹「覆盖 / 另存副本 / 取消」，**不静默覆盖**） |
| **朗读 (TTS)** | 系统 TTS 引擎，分句朗读 + 当前句高亮 + 进度跟随 |
| **备份恢复** | 导出 JSON（文档/批注/进度/任务/设置/收藏）同时下载 + 写剪贴板；恢复前校验格式/版本/校验和，确认后整库覆盖；损坏或未来版本明确拒绝 |
| **阅读进度记忆** | 退出再进来回到原位置（块级锚点 + 多轮校正）。**这是 1.2.2 刚修的 P0**，见 §4.3 |
| **动效** | FLIP 双层形变转场（书封→阅读页）+ Android 13+ 原生预测式返回跟手。1.2.0 全量重做，1.2.1 真机修了 4 个缺陷 |

### 1.2 明确**不**做的事（别自作聪明加）

- ❌ 不做 Markdown **编辑器**（只能整体「编辑原文」，不提供富文本工具栏）
- ❌ 不申请网络权限、不做云同步 / WebDAV
- ❌ 不引入第三方 UI 库、动画库、状态管理库（见 §2）
- ❌ 不做仿真翻页（正文是文档级滚动）
- ❌ 不伪造内容：没数据就显示空状态，不做假封面 / 假统计

---

## 2. 技术栈与硬约束

### 2.1 只有 4 个运行时依赖 —— 这是纪律，不是巧合

```json
"dependencies": {
  "@capacitor/android": "8.6.2",
  "@capacitor/app":     "8.0.1",
  "@capacitor/core":    "8.6.2",
  "markdown-it":        "15.0.3"
}
```

`devDependencies` 只有 6 个（vite / typescript / vitest / jsdom / @types / …）。

**新增任何运行时依赖前必须先问用户。** 这条约束是用户明确的「零新第三方运行时依赖」要求。想看排版、动效、状态管理自己写 —— 已经写了 `core/` 下 57 个模块，够用。

### 2.2 环境

| 依赖 | 版本 | 备注 |
| :--- | :--- | :--- |
| Node.js | `^22.22.2 \|\| ^24.15.0 \|\| >=26` | 已验证 24.19.0 |
| JDK | 21 | 已验证 Temurin 21.0.12 |
| Android SDK | Platform 36 + Build Tools 36 | 固定用 `D:\Workbuddyspace\.android-sdk` |
| Gradle | 8.14.3 | 本地有缓存就复用，不走 wrapper 下载 |

两个必踩的环境坑：

1. **Android Studio 自带的 SDK 只有 `android-37.0`（预览命名），AGP 8.13 不认**，会报 `Failed to find target with hash string 'android-37'`。必须用含 `android-36` 的那套，路径写在 `android/local.properties`。
2. **工程路径含中文**（`徐上茗工作空间`），依赖 `android/gradle.properties` 里的 `android.overridePathCheck=true`。别把它删了。

---

## 3. 代码地图

### 3.1 分层（单向依赖，机器强制）

```
web/src/
├── core/    57 个文件  纯逻辑：解析/锚点/搜索/排版/形变几何，不 import 上层（例外见下）
├── data/    14 个文件  IO 边界：IndexedDB / 文件 / 剪贴板 / 原生桥 / 词典
├── state/    2 个文件  唯一状态树 + dispatch
├── views/   53 个文件  视图与 DOM；唯一允许写裸 CSS 选择器的地方
├── styles/  19 个文件  CSS（tokens.css 是唯一色值来源）
└── main.ts  2297 行    应用装配 / 路由 / 事件接线 / 进度持久化
```

依赖方向：`views → core`、`views → data → core`，`core` 不 import 任何上层。`ui/` 目录在门禁规则里预留了但**从未创建**，别去建。

> **两处与 `docs/ARCHITECTURE.md` 不一致的实际状态**（以代码为准，别被旧文档误导）：
> 1. `ARCHITECTURE.md` §4.4 描述的 `core/selection.ts` **不存在**。实际的选词/选区逻辑在 `views/selection.ts`（视图层），因为要碰 `caretRangeFromPoint`。
> 2. `core/` **并非零 DOM/零副作用**：`core/diagnostics.ts` 用了 `window.addEventListener` + `localStorage`（错误边界要把崩溃现场持久化，这是刻意例外）；`core/window.ts` 和 `core/back-gesture.ts` 里出现的 `window.` 都是**注释或局部变量名**，不是真碰全局。
>
> 门禁只拦 `views`/`ui` 层用 `indexedDB`/`localStorage`/`sessionStorage`，**不拦 `core`** —— 所以 `diagnostics.ts` 能过。别把这个例外当成「core 可以随便写副作用」的许可。

### 3.2 四道机器门禁（`npm run verify` 的第一段）

| 门禁 | 脚本 | 规则 |
| :--- | :--- | :--- |
| **分层** | `tools/check-boundaries.mjs` | `core` 不得依赖 `data/views/ui/state`；`data` 不得依赖 `views/ui/state`；`ui` 不得依赖 `views/data`；`views/ui` 里禁止出现 `indexedDB`/`localStorage`/`sessionStorage`（IO 必须走 `data/`）。**注意 `core` 不受 IO 那一条约束**（`core/diagnostics.ts` 是刻意的例外） |
| **状态** | `tools/check-state.mjs` | 禁止直接赋值 `state.xxx`，必须 `dispatch(action)` |
| **选择器** | `tools/check-selectors.mjs` | 只有 `views/` 层允许裸 CSS 选择器；其它层必须用 `[data-testid="…"]` |
| **令牌** | `tools/check-tokens.mjs` | 除 `styles/tokens.css` 外出现硬编码色值即违规；`backdrop-filter` 只许出现在 `styles/glass.css` 且必须是「材质=glass」的规则 |

门禁不是建议。**改代码后跑不过就是改错了，不要改门禁去迁就代码。**

### 3.3 这次动过的关键文件（按重要性）

| 文件 | 行数 | 它负责什么 | 改动史 |
| :--- | ---: | :--- | :--- |
| `views/page-mask.ts` | 916 | 页面转场的编排：开/关遮罩、FLIP 形变、收尾清理 | 1.2.0 几乎重写(+609/−96)，1.2.1 #B/#C 修改 |
| `views/reader.ts` | 1133 | 正文挂载、块窗口管理、锚点定位、头尾补齐 | 1.2.0 +420，1.2.2 清 `anchored` 标志 |
| `main.ts` | 2297 | 装配、路由、进度保存、返回拦截同步、完整性兜底 | 1.2.0 +331，1.2.2 修缓存键 |
| `core/morph.ts` | 313 | **纯函数**：形变几何（`fitToCard` / `clipPathForScale` / 缓动 / 景深） | 1.2.0 新增，1.2.1 #B 加 `clipPathForScale` |
| `core/window.ts` | 202 | **纯函数**：块窗口计算、分片范围、滚动补偿 | 1.2.0 新增 |
| `views/gesture-stage.ts` | 190 | **手势临时层**：保证手势期绝不污染真实页面 | 1.2.1 #A 新增 |
| `core/back-gesture.ts` | 120 | **纯函数**：返回意图判定、能否跟手、进度归一化 | 1.2.0 新增 |
| `views/snapshot.ts` | 110 | 退书时把可见正文拍成静态层，避免「书架裸露」帧 | 1.2.0 新增 |
| `core/markdown.ts` | — | 渲染 + 分片 + 块 ID + 首段 `data-lede` 标记 | 1.2.0 +113 |
| `android/…/MdlegoNative.java` | — | 原生桥：文件、分享、TTS、**预测式返回** | 1.2.0 +250 |

---

## 4. 这三天干了什么

时间线：`v1.0.1`(11-18) → **`v1.2.0`(11-18)** → **`v1.2.1`(11-19)** → **`v1.2.2`(11-19)**。
每个版本都发布了 GitHub Release，`v1.2.2` 是当前 Latest。

### 4.1 `v1.2.0` —— 转场体系全量重做（47 文件，+5842 / −339）

**为什么要做**：1.0 的页面转场是「遮罩淡入淡出 + 卡片缩放动画」，观感是「两个不相干的东西先后出现」。用户要求做到「书封真的展开成阅读页」的 FLIP 形变，并对接 Android 13+ 的原生预测式返回（手指按住屏幕边缘往后拖时，页面跟着缩回书架）。

**做了什么**（新增 6 个源文件 + 3 个测试文件 + 5 个验收工具，全部是「新增」，无兼容风险）：

1. `core/window.ts`（202 行）+ `core/window.test.ts`（217 行，22 条）—— 块窗口纯函数：`WINDOW_SIZE=64`、`FIRST_WINDOW_BLOCKS=24`、`LEAD_BLOCKS=12`、`computeBlockWindow`、`chunksForBlockWindow`、`scrollCompensation`。
2. `core/morph.ts`（313 行）+ `core/morph.test.ts`（275 行，30 条）—— 形变几何纯函数：`fitToCard` 算出封面→全屏需要的 scale / 裁剪量 / 圆角；`lerpState`、`transformOf`、`dampedProgress`、`behindScale`、`scrimOpacity`。
3. `core/back-gesture.ts`（120 行）+ `core/back-gesture.test.ts`（134 行，20 条）—— 返回意图纯函数：`decideBackAction`、`shouldInterceptBack`、`canFollowMorph`、`settleDurationMs`。
4. `views/snapshot.ts`（110 行）—— 退书时快照可见正文。
5. `views/back-gesture.ts`（164 行）—— 手势 → 形变的视图侧接线。
6. `views/page-mask.test.ts`（161 行，11 条）。

工具：`tools/device-cdp.mjs`（真机 CDP 通道，**后续所有真机脚本的基础**）、`tools/ui-capture.mjs`、`tools/verify-close-transition.mjs`、`tools/verify-flip-morph.mjs`、`tools/verify-predictive-back.mjs`。

**重写/大改**：`page-mask.ts`（+609/−96）、`reader.ts`（+420/−52）、`main.ts`（+331/−23）、`markdown.ts`（+113/−15）、`MdlegoNative.java`（+250）、`AndroidManifest.xml`（+1 行 `enableOnBackInvokedCallback="true"`）。

**图层结构**（改了就崩，务必理解）：

```
.page-mask-behind   书架景深（打开 1.000→0.950，关闭 0.950→1.000）
└─ .page-mask-scrim 遮罩（opacity）
   └─ .page-mask    形变壳（transform + clip-path）← 缩放/裁剪都在这层
      ├─ .page-mask__cover   封面层（高度=cardUnscaledH，交叉溶解）
      └─ .page-mask__reader  阅读层（**唯一的滚动容器**，overflow-y:auto）
```

**同时做性能改造**：首屏不再一次挂 481 块，改成「先挂真实首屏窗口（24 块/1 分片），转场结束后再按 64 块补齐」。

### 4.2 `v1.2.1` —— 真机实测 4 项缺陷修复（不含新功能）

1.2.0 发布后在小米 11 Ultra 上实测，报出 4 个缺陷。**每一项都是「先取证 → 再修 → 修后真机复测」，一项一个独立提交。**

| # | 现象 | 根因 | 修后真机 |
| :-- | :--- | :--- | :--- |
| **A** | 预测式返回「开始后取消」→ 页面错位 / 白屏 | `prepareGestureStage()` 没挂书架，`shelfBehindStage()` 取到的是**真实阅读页**，每帧给它写内联 `transform`；取消路径只拆临时层、不还原样式。带 transform 的祖先会成为 `position:fixed` 后代的包含块 → 顶栏跑到屏幕中间 | `verify-gesture-integrity` **17/17**（`.appbar` Δ 8.77px → **0.00px**） |
| **B** | 转场中出现「屏幕比例大矩形」 | `fitToCard()` 的 `clipBottom` 被当布尔用，`clipPath` 写成零裁剪 `inset(0 0 0 0)`；且 `border-radius` 每帧在主线程重绘 | `verify-cover-aspect` **13/13**（第 0 帧可见区域与封面 Δw=0.01px、Δh=0.02px、宽高比误差 0.00%） |
| **C** | 打开动画掉帧、卡一帧 | 首帧中位 40.8ms、最慢 48.6ms；首屏同步挂 481 块。**只看 gfxinfo 会误判达标**（整轮抽样把首帧问题摊薄） | 首帧 **40.8 → 28.5ms**，长任务 **0**，janky 1.5%，首屏块 **481 → 64** |
| **D** | 刚打开时第一次长按没反应 | 原猜测「首次/二次走不同路径」**不成立**（两次事件序列完全一致）。真因是时间点：t+150ms 时 `caretRangeFromPoint` 命中 `DIV` 而非 `#text` —— 打开方向 `.page-mask__reader` 装的是**真实阅读页**，但该层声明了 `pointer-events: none`（本意给关闭方向的快照层用），`article` 继承到 `none`，`pointerdown` 到不了正文 | `verify-longpress-firstopen` **12/12**（工具条 347×46、9 个按钮） |

**每项的证据**在 `docs/perf/1.2.1/evidence/`，发布说明 `docs/RELEASE-1.2.1.md`，缺陷登记 `docs/BUGS.md` 的 BUG-015…BUG-018。

### 4.3 `v1.2.2` —— 阅读进度记忆失效（P0 回归）

**用户原话**：「现在这个进度记忆功能完全失效，退出书籍再返回进度的话，不会同步回观看时停留的状态。」而且是**间歇性**的。

**真机取证的关键对比**（`article` 是正文容器，`blocks[0]` 是它第一个块）：

```
正常轮次: article rect 高 39557，blocks[0] 高度 32、top -11487   ← 有真实布局
失效轮次: article rect 高 39557，blocks[0] 高度 0、  top 0        ← 块已 detach
```

`article` 自身高度正常，**但它的块高度全是 0** —— 这是「缓存里存的是已经脱离文档的旧节点」的确定特征。对 detached 元素调 `getBoundingClientRect()` 一律返回 0，于是二分找不到目标块 → `chosen === null` → `persistProgress()` 直接 return → 库里的值停在上一次成功保存的时刻。

**根因**：`progressBlockList()` 用 `${data-gen}|${childElementCount}` 当缓存 key。而 `generation` 是每个 PageView 的**局部变量**、每次 `createPage` 都从 0 计数 → `data-gen` **恒为 `"1"`**；同篇文档块数也相同 → **跨会话撞键**，返回上一次会话里已 detach 的节点。

**修法**：缓存键改为「元素身份 + 块数 + `isConnected`」，同节点同块数才复用。
**同时修掉同源隐患**：`page.dataset.anchored` 从不清理，导致 `anchorFirstFrame()` 提前返回（一步定位都没做却报「已恢复」）—— 改为每次 `mountInitialWindow()` 开始时清除。

**修后真机**：`verify-progress-memory` **7/7**，4 轮漂移 **0 / 1 / 1 / 12px**；回归 #A 17/17、#D 12/12。
证据 `docs/perf/1.2.2/evidence/progress-memory.json`，缺陷登记 BUG-019，发布说明 `docs/RELEASE-1.2.2.md`。

---

## 5. 现在的状态

### 5.1 绿灯项

| 项 | 结果 |
| :--- | :--- |
| 测试 | **766 条 / 54 文件** 全绿（3.2s） |
| 四道门禁 | 全绿 |
| typecheck + build | 全绿 |
| `android:build` | 全绿，产物 `releases/Mdlego-1.2.2-official.apk` |
| APK | 14,524,350 字节（13.85 MB），SHA256 `486eb60bbc48cea9694f2ac2c57aa6946dc5a8b09da4245ebed77a99bcfd0606` |
| Git | HEAD `3b0d990`，tag `v1.2.2`，分支 `main`，工作区干净 |
| GitHub Release | v1.2.0 / v1.2.1 / v1.2.2 已发布，v1.2.2 为 Latest |

### 5.2 资源与凭据

- 远端：`https://github.com/Yuvzol0932/Mdlego.git`
- `gh` CLI 已登录 `Yuvzol0932`
- **推送注意**：这台机器上 `git push` 走明文 URL 会报 `could not read Username for 'https://github.com'`。做法是临时 `git remote set-url origin "https://Yuvzol0932:$(gh auth token)@github.com/Yuvzol0932/Mdlego.git"` → push → **改回明文 URL**。别把 token 留在 `.git/config` 里。
- 网络到 github.com 时断时续，失败就退避重试，别当成代码问题。

### 5.3 唯一可用真机

| 项 | 值 |
| :--- | :--- |
| 型号 | 小米 11 Ultra（M2102K1C） |
| 系统 | Android 14 / HyperOS OS2.0 |
| adb serial | `518d68b2` |
| adb 路径 | `D:/Workbuddyspace/.android-sdk/platform-tools/adb.exe` |

**只有一台设备。** 所有要求「两台设备 / 不同 OS 交叉验证」的任务项都**未满足**，别在报告里写成已验证。

**MIUI 拦截 `adb shell input`（INJECT_EVENTS）** —— 点按、长按、滑动都不能用 adb 注入，必须走 WebView DevTools CDP + 页面内合成 `PointerEvent`。截图用 `adb shell screencap -p <设备文件>` + `adb pull`。这套做法已经封在 `tools/device-cdp.mjs` 里，直接用。

---

## 6. 怎么自己验证一遍

### 6.1 机器门禁 + 单测（无需设备）

```bash
npm run verify            # 4 门禁 + typecheck + 766 测试 + build
```

### 6.2 浏览器验收（需要真实 Chrome，走 CDP）

```bash
npm run verify:transition     # 三条：首屏窗口 8 项 / 关闭转场 8 项 / FLIP 形变 21 项
npm run verify:built          # 产物布局 + CSS 审计
npm run verify:lookup         # 查词弹层
npm run smoke                 # 冒烟 + 截图（小米 14 Pro 尺寸 + 触摸模拟），约 100 项断言
```

### 6.3 真机验收（需要设备在线）

```bash
npm run android:build                          # 出 APK
npm run android:install                        # 装机

node tools/verify-progress-memory.mjs          # 进度记忆 7 项（1.2.2 新增）
node tools/verify-gesture-integrity.mjs        # 手势完整性 17 项（#A 回归）
node tools/verify-longpress-firstopen.mjs      # 首次长按 12 项（#D 回归）
node tools/verify-cover-aspect.mjs             # 封面宽高比 13 项（#B 回归）
node tools/verify-predictive-back.mjs          # 预测式返回 23 项（**要求 Android 13+ 且亮屏前台**）
```

性能类：`tools/perf-first-frame.mjs`、`tools/perf-open-animation.mjs`、`tools/perf-profile-firstframe.mjs`。

> **测动画耗时的唯一正确姿势**：`anim.pause()` → `anim.currentTime = 0` → 再测。用 `sleep(30)` 之类去「等一帧」量到的是动画中间态，数字没有意义（我们在 1.2.0 就被这个坑骗过一次：量到 ratio 0.61，期望 0.75）。

### 6.4 怎么确认「我这次改动没搞坏」

最小回归三件套：

```bash
npm run verify && npm run verify:transition && node tools/verify-progress-memory.mjs
```

---

## 7. 坑（这一节最值钱，请逐条读完）

### 7.1 动效 / 转场

1. **`.page-mask__reader` 必须保留 `overflow-y: auto`** —— 它是全应用**唯一**的滚动容器。改成 `overflow: hidden` 或换容器，滚动、进度、锚点会一起失效。
2. **`appbarBottom()` 必须用 `offsetHeight`**，不能用 `getBoundingClientRect().bottom` —— 转场期间顶栏在 transform 里，rect 是视觉坐标，会导致锚点偏一个顶栏高度。
3. **形变几何的目标是内层 `[data-cover]`，不是 `.book-card`** —— 后者带外边距和阴影盒，取它会算出偏小的 scale。
4. **手势期间绝不向真实页面写内联样式**（BUG-015）。只能写临时层；真实页面最多加一个类名，且必须按**原值**还原。收尾必须收敛到**唯一幂等出口** `endGestureStage()`，并接入 cancel / commit / `visibilitychange` / `pagehide` / 路由变化**全部**路径。
5. **卡片态必须用 `clip-path` 裁成封面宽高比**（BUG-016）。`clipBottom` 是**要裁掉多少像素**，不是布尔值；圆角交给 `clip-path` 的 `round`，不要动画 `border-radius`。
6. **打开方向的承载层必须加 `.page-mask__reader--live`**（BUG-018）。默认的 `pointer-events: none` 是给关闭方向快照层用的。
7. **首屏窗口与补齐粒度不是一回事**（BUG-017）。DOM 插入粒度是「分片」（首片 24 / 其余 64）；首屏用 `WINDOW_SIZE=64` 会跨 2–3 片 → 实际挂 481 块 → 首帧 40.8ms。首屏必须用 `FIRST_WINDOW_BLOCKS=24`。
8. **阅读层不要做 `opacity` 动画** —— 几千像素 DOM 的滚动容器，opacity 会生成整屏离屏面并每帧重新合成。
9. **`settleAnimation()` 必须带超时兜底** —— WAAPI 的 `Animation.finished` 在 `document.hidden` 时**永不 resolve**，会让应用卡死在返回后。
10. **`settlePageTransition()` 必须 `try/finally { clearMorphSlot() }`** —— 中途抛异常会永久丢一个书架封面。
11. **`hideMorphSlot(null)` 会路由到 `clearMorphSlot()`** —— 传 null 不是「什么都不做」。
12. **`shouldInterceptBack` 在书架根必须返回 `false`**，否则系统「缩小成主页图标」的动画会被吃掉。

### 7.2 定位 / 进度

13. **`data-lede` 是内容标记，不是位置选择器**。1.2.0 用过 `.article > p:first-of-type` 给首段加首行缩进，结果「第一个元素是表格/引用」的文档重开后偏出 **300px**（首段少一行 → 每批 −34px × 8 批）。已改为 `markLeadingParagraph()` 在解析阶段打 `data-lede`。
14. **视觉坐标 ≠ 布局坐标。** 形变壳带 `scale()` 时，`getBoundingClientRect()` 是视觉坐标，`offsetTop` 是布局坐标。混用会导致锚点永远不收敛。用 `toLayoutPoint()` / `visualScale()` 换算，且**差值必须相对滚动容器**算、再除以 scale（这样一轮就收敛，残差 0）。
15. **头尾补齐用「参考元素视口偏移」补偿，不要用 `scrollHeight` 差值** —— 后者在有图片/异步布局时会漂。
16. **缓存 DOM 节点必须校验 `isConnected`**（BUG-019）。只靠「块数相同」会跨会话撞键，取到 detached 节点，所有 rect 变 0，进度静默不保存。
17. **`dataset` 上的「已完成」标志必须能被下一次流程清掉**（BUG-019 的同源隐患）。`dataset.anchored` 没清 → `anchorFirstFrame()` 提前返回「已恢复」，实际一步没做。

### 7.3 工程 / 流程

18. **`check:selectors` 会拦 `main.ts` 里的裸选择器**。写 `document.querySelector('[data-testid="page-mask-reader"]')`，不要写 `.page-mask-reader`；需要一次选多个元素时给它们加 `data-testid` 而不是逗号选择器。
19. **行尾符（CRLF/LF）会被编辑器翻动。** 曾出现过「改动 3 个文件，diff 变成 28 个文件」。提交前扫一眼 `git diff --stat`；不要引入 `.gitattributes` + `renormalize`（试过，会炸全仓库）。
20. **tag 不要随便移动。** 移动过 `v1.2.0`，`raw.githubusercontent.com` 因为 CDN 缓存还在发旧内容；以 GitHub API / `gh` 为准。
21. **`releases/` 与 `artifacts/` 在 `.gitignore` 里**，不进版本库。发布走 GitHub Release 附件。
22. **`docs/design/reference.png`（1.8 MB）未被引用**，故意没提交；实际在用的是 `reference.webp`。
23. **README 与 `android/variables.gradle` 的最低版本号不一致**：README 写「最低 Android 8.0（API 26）」，`variables.gradle` 实际是 `minSdkVersion = 24`（Android 7.0）。**以 `variables.gradle` 为准**。这是遗留笔误，改 README 时顺手对齐即可，不要反过来把 `minSdk` 提到 26。

---

## 8. 没做完 / 未验证（诚实清单）

这些**不能**当成已完成：

| 项 | 状态 |
| :--- | :--- |
| **第二台不同 OS 设备交叉验证** | ❌ **完全没做**。只有一台小米 11 Ultra / Android 14。所有「双机交叉」要求未满足 |
| **`#C` 最差单次首帧** | ⚠️ 仍是 **34–35ms**，超过 30ms 红线。中位数 28.5ms 达标，但 worst case 没有 |
| **逐帧率录屏（≥24fps 证据）** | ❌ 没做过真正的逐帧屏幕录制。现有帧数据来自 headless Chrome + 真机 gfxinfo 抽样 |
| **`#D` 极端快速点按** | ⚠️ 转场开始后 150ms 内立刻长按，仍可能失败（已大幅改善，未彻底消除） |
| **`progressBlockList()` 单测** | ❌ 无。它活在 `main.ts` 的闭包里，只被真机脚本覆盖。想补的话先把它提成 `core/` 纯函数 |
| **低端机真实帧率** | ❌ 未在低端机型上测过。低端机降级路径（`WATCH_WINDOW_MS=120` 内自检）逻辑有了，真机数据没有 |
| **Android 13 以下预测式返回** | 退化到应用内左缘右滑（`edge-back.ts`），只是增强，不等于系统返回键 |
| **多行任务清单的划线** | `::after` 只穿过首行。单行任务（绝大多数）观感正确；逐行划线需要违反动效红线的做法，暂不做 |

---

## 9. 交接建议：下一步该做什么

**优先级 1 —— 补验证缺口**（比加功能重要）：
把 §8 的「第二台设备」和「`#C` worst case」补上。前者需要用户协调硬件；后者可以深挖首帧里剩下的 6ms 花在哪（`perf-profile-firstframe.mjs` 已有骨架）。

**优先级 2 —— 把 `progressBlockList()` 提成 `core/` 纯函数并补单测**。它是 P0 的发生地，却完全没有单测保护，只靠真机脚本兜。

**优先级 3 —— 观察线上反馈**。1.2.2 是刚发布的热修，重点盯「进度记忆」是否还有间歇性复发（尤其大文档 / 图片多的文档）。

**不要做**：
- 不要为了「让测试变绿」改门禁规则或删测试。
- 不要顺手重构 `page-mask.ts` / `reader.ts` —— 没有真机复测能力的前提下重构这两个文件是纯风险。
- 不要加运行时依赖。

**协作方式**（用户明确要求过，沿用）：
- **严格按阶段推进，做完停下汇报**，不要一口气做完。
- 汇报必须给证据：命令输出、截图路径、真机数据。**没有测试和截图不要宣布完成。**
- 没验证的必须明说「未真机验证」，不许估算冒充实测。
- 每个缺陷一个独立提交，提交信息写「现象 → 根因」。
- **发布到 GitHub 前先问用户。**

---

## 10. 文档索引（哪份文档回答什么问题）

| 我想知道… | 看这个 |
| :--- | :--- |
| 这软件能干什么 / 怎么装 | `README.md` |
| 代码怎么分层、有哪些不变量 | `docs/ARCHITECTURE.md` |
| 写代码要守什么规矩 | `docs/CONVENTIONS.md` |
| 动效怎么做、为什么这么设计、硬约束 | `docs/MOTION.md`（**§4.3 / §4.3.1 必读**） |
| 有哪些已知缺陷、怎么修的 | `docs/BUGS.md`（BUG-001…BUG-019） |
| 1.2.0 的 diff 怎么读 | `docs/CHANGES-1.2.0.md` |
| 各版本发布了什么 | `docs/RELEASE-1.0.0.md` / `RELEASE-1.0.1.md` / `RELEASE-1.2.0.md` / `RELEASE-1.2.1.md` / `RELEASE-1.2.2.md` |
| 真机 M5 验收原始记录 | `verification.md`（仓库根，**已跟踪**） |
| 性能取证原始数据 | `docs/perf/1.2.1/`、`docs/perf/1.2.2/evidence/` |
| 上一次交接（阶段 A/B，历史） | `docs/HANDOFF-A-B.md` |
| 设计参考图 | `docs/design/reference.webp` |

---

**最后一句**：这个项目已经走完「从 0 到能用的 1.0」和「用起来不难看的 1.2」两段路，现在的问题是**验证覆盖不全**，不是功能不够。接手后第一件事是跑通 `npm run verify` 拿到绿灯基线，第二件事是看清 §7 的 23 条坑，第三件事再动手。
