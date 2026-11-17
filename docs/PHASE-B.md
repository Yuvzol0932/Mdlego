# 阶段 B · 设计系统与材质 —— 验收与差异清单

## 交付
- **B1 令牌**：`styles/tokens.css`（圆角 `--r-card/xl/media`、阴影、动效时长/缓动）+ `styles/tokens-themes.css`
  （7 套主题、8 色强调色盘×明暗两档、玻璃三档、动效强度）。主题色取自 `docs/design/reference.webp`，**目测校色，非逐像素取样**。
- **B2 组件**：`views/icons.ts` 图标精灵（30 个、2px 描边、`<use>` 引用）；`views/components.ts` 按钮/开关/分段/滑块/卡片/胶囊/色板/主题预览；样式 `styles/components.css`。
- **B3 玻璃**：`styles/glass.css`（唯一允许 `backdrop-filter` 的文件）。三档材质：玻璃 / 柔和半透明 / 纯色；不支持 `backdrop-filter` 时自动等同纯色；
  启动自检（核数 ≤4 或内存 ≤3GB）只**提示一次**建议切柔和，不擅自改设置。
- **B4 主题**：跟随系统（暖黑/米纸）、固定主题、强调色、玻璃强度滑块、动效强度；设置页「外观」区改动即时生效。
- **展示页** `#/kit`：仅 `npm run dev` / `--mode kit` 构建可见，正式构建里被摇树掉。
- 设置结构升级 v1→v2：旧数据可读，主题名原样保留，新字段落默认值（`settings-store.test.ts`）。

## 验收证据
| 项 | 结果 |
|---|---|
| `npm run verify` | 全绿，314 条测试 |
| 正文对比度 ≥ 4.5:1 | 7 个主题的 ink / ink-soft 在纸面与卡片上均通过；8 色强调色×明暗按钮文字 ≥ 4.5，强调色在纸面 ≥ 3（`contrast.test.ts`） |
| 纯色档无 `backdrop-filter` | 静态：`check:tokens` 新规则（只许在 glass.css 且限定 `[data-material='glass']`）；运行时：真实 Chrome 统计，柔和/纯色档 0 层 |
| 同屏玻璃层 ≤ 3 | 真实 Chrome：玻璃档 3 层 |
| 各主题截图 | `docs/screenshots/B/`（`npm run shot:kit` 可复现） |

## 与参考图的差异（B 阶段范围内）
1. 取色是目测，不是逐像素取样；差异需要你对照确认。
2. 噪点纹理、横幅渐变、封面色块、底部导航、阅读底栏、选词工具栏都属阶段 C，本阶段只做了材质与组件底座，**界面本身还没变**。
3. 玻璃效果目前只落在现有吸顶/吸底条与 kit 演示件上；底部导航等新构件在 C 阶段接入。
4. `--ease-spring` 在不支持 `linear()` 的 WebView 回落为 standard。
5. 「动效：简约」目前只有令牌，区分逻辑在阶段 D 的 `motion.ts`。
6. 未在真机验证（含低端机玻璃表现）。
