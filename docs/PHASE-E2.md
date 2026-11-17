# 阶段 E2 验收 · 划词批注

> 设计说明见 `docs/DECISION-phase-E2.md`。本阶段在 M3 冻结的 core 锚点能力上补齐了**选区、渲染、数据链路、列表与导出**。

## 1. 交付范围

### 1.1 选区与工具条

- **自绘选区**：长按 500ms 选中英文词（`wordRangeInText`）；按住拖动选择任意范围（可跨块）。不依赖系统 ActionMode，也不改正文 DOM。
- 选区可视化与标注共用 CSS Custom Highlight API（`::highlight(mdlego-selection)`）。
- 松手弹工具条（深色胶囊，参考图样式，位置按选区矩形算并夹在视口内）：
  **四色高亮（黄/绿/蓝/粉）· 下划线 · 删除线 · 批注 · 查词 · 复制**；处于「重新挂载」等待态时多一个「挂载到此」。
- 兼容路径：桌面/自动化的原生选区（`selectionchange`）同样会弹条 —— smoke 与截图脚本走这条路径。
- 工具条出现有 220ms 上浮+缩放动效，走 `--anim-toolbar-in` 与动效三档退化（simple 只淡入、off 不动）。

### 1.2 标注渲染与锚点

- 渲染：`marks-render.ts` 把锚点偏移（相对 `blockTexts`，空白折叠坐标系）映射到 DOM Range，分 7 组写 `CSS.highlights`：四色高亮 / 下划线 / 删除线 / 批注（批注=高亮+虚线下划线）。**不往正文插节点**，不破坏阶段 A 的「正文只重建一次」铁律。
- 锚点：`data-bid` + 块内偏移 + 原文/前后文；打开文档后自动 `relocate`，偏移变化会持久化新锚点。
- 失效：块删除/原文找不到/多处歧义 → 不静默丢弃，列表标「失效」并给「重新挂载」入口（选中新文字 → 挂载到此，替换该标注锚点）。
- 点击已有标注：`caretRangeFromPoint` 命中 → 动作条（删除 / 编辑备注 / 复制原文）。
- 降级：不支持 CSS Highlight API 的环境不画内联标注（不伪造），列表与导出仍可用；`applyMarkHighlights` 返回 `supported:false` 供后续提示。

### 1.3 批注与列表

- 新建批注：选区 → 工具条「批注」→ 备注面板（原文预览 + 500 字上限 + 字数计数）→ 保存后生成本文标注并落库。
- 阅读页「更多 → 批注」打开列表：按块顺序列出类型/原文/备注，点击跳转；删除；失效项重新挂载；顶部「导出」。
- 导出 Markdown：`core/marks.ts::marksToMarkdown`（标题 + 每条 `[类型] 原文` + 备注；失效条目标注），写剪贴板并 toast。headless 下剪贴板可能被拒，提示失败而不是假装成功。

### 1.4 交互变化（重要）

M5 的「长按自动弹查词卡片」改为 **长按/拖选弹工具条，工具条里有「查词」**（与参考图右机一致）。设置里的「长按查词」开关现在控制**工具条上是否出现查词按钮**；关掉后长按仍然可以选词做标注。查词卡片本身（释义、音标、词形提示、库外词提示）逻辑未改。

## 2. 验收证据

| 项 | 结果 |
| :--- | :--- |
| `npm run verify` | 四道门禁 + 类型 + **564 条测试** + 构建全绿（阶段 E1 是 498，新增 66：core/marks 28、views/marks-render 26、views/selection 6、views/marks 4、views/note 2） |
| `npm run smoke` | 真实 Chrome 393×873 **92/92**：新增 12 项覆盖「程序化选区→工具条→黄色高亮→下划线→批注备注→批注列表 3 条→导出提示→刷新后标注仍在（持久化+重定位）」 |
| `npm run shot:e2`（新增） | 两套主题 **21 项断言全过**，`docs/screenshots/E2/` 10 张（工具条 / 标注效果 / 备注面板 / 动作条 / 批注列表） |
| 无回归 | `npm run smoke` 既有 80 项（含 E1 标签）仍全过；`verify:motion` 的动效契约未改 |

截图：`docs/screenshots/E2/e2-toolbar-*`、`e2-annotations-*`、`e2-note-*`、`e2-mark-actions-*`、`e2-marks-list-*`（日/夜各一套）。

## 3. 与任务书差异 / 明确没做

1. **选区是自绘的**（拖选 + 长按取词），没有接管系统选择手柄；不支持「拖拽调整已有标注边界」。
2. **列表只列当前文档**，不跨文档汇总；导出也只导当前文档（跨库批注总览留给后续）。
3. **导出走剪贴板**：WebView 没有可靠的「另存为」对话框；E3 备份会统一处理文件导出。
4. **内联标注依赖 CSS Highlight API**（Chrome 105+ / 现代 WebView）。老 WebView 上正文不画标注，但列表/删除/导出可用，属于明确降级。
5. **没做标注与编辑原文（E5）的合并冲突**：E5 落地前只依赖重定位；失效时人工重挂。
6. **未真机验证**：与 C/D/E1 相同，只有 headless Chrome 断言与截图。

## 4. 改动文件

- `web/src/core/marks.ts` / `.test.ts`（新增）：批量重定位、排序、构建、中文类型名、Markdown 导出（28 测试）
- `web/src/core/types.ts`：`LayerKind` 增加 `marks` / `note`；action `mark/updated`
- `web/src/data/db.ts`：`getMarksByDoc`（by_doc 索引）
- `web/src/data/clipboard.ts`（新增）：剪贴板 + 降级
- `web/src/views/marks-render.ts` / `.test.ts`（新增）：归一化索引、高亮绘制、命中（26 测试）
- `web/src/views/selection.ts` / `.test.ts`（新增）：自绘选区、工具条、动作条（6 测试）
- `web/src/views/marks.ts` / `.test.ts`（新增）：批注列表与导出入口（4 测试）
- `web/src/views/note.ts` / `.test.ts`（新增）：备注面板（2 测试）
- `web/src/views/{reader,layers,app}.ts`：正文绑定选区/高亮、更多菜单「批注」、marks/note 浮层、deps
- `web/src/main.ts`：标注载入/重定位/增删改持久化、三个新浮层、重新挂载、导出与复制、查词入口
- `web/src/views/lookup.ts`：导出 `lookupWord`（工具条查词），长按不再自动弹卡
- `web/src/styles/marks.css`（新增）：7 组 `::highlight`、工具条、列表、备注面板；`tokens.css` 增 `--anim-toolbar-in`，`motion.css` 增 `sel-toolbar-in`
- `web/index.html`：挂 marks.css
- `tools/smoke-chrome.mjs`（+12）、`tools/shot-e2.mjs`（新增，`npm run shot:e2`）
- `docs/DECISION-phase-E2.md`、本文件、ARCHITECTURE §12、README、MOTION 第 7 项
