# 阶段 E2 设计说明 · 划词批注

> 任务书 §6 E2：四色高亮、下划线、删除线、文字批注；锚点 `data-bid` + 偏移；文档变动后重定位，失败显示「失效」并可手动重挂；批注列表可跳转、可导出 Markdown。
> 现状：**M3 只冻结了 core 的锚点能力**（`core/anchors.ts` 的 `makeBid/captureAnchor/relocate`、`Mark/Anchor` 类型、IndexedDB `marks` 表与读写函数、state 的 `marks` + `mark/added`/`mark/removed`），**视图、选区、渲染、列表、导出全部没有**。E2 是在这层地基上补齐 UI 与数据接线。

## 0. 完成定义（DoD）

1. 正文里**选中任意文字**（拖选或长按选词）后出现工具条：4 色高亮、下划线、删除线、批注、查词、复制；动作立即生效并持久化。
2. 标注渲染：4 色高亮底色 / 下划线 / 删除线 / 批注标记（虚线），页面重进、刷新后仍在。
3. 锚点：`data-bid` + 块内字符偏移 + 原文/前后文；重开文档时自动重定位（`core/anchors.ts::relocate`）；无法定位的标注**不静默丢弃**，在列表里标「失效」。
4. 批注列表：阅读页「更多 → 批注」，按块顺序列出（类型、原文、备注），点击跳转并高亮；可删除；失效项可「重新挂载」（选中新文字后挂载）；可**导出 Markdown**（剪贴板 + toast）。
5. 失败明确：写库失败 toast；当前系统不支持 CSS Highlight API 时，把「不支持正文标注」明确告诉用户，列表仍可用。
6. 单测 + 至少一张 smoke 截图；`npm run verify` / `npm run smoke` 全绿。

## 1. 关键取舍

### 1.1 渲染方式：CSS Custom Highlight API（不写 DOM）

- 用 `new Highlight(range)` + `CSS.highlights.set(...)` 绘制标注，**不往正文插 `<span>`**。原因：正文是阶段 A 的铁律（不重建/不污染），DOM 包裹会破坏 inline 结构、重叠标注无法嵌套、重渲染要撤销一遍。
- 样式按类型分 6 个 Highlight 组：`hl-yellow/hl-green/hl-blue/hl-pink/underline/strike/note`，`::highlight(...)` 给底色/下划线/删除线。
- 点击已有标注：用 `caretRangeFromPoint` 命中位置 → 归一化块内偏移 → 查包含该偏移的标注 → 弹「删除 / 编辑备注 / 复制原文」小工具条。
- **降级**：不支持时（老 WebView）不画内联标记，只显示列表 + 首次提示；不伪造。

### 1.2 偏移空间：块纯文本（blockTexts）

- `anchor.start/end` 相对 `RenderResult.blockTexts`（渲染时 `collapseWhitespace` 过的块文本），与 M3 的 `relocate` 一致。
- DOM 文本做同样的归一化（连续空白折叠成一个空格），建立「归一化偏移 ↔ DOM 文本节点/偏移」映射，标注 Range 由此生成。
- 这样重定位、搜索、列表引用同一套偏移，不会出现两套坐标系。

### 1.3 选区：自绘拖选 + 长按选词

- 正文保留 `user-select: none`（沿用 M5），自己实现选择：
  - 长按 500ms → `caretRangeFromPoint` 取词（`core/text.ts::wordAt`）→ 选中该词；
  - 按住拖动 → 从起点到当前点构造 Range（跨块也行），用同一个 Highlight 组 `mdlego-selection` 显示；
  - 松手 → 弹工具条（脱离选择则收起）。
- 好处：不弹 Android 系统 ActionMode，不依赖系统选择手柄，测试可用程序选区路径覆盖。
- 兼容路径：`selectionchange` 里若发现浏览器原生选区落在正文内（桌面调试/无障碍），同样弹工具条。
- 工具条「查词」调用 M5 的查词卡片（`lookup.ts` 导出 `lookupSelection`）；长按不再自动弹卡片（改为工具条里的显式动作），设置里的「长按查词」开关控制工具条是否显示查词按钮。

### 1.4 批注（note）

- `type: 'note'` 的标注带 `note` 文本；渲染为「高亮 + 虚线下划线」。
- 新建：工具条「批注」→ 底部备注面板（textarea）→ 保存时同时落标注与备注。
- 编辑：列表或正文标注工具条「编辑备注」→ 同一面板。

### 1.5 导出 Markdown

- 格式：`# <文档标题> · 批注` + 按块顺序的列表，每项 `> 原文`（含类型/颜色前缀）+ 备注行；失效项附「⚠ 原文已变更，标注失效」。
- 出口：剪贴板（`navigator.clipboard`，失败回落 textarea + `execCommand`），成功后 toast「已复制批注 Markdown」。不做文件写入（WebView 无可靠的保存对话框；E3 备份功能再统一处理导出文件）。

## 2. 数据与模块

| 模块 | 职责 |
| :--- | :--- |
| `core/marks.ts`（新增） | 纯函数：`relocateMarks`（批量重定位 + 失效）、`marksForDoc`、`orderMarks`（按块顺序）、`buildMark`、`marksToMarkdown` |
| `data/db.ts`（补） | `getMarksByDoc(docId)`（走 `by_doc` 索引） |
| `views/marks-render.ts`（新增） | 归一化文本索引、DOM↔偏移映射、`applyMarkHighlights`、`clearMarkHighlights`、`markAtPoint` |
| `views/selection.ts`（新增） | 自绘选区、选区工具条、标注动作条、重新挂载状态 |
| `views/marks.ts`（新增） | 批注列表面板（跳转/删除/失效/导出） |
| `views/note.ts`（新增） | 备注编辑面板（textarea） |
| `views/reader.ts` | 挂选区/渲染标注/更多菜单「批注」/标注点击 |
| `main.ts` | 标注载入与持久化、重定位、三个新浮层（marks/note）、查词与复制入口 |
| `core/types.ts` | `LayerKind` 增加 `marks` / `note`；action 增加 `mark/updated` |

## 3. 锚点生命周期

1. 打开文档 → 渲染完成 → 读取该文档标注 → 用 `relocate` 对每个锚点在最新块文本上重定位。
2. 重定位成功但偏移变化 → 更新锚点并持久化（下次直接命中第 1 档）。
3. 失败（块没了/原文没了/多处歧义）→ 内存中保留原锚点，列表标「失效」，正文不画；用户可删除或重新挂载。
4. 重新挂载：列表点「重新挂载」→ 关闭列表并记住目标标注 → 用户在正文选中新文字 → 工具条出现「挂载到此」→ 用新选区替换该标注锚点并持久化。

## 4. 明确不做（本项内）

- 标注的拖拽调整边界、多选批量删除（列表一次删一条；批量留给后续）。
- 全文 HTML/PDF 导出（E6）。
- 跨文档批注总览页（列表只列当前文档；导出也只导当前文档）。
- 原生系统选择菜单/手柄的接管（我们自绘选区，不接管系统 UI）。
- 标注与编辑原文（E5）冲突的完整合并流程：E5 之前只做重定位；E5 落地后再补编辑后的一致性处理。

## 5. 验收方式

- 单测：`core/marks.test.ts`（重定位、排序、Markdown 导出、buildMark）、`views/marks-render.test.ts`（归一化映射/命中/降级）、`views/marks.test.ts`（列表/失效/导出按钮）、`views/selection.test.ts`（选区提取与工具条动作）。
- smoke：程序化选区（Range + selectionchange 兼容路径）→ 工具条出现 → 点高亮 → 正文出现 Highlight（或标注数变化）→ 刷新后仍在 → 更多菜单打开批注列表 → 导出 toast。
- 截图：`npm run shot:e2`（工具条、四色标注、批注列表、备注面板）两套主题。
