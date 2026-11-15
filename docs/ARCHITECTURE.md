# 墨读 Mdlego · 架构

> 唯一架构事实源。任何实现与本文冲突时，要么改实现，要么先改本文再改实现。
>
> **2026-11-15 现状标注**：M3–M6 已冻结，本文中标注「冻结/未实现，仅历史参考」的
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
   当前**不做**增量 DOM 补丁，每次都整树重渲染（含阅读器）。文中提到的「标注重绘例外」
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

IndexedDB，**实际是四张表**（`DB_VERSION = 1`）：

| store | keyPath | 说明 | 现状 |
| :--- | :--- | :--- | :--- |
| `docs` | `id` | 文档原文与元数据，`by_last_read` / `by_imported` 索引 | 已实现 |
| `marks` | `id` | 标注，`by_doc` / `by_created` 索引 | 表已建、读写函数已实现；M3 冻结，无调用方 |
| `tasks` | `[docId, bid, index]` | 任务勾选（只存 App 内，不改原文） | 已实现并接线 |
| `meta` | `key` | `schemaVersion` 与迁移标记 | 表已建，暂无调用方 |

`settings` 表 **不存在**：README 与本段旧文都提过它，实际阅读偏好存 `localStorage`
（见 `data/settings-store.ts`）。原因是要在第一帧同步生效，异步开库会造成字号跳动。
这条务实偏差长期有效，不是临时妥协。

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
