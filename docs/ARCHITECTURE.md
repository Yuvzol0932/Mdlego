# 墨读 Mdlego · 架构

> 唯一架构事实源。任何实现与本文冲突时，要么改实现，要么先改本文再改实现。
>
> **2026-11-17**：M3–M6 **已解冻**（见任务书 v2）。渲染与路由见 `docs/DECISION-render-A.md`。
>
> **2026-11-15 旧标注（部分已过时）**：M3–M6 曾冻结，本文中标注「冻结/未实现，仅历史参考」的
> 模块、契约与不变量在当前代码里**不存在**。M2 已实现的部分是：`core/markdown.ts`、
> `core/anchors.ts`（仅 `makeBid`）、`core/search.ts`、`core/typography.ts`，
> `data/db.ts`（`docs`/`marks`/`tasks`/`meta` 四表）、`data/import.ts`、`data/library.ts`、
> `data/native.ts`、`data/settings-store.ts`，以及 `views/`、`state/store.ts`。

## 1. 这份文档解决什么问题

上一代项目的失败模式是「改一处崩三处」。根因不是能力不足，而是**没有边界**：
所有逻辑写在事件回调里、全局状态与 DOM 互相写、改任何一处都不知道会波及哪里。

本项目的全部架构决策，围绕一件事：**让「改一处」在物理上只能影响一处**。

## 2. 分层

```
┌─────────────────────────────────────────────────┐
│  views/   书架 · 阅读器 · 浮层                     │  读 state → 写 DOM → dispatch(intent)
├─────────────────────────────────────────────────┤
│  ui/      （未建目录，冻结/未实现，仅历史参考）      │  不持有业务状态
├─────────────────────────────────────────────────┤
│  core/    解析 · 锚点 · 搜索 · 排版                 │  纯函数，零副作用
├─────────────────────────────────────────────────┤
│  data/    IndexedDB · 文件 IO · 设置                │  唯一允许产生副作用的地方
└─────────────────────────────────────────────────┘
```

**依赖方向严格单向**（`ui/` 未建，冻结/未实现，仅历史参考）：

```
views → core
views → data → core
core  ← 什么都不依赖
```

`core` **禁止** import `data` 或 `views`。`views` **禁止**直接碰 `indexedDB`、`localStorage`、`fetch`。

这条规则由 `npm run check:boundaries` 用 TypeScript 编译器 API 静态扫描，违规即构建失败。

## 3. 不变量

1. **`core/*` 是纯函数**：给定输入必然给出同一输出。不读 `window`、不读当前时间、不读随机数。
   （`core/selection.ts` 不存在 —— 冻结/未实现，仅历史参考。）
2. **`data/*` 是唯一 IO 边界**。所有异步副作用集中在这里。
3. **`ui/*` 不持有业务状态**。（`ui/` 目录不存在 —— 冻结/未实现，仅历史参考。）
4. **视图更新只有一条路**：`dispatch(action)` → reducer 产生新 State → `render(state)`。
   页面节点创建一次、局部更新（`views/app.ts` 的页面宿主）；阅读器正文只在文档内容或长按查词开关变化时重建。导航状态在 `state.nav`（`core/nav.ts`）。文中提到的「标注重绘例外」
   属冻结/未实现，仅历史参考。
5. **版本号只有一个来源**：`package.json` 的 `version`。

## 4. 模块契约

先看 `core/types.ts` —— 所有跨层传递的数据都在那里有具名类型。这是「契约先行」。

### 4.1 `core/markdown.ts`

```ts
export function renderMarkdown(source: string): RenderResult
export function escapeHtml(input: string): string
export function extractTitle(source: string): string | null
```

- 基于 markdown-it（CommonMark + GFM 表格/删除线/任务清单），不自己写解析器。
- **`html: false`**：原文中的裸 HTML 全部转义，绝不执行。这是安全底线。
- 链接只放行 `http/https/mailto/file/data` 协议。
- 每个**可标注块**带 `data-bid`。可标注块 = 段落、标题、列表项、表格单元格、代码块。
- 容器（`table`、`blockquote`、`ul`）**不带** bid —— 避免「容器与内容争夺同一锚点」。

### 4.2 `core/anchors.ts`

**当前只有 `makeBid` 一个函数在用**（`core/markdown.ts` 生成 `data-bid` 时调用）。
下面其余两个函数与 `Anchor`/`RelocateResult` 契约属于 **冻结/未实现，仅历史参考** ——
代码里没有实现，M3 解冻前不应出现调用方：

```ts
export function makeBid(kind: string, text: string, ordinal: number): string   // ← 已实现

export function captureAnchor(bid: string, blockText: string, start: number, end: number): Anchor  // 冻结/未实现
export function relocate(anchor: Anchor, blockText: string): RelocateResult                       // 冻结/未实现
```

`bid` 用「块开头 24 字符 + 序号」，不是整块哈希。这样段落小改字后 bid 不变，标注跟着稳定。

### 4.3 `core/annotations.ts`

**冻结/未实现，仅历史参考。** 该文件在代码里不存在，M3 解冻前不建：

```ts
export function computeSegments(length: number, marks: Mark[]): Segment[]   // 未实现
export function styleFor(marks: Mark[]): Style | null                       // 未实现
```

纯函数，把「一组重叠标注」切成互不重叠的渲染片段。

### 4.4 `core/selection.ts`（唯一碰 DOM 的 core）

**冻结/未实现，仅历史参考。** 该文件在代码里不存在，`core/` 目前是纯函数层，无 DOM 依赖：

```ts
export function readSelection(root: HTMLElement): SelectionInfo | null   // 未实现
```

**关键设计**：选区起点常常是容器元素（`<table>`、`<blockquote>`），而不是文本节点。
必须用 `commonAncestorContainer` 判断是否在正文内，再遍历所有 `[data-bid]` 求交集。
上一代项目在这里只处理「起止同块」，导致真机上跨段选择一律失效。

### 4.5 `data/db.ts`

IndexedDB，**阶段 C6 起是五张表**（`DB_VERSION = 2`）：

| store | keyPath | 说明 | 现状 |
| :--- | :--- | :--- | :--- |
| `docs` | `id` | 文档原文与元数据，`by_last_read` / `by_imported` 索引 | 已实现 |
| `marks` | `id` | 标注，`by_doc` / `by_created` 索引 | 表已建、读写函数已实现；M3 冻结，无调用方 |
| `tasks` | `[docId, bid, index]` | 任务勾选（只存 App 内，不改原文） | 已实现并接线 |
| `meta` | `key` | 迁移标记 + `bookmarks`（收藏的 docId 列表） | 已实现 |
| `sessions` | `id` | 阅读会话（`docId/startedAt/endedAt/ms`），统计页数据源，`by_started` 索引 | C6 新增 |

迁移策略（有测试）：`STORE_SCHEMA` 描述每个版本该有的仓库/索引，`onupgradeneeded` 只**补缺失**仓库，绝不删改已有仓库（`storesForVersion` / `applyUpgrade` 是纯描述 + 纯函数，`db-migration.test.ts` 用最小假对象验证）。
`deleteDoc` 刻意**不删 sessions**：读过的时长是历史事实，删文档不该抹掉累计统计；统计页的「最近读过」会按现存文档过滤。

`settings` 表 **不存在**：README 与本段旧文都提过它，实际阅读偏好存 `localStorage`
（见 `data/settings-store.ts`）。原因是要在第一帧同步生效，异步开库会造成字号跳动。
这条务实偏差长期有效，不是临时妥协。设置结构当前是 **schema v4**（v1→v2 材质/主题/动效，v2→v3 横幅图/语录，v3→v4 屏幕常亮），旧档可读由迁移测试守着。

正文与标注分表：改一条批注不会重写整篇文档。

## 5. 锚点策略（核心设计）

**整节冻结/未实现，仅历史参考。** 当前代码只实现了下面的 `bid` 生成规则（见 4.2
的 `makeBid`）；四元组锚点、三档重定位与 `RelocateResult` 都不存在。

上一代：`bid = hash(整块文本)`。改一个字，锚点全变，标注全部失联。

本项目用四元组：

```
bid        稳定块标识 = 类型 + hash(块开头 24 字符) + 序号
start/end  块内字符偏移
quote      被标注原文（≤ 80 字符）
prefix/suffix  锚点前后各 16 字符
```

重定位三档，逐档收紧：

1. **原偏移处原文仍吻合** → 直接采用（最常见，零成本）
2. **`prefix + quote + suffix` 唯一匹配** → 用组合串定位
3. **`quote` 唯一匹配** → 只靠原文定位

三档全失败 → 返回 `{ ok: false, reason }`，由调用方**显式提示用户**。
**绝不猜测位置。** 静默错位比丢失更糟。

## 6. 渲染策略

- 打开文档：一次 `renderMarkdown` → 一次 `innerHTML` 写入 → 一次任务勾选状态套用。
- 标注变更：只重绘**受影响的块**，不全量重排。（冻结/未实现，仅历史参考。）
- 搜索：直接扫 `RenderResult.blockTexts`，不碰 DOM、不修改持久数据。
- 性能门槛：1 万字文档首屏渲染 < 150 ms，写在 `tools/check-perf.mjs` 里。
  **该文件不存在 —— 冻结/未实现，仅历史参考。** 现有四道门禁里没有性能项。

## 7. 构建与产物

| 命令 | 作用 |
| :--- | :--- |
| `npm run dev` | Vite 开发服务器 |
| `npm run verify` | 边界扫描 + 令牌扫描 + 选择器扫描 + 类型检查 + 单测 + 构建 |
| `npm run android:build` | 构建 → 推送 Web 产物 → Gradle 打包 → `aapt2` 反读校验 |
| `npm run android:install` | 装进模拟器并截图 |
| `npm run android:verify` | 校验已装机版本号与构建清单一致 |

**版本号单一来源**：`package.json` 的 `version`。
Vite 通过 `define` 注入 `__APP_VERSION__`；Gradle 构建时读同一个 `package.json`。
构建产物文件名带内容哈希，因此不存在「忘了改 `?v=`」这类问题。

**构建指纹**：每次构建写入 `buildId = git短哈希-时间戳`，显示在设置页。
打包后 `aapt2 dump badging` 反读 APK 版本，与 `package.json` 不一致即失败。

## 8. 与原生层的边界

Web 侧通过 `data/native.ts` 封装 Capacitor 调用，全部带浏览器降级：

| 能力 | 原生实现 | 浏览器降级 |
| :--- | :--- | :--- |
| 选择并读取文件 | `MdlegoNative.pickFiles` + `readDocuments` | `<input type="file">` |
| 待处理分享 URI | `MdlegoNative.peekPendingUris` / `clearPendingUris` | 空实现 |
| 回写原文件 | `MdlegoNative.writeDocument` | 不支持（M6 冻结，无调用方） |
| 导出备份 | FileProvider 交系统分享 | `Blob` + `<a download>`（M4 冻结，未实现） |
| 返回键 | `@capacitor/app` `backButton` | 无（浏览器不注册该监听） |
| 构建信息 | 构建期常量 | 同左 |

`AndroidManifest.xml` **不声明 `INTERNET` 权限** —— 本应用完全离线。

## 9. 阶段 C 变更（2026-11-17）

本节记录 C 阶段新增的架构事实，与上文冲突处以本节为准。

### 9.1 导航：一级 tab 扩到 5 个，浮层扩到 6 种

- `Tab = 'shelf' | 'search' | 'stats' | 'settings' | 'kit'`；`kit` 仍只在开发/`--mode kit` 构建可见。
- `LayerKind = 'toc' | 'search' | 'lookup' | 'menu' | 'typeset' | 'image'`。
  - `menu`：锚定弹出菜单 / 底部面板 / 居中确认框（`views/menu.ts`，内容不进 state，main 持有 `MenuSpec`）。
  - `typeset`：阅读页 Aa 面板（`views/typeset.ts`，随 state 同步滑块值，不重建）。
  - `image`：正文图片全屏查看（`views/imageview.ts`，双击/双指缩放只动 transform）。
- 返回仍然只有一条路：`dispatch({type:'nav/back'})` → 先弹浮层、再弹页面、到底退出。
- hash 语义是「切 tab」：`#/search`、`#/stats`、`#/settings` 走 `nav/tab`；离开这些 hash 回书架。
  从阅读页进设置走 `nav/push`（二级页形态，带返回键）。

### 9.2 页面级 UI 状态留在视图里

书架页是 `createShelfPage`（不是 `signaturePage`）：排序方式、网格/列表、多选集合、轮播位置都是**页面级 UI 状态**，不进全局 state。
`PageView` 接口新增可选 `destroy()`，宿主在页面被弹出缓存时调用（清滚动监听与自动轮播定时器）。

### 9.3 新增纯函数模块

| 模块 | 契约 |
| :--- | :--- |
| `core/quotes.ts` | `DEFAULT_QUOTES` / `normalizeQuotes(raw)`：语录收敛（去空白、去重、截长、限条数） |
| `core/highlight.ts` | `highlightCode(code, lang)`：先转义再着色的轻量高亮（纯函数、零依赖） |
| `core/stats.ts` | `computeStats(sessions, docs, now)`：会话 → 统计快照（本地时区归日、连续天数、去重文档数、最近读过） |

### 9.4 样式文件按界面拆分

`index.html` 的加载顺序：令牌 → `app.css`（底座）→ `library.css`（抽屉/浮层）→ `dict.css` → `components.css`（`.ui-*`）→ `glass.css`（唯一允许模糊）→ `typography.css`（正文精修，**必须在 app.css 之后**）→ `tabbar.css` / `shelf.css` / `reader-shell.css` / `menu.css` / `settings.css` / `stats.css`。

旧的 `.doc-item` / `.fab` / `.reader-bar` / `.stepper` / `.segmented` / `.switch` / `.panel` / 旧空状态 CSS 已在 C 阶段删除（约 8.4KB），不要在页面里再用这些类名。

### 9.5 新增的 data 能力

| 模块 | 说明 |
| :--- | :--- |
| `data/banner.ts` | `pickBannerImage()`：选图 → canvas 缩到长边 1440 / JPEG 0.82 → data URL（≤900KB），超限返回 null 由界面提示 |
| `data/native.ts` | 新增 `requestScreenWakeLock()` / `releaseScreenWakeLock()`：Screen Wake Lock，不支持的环境静默降级 |
| `data/db.ts` | `putSession` / `getAllSessions` / `clearSessions`；表结构与迁移见 §4.5 |

### 9.6 会话记录的作用域

main.ts 在打开文档时开始计时、离开阅读页/切前后台/pagehide 时结束并落库；**只累计前台可见时长**（`visibilitychange` 暂停/恢复），
少于 3 秒的打开忽略，单次上限 4 小时。统计快照在启动、会话落库后、删除文档后刷新。

## 10. 阶段 D 变更（2026-11-17）

### 10.1 动效的唯一判定处

```
设置 motion + 系统 prefers-reduced-motion
      │ core/motion.ts::effectiveMotion（系统 reduce 一律折算 off）
      ▼
<html data-motion="off|simple|full">        ← main.ts::syncVisualSettings 写生效值
      │ tokens.css 按属性覆盖 --motion-* / --anim-*
      ▼
组件 CSS 只消费 --motion-* / --anim-*；JS 只消费 core/motion 的查询函数
```

- 时长/缓动的 JS 侧唯一来源是 `MOTION_DURATIONS`，CSS 侧是 `tokens.css` 的 `--dur-*`；两者由 `motion.test.ts` 用 `tokens.css?raw` 交叉校验。
- `data-motion` 写的是**生效值**；设置页仍显示用户选择（两者可以不同，例如系统 reduce 时）。
- 系统偏好变化时 `main.ts` 会重新同步（`matchMedia(...).addEventListener('change')`）。

### 10.2 页面转场与手势

| 能力 | 文件 | 说明 |
| :--- | :--- | :--- |
| 页面转场 | `views/motion.ts::runPageTransition` | View Transitions 包装一次 state 变更；`doc/opened` 前向、`doc/closed`/`nav/back` 反向、`nav/tab` 交叉淡入。动态 `view-transition-name: page-surface` 在转场前后加/删，不进 DOM 属性 |
| 主题扩散 | `views/motion.ts::runThemeReveal` | 原点取 main 记录的「最近一次指针/点击」，半径写 `--vt-x/y/r`，`motion.css` 里 `clip-path` 动画 |
| Bottom sheet 下拉 | `views/sheet-drag.ts` | 跟手 translateY + 遮罩 opacity；阈值/速度吸附；只在 full 档挂载 |
| 左缘右滑返回 | `views/edge-back.ts` | 24px 触发区、1.5 倍方向判定、阻尼跟手、提交后 `nav/back`；提交时 `suppressNextPageTransition` 防止叠 VT |
| 导航指示点 | `views/tabbar.ts` + `motion.css` | 槽位索引写 `<html> --tab-index`（`@property` 注册为 `number`，可插值），指示条只 `translateX` |

宿主新增 `AppHost.mountedElement()`：转场命名与降级进入动画需要拿到当前挂载页根节点。

### 10.3 样式加载顺序（更新）

`... stats.css → motion.css`。`motion.css` 必须在最后：它包含「动效关闭」的全局总闸与 View Transitions 伪元素，需要覆盖前面所有组件的过渡。

### 10.4 验收入口

- `npm run verify:motion` → `tools/verify-motion.mjs`：真实 Chrome 下 34 条断言（三档退化、VT 计数、主题扩散、手势、帧间隔）+ `docs/screenshots/D/`。
- 单测：`core/motion.test.ts`（10）、`views/sheet-drag.test.ts`（6）、`views/edge-back.test.ts`（8）。
- 逐项说明见 `docs/MOTION.md`，设计取舍见 `docs/DECISION-phase-D.md`。

## 11. 阶段 E1 变更（2026-11-17）

### 11.1 书架数据：标签与单层文件夹

- `Doc.tags?: readonly string[]`、`Doc.folder?: string | null` 是**可选字段**：旧记录没有它们，`data/library.ts::loadShelf` 读出后统一走 `core/library.ts::normalizeLibraryDoc` 补默认值并归一化（去空白、大小写不敏感去重、长度/数量上限）。
- 没有新增 IndexedDB 仓库或索引，因此**不升 DB 版本**；标签/文件夹筛选是书架视图的本地全量遍历（千级文档足够），避免为可选字段做迁移。
- 写回：main 把「变更后的 docs」逐篇 `doc/updated` + `saveDoc`，只写真正变化的文档（引用比较）。

### 11.2 新增纯函数模块

| 模块 | 契约 |
| :--- | :--- |
| `core/library.ts` | `normalizeTag(s)` / `normalizeFolder` / `tagsOf` / `folderOf` / `normalizeLibraryDoc` / `collectFacets` / `filterDocs` / `isFiltering` / `tagSelectionState` / `addTagToDocs` / `removeTagFromDocs` / `setFolderForDocs` / `tagsAmongDocs` |
| `core/search.ts`（扩展） | `groupHitsByDoc(hits, docs, maxPerDoc)`（按首次出现顺序分组，丢弃已删文档的残留命中）、`highlightSegments(text, query)`（大小写不敏感切分，供 `<mark>` 渲染） |

### 11.3 新浮层 `collection`

- `LayerKind` 增加 `collection`；main 持有 `CollectionSpec { kind: 'tags' | 'folder', docIds }`，`views/collection.ts` 只画面板，点击立即回调 main 的批量写操作。
- 与 `typeset` 共用 `sheetLayer`（现在支持自定义 `testId/closeTestId`）与 Bottom sheet 下拉关闭。
- `[hidden] { display: none !important; }` 在 `app.css` 兜底：作者样式里的 `display: inline-flex/flex` 会覆盖浏览器默认的 `[hidden]`（E1 截图抓到的真实 bug）。

### 11.4 书架页签名

`views/shelf.ts::docsSignature` 现在包含 `tags` / `folder` 与收藏列表：标签或收藏变化必须触发 `paintBody`，否则筛选条与卡片 meta 不更新（smoke 抓到过）。

## 12. 阶段 E2 变更（2026-11-17）

### 12.1 标注数据流

```
IndexedDB marks ──getMarksByDoc──▶ core/marks.ts::relocateMarks ──▶ state.marks（当前文档）
                                        │ changed → putMark 回写新偏移
                                        └ orphans → 不改锚点，列表标「失效」
state.marks ──▶ views/marks-render.ts::applyMarkHighlights（CSS.highlights，不改 DOM）
            └─▶ views/marks.ts 列表 / marksToMarkdown 导出
选区 ──▶ views/selection.ts::rangeToParts ──▶ main::createMarksFromParts ──▶ mark/added + putMark
```

- `state.marks` 只保留**当前文档**的标注（打开文档时按 docId 读取；关闭/切文档清空），列表与渲染都直接消费它。
- 锚点偏移统一相对 `RenderResult.blockTexts`（空白折叠后的块文本），DOM↔偏移换算只在 `marks-render`/`selection` 两处。
- 标注渲染用 CSS Custom Highlight API：7 组 `::highlight(mdlego-*)`，颜色来自 `--mark-*` 令牌。

### 12.2 选区与工具条

- 自绘选区（长按取词 / 拖动跨块），不依赖系统 ActionMode；原生选区（桌面/自动化）走 `selectionchange` 兼容路径。
- 工具条是 fixed 定位的深色胶囊（`--bar-dark`），位置按选区矩形计算；动效 `--anim-toolbar-in` 走三档退化。
- 点击已有标注：`markAtPoint`（坐标 → 块内归一化偏移 → 覆盖该偏移的标注）→ 动作条（删除/编辑备注/复制）。
- **行为变更**：长按不再自动弹查词卡片；查词成为工具条按钮（受设置 `lookupEnabled` 控制显隐）。

### 12.3 新浮层

- `LayerKind` 增加 `marks`（批注列表）与 `note`（备注面板），复用 `sheetLayer` + Bottom sheet 下拉关闭；main 持有列表数据与备注草稿。
- 重新挂载：列表点「重新挂载」→ main 记 pending → 用户在正文选新文字 → 工具条出现「挂载到此」→ 用新选区替换锚点并持久化。
