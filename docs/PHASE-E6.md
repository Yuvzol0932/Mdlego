# 阶段 E6 验收 · 阅读增强

> 设计说明见 `docs/DECISION-phase-E56.md` §2。任务书 E6：系统 TTS 朗读（若可用）、护眼模式、屏幕常亮、导出 HTML/PDF 分享。

## 1. 交付范围

- **系统 TTS 朗读**（`views/tts.ts` + `core/tts.ts`）：
  - 用 Web Speech API（系统 TTS 引擎，不联网、不引库）；按块文本切句（≤160 字，带 `bid`）排队朗读。
  - 阅读页「更多 → 朗读」出现玻璃播放条：上一段 / 播放-暂停 / 下一段 / 速度（0.8/1/1.2/1.5×）/ 停止；当前块加 `tts-current`（左侧强调条）并滚动到可见位置。
  - **不可用时明确提示**（无 `speechSynthesis` → 「当前系统不支持朗读」；引擎报错 → 「朗读失败：xxx」），不假装播放。
- **护眼模式**：设置 → 阅读 →「护眼模式」开关；`html[data-eyecare='1']` 叠一层固定暖色覆盖（`pointer-events:none`、`mix-blend-mode:multiply`），**不改布局/滚动/选区/批注坐标**；日/夜主题各一组暖色令牌。
- **屏幕常亮**：阶段 C5 已实现（Wake Lock + 设置开关），本阶段确认未回归（smoke 设置页断言仍过）。
- **导出 HTML**：阅读页「更多 → 导出 HTML」把当前已渲染正文 + 内嵌排版样式打成独立单文件 HTML（标题、日/夜纸面与墨色取自当前主题令牌），下载并复制到剪贴板双路径，提示明确。
- **打印 / 导出 PDF**：菜单项调用 `window.print()`（桌面 Chrome 可另存 PDF）；Android WebView 无打印服务时不会弹窗，toast 已说明这一点 —— 不伪造「已生成 PDF」。
- 设置 schema 升到 **5**（新增 `eyeCare`，旧数据默认关闭），迁移单测覆盖。

## 2. 验收证据

| 项 | 结果 |
| :--- | :--- |
| `npm run verify` | 四道门禁 + 类型 + **605 条测试** + 构建全绿（新增 core/tts 5、core/export-html 3、设置迁移 2） |
| `npm run smoke` | 真实 Chrome **128/128**：护眼开关写/清 `data-eyecare`；朗读入口出现播放条（headless 无语音 → 明确「朗读失败：not-allowed」而不是静默）；导出 HTML 提示；打印入口存在 |
| `npm run shot:e56` | 两套主题 **11 项断言全过**，`docs/screenshots/E56/` 含护眼阅读页与朗读条 |
| 无回归 | `smoke` 既有 116 项 + 新增 12 项全过 |

截图：`docs/screenshots/E56/e56-reader-eyecare-*`、`e56-tts-*`。

## 3. 与任务书差异 / 明确限制

1. **PDF 依赖系统打印**：WebView 无打印服务时 `window.print()` 无效果；没有引入原生打印插件，不做「导出 PDF 文件」的假承诺。
2. **TTS 音色/语言取决于系统引擎**：只设置 `lang`（中/英）与语速，不提供音色选择；部分系统 TTS 未安装中文语音时会失败，界面给明确错误。
3. 朗读高亮是**块级**（整段强调），不是逐字同步（Web Speech API 没有稳定的 word boundary 事件，Android WebView 可靠性未知）。
4. 护眼是**覆盖层**，不改变主题令牌本身；截图/导出 HTML 不包含护眼层（导出取当前主题墨色）。
5. **未真机验证**：TTS 与打印都未在真机跑过。

## 4. 改动文件

- `web/src/core/tts.ts` / `.test.ts`（新增）：分句/分块/时长估算（5 测试）
- `web/src/core/export-html.ts` / `.test.ts`（新增）：独立 HTML 生成（3 测试，颜色由调用方传入）
- `web/src/views/tts.ts`（新增）：朗读播放条与 SpeechSynthesis 控制
- `web/src/views/reader.ts`：更多菜单「朗读 / 导出 HTML / 打印 / PDF」+ 播放条生命周期
- `web/src/core/types.ts` / `core/typography.test.ts`：`Settings.eyeCare`
- `web/src/data/settings-store.ts`：schemaVersion 5 + 迁移/校验
- `web/src/views/settings.ts`：护眼模式开关
- `web/src/main.ts`：`data-eyecare` 属性、`exportHtml`（读主题令牌 → 导出）、`printDocument`
- `web/src/styles/{tokens,tokens-themes,editor}.css` + `index.html`：护眼覆盖层、播放条样式
- `tools/smoke-chrome.mjs`、`tools/shot-e56.mjs`
- `docs/DECISION-phase-E56.md`、本文件、ARCHITECTURE §16、README
