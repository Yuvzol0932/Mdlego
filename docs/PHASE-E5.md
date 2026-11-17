# 阶段 E5 验收 · 编辑原文

> 设计说明见 `docs/DECISION-phase-E56.md` §1。任务书 E5：轻量编辑器 + 实时预览、保存回原文件、冲突检测（外部修改时提示合并/另存）。

## 1. 交付范围

- **编辑器页面**（`Page kind 'editor'`）：顶栏（返回 / 标题 / 保存）+ 分段（编辑 | 预览）+ 等宽字体 textarea + 实时预览（输入防抖 180ms，用与阅读页同一个 `renderMarkdown`）+ 底部字数/未保存状态。
- **未保存保护**：返回时若有改动，弹确认「放弃修改并返回 / 继续编辑」；保存按钮在有改动时可用、无改动时禁用。
- **保存回原文件**（原生 Android）：
  - 保存前重新读取原文件并算 sha256，与导入时指纹比对：一致 → 直接写回；不一致 → 返回 `conflict`，由编辑器弹「覆盖原文件（外部修改会丢失） / 存为应用内副本 / 取消」，**绝不静默覆盖**。
  - 原文件不存在 → `missing`；浏览器里拿不到原文件 → `no-original`，只提供「存为应用内副本」。
  - 写回成功更新文档正文/标题/指纹，并**同步重建当前阅读页渲染、重载批注锚点**；写失败退回副本并明确提示。
- **另存为副本**：新建 `source: inline` 的文档（保留标签/文件夹），提示「已存为应用内副本」并返回阅读页。
- 入口：阅读页「更多 → 编辑原文」。
- 文本归一化：去 BOM、CRLF→LF；只有换行差异不算修改。

## 2. 验收证据

| 项 | 结果 |
| :--- | :--- |
| `npm run verify` | 四道门禁 + 类型 + **605 条测试** + 构建全绿（E4 是 588，新增 17：core/editor 6、core/tts 5、core/export-html 3、settings 迁移 2 等） |
| `npm run smoke` | 真实 Chrome **128/128**（+12，覆盖 E5+E6）：打开编辑器（载入 415 字原文）→ 输入后显示「未保存」→ 预览显示新内容 → 保存时（浏览器无原文件）弹保存方式 → 选「存为应用内副本」→ 提示 → 副本出现在书架（2 篇） |
| `npm run shot:e56`（新增） | 两套主题 **11 项断言全过**，`docs/screenshots/E56/` 10 张（编辑器/预览/保存方式/护眼阅读页/朗读条，日/夜） |
| 无回归 | 批注/备份/查词/动效等既有用例全过 |

截图：`docs/screenshots/E56/e56-editor-*`、`e56-preview-*`、`e56-save-dialog-*`。

## 3. 与任务书差异 / 明确限制

1. **「合并」未做**：冲突时只提供「覆盖 / 另存副本 / 取消」，没有逐段 diff 合并编辑器（任务书写的是「提示合并/另存」，合并部分明确未实现）。
2. **浏览器环境不能写回原文件**：`<input type=file>` 导入的文件拿不到可写句柄；只提供应用内副本。原生 Android 走 M6 预留的 `writeDocument`（content:// URI，SAF 授权范围内）。
3. 保存后**不做字数统计/备份提示**；编辑历史不可撤销（WebView 原生 undo 可用）。
4. **未真机验证**：真机 `writeDocument` 路径未实际跑过（需要设备 + SAF 授权文件）。
5. 编辑导致锚点漂移的批注：保存后按既有重定位逻辑处理，失效项在批注列表标「失效」可重挂。

## 4. 改动文件

- `web/src/core/editor.ts` / `.test.ts`（新增）：文本/标题归一化、保存路径决策、指纹更新（6 测试）
- `web/src/views/editor.ts`（新增）：编辑器页面（编辑/预览/未保存保护/冲突弹层）
- `web/src/core/types.ts`（`Page` 增加 `editor`）、`core/nav.ts`（`pageKey` 支持 editor + `editorPage`）
- `web/src/views/app.ts`：`openEditor` / `saveEditedDoc` deps
- `web/src/main.ts`：`openEditor`、`saveEditedDoc`（读原文件快照 + sha256 + 写回 + 副本 + 阅读页重建）、页面宿主分支
- `web/src/views/reader.ts`：更多菜单「编辑原文」
- `web/src/styles/editor.css` + `index.html`
- `tools/smoke-chrome.mjs`、`tools/shot-e56.mjs`（`npm run shot:e56`）
- `docs/DECISION-phase-E56.md`、本文件、ARCHITECTURE §15、README
