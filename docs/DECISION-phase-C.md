# 阶段 C · 设计说明与实现决策（开工前写下）

> 目的：把「界面要长成什么样、代码放在哪、什么不许碰」先钉死，避免 C1–C6 各自发明风格。
> 冲突时的优先级：任务书 v2 的验收标准 > 本文 > 现有代码注释。

## 1. 取色：从参考图取样，不再目测

`docs/design/reference.webp` 是 1536×1024 的合成图（含环境光与镜头虚化），所以对「大面积纯色区域」取量化众数、对「小面积强调色」按色相筛选取中位数，得到下表。**取色脚本在 `artifacts/ref/`（gitignored），可复现。**

| 令牌 | 旧值（目测） | 取样结果 | 新值 | 依据 |
|---|---|---|---|---|
| 夜间 `--paper` | `#191411` | 书架页底 `#1b1816` 带渐变 | `#1a1512` | 页面底中位色 |
| 夜间 `--paper-raised` | `#26201b` | 卡片 `#241f1d` | `#251f1b` | 卡片区域众数 |
| 夜间 `--accent` | `#e8b86d` | ＋按钮/进度条 `#f2bb79`、`#ebba79` | `#edb877` | 暖金筛选像素中位 |
| 日间 `--paper` | `#f5ebdc` | 页面底 `#f0e0c8`~`#f8e0c8` | `#f2e2cc` | 多区域众数 |
| 日间 `--paper-raised` | `#faf3e6` | 卡片/浮层应比页面更亮 | `#faf1e0` | 保守外推（图中无明确卡片） |
| 日间 `--ink` | `#2a2118` | 正文暗部中位 `#342619`，核心近黑 | `#2b2118` | 保持现有（对比度已测） |
| 日间 `--accent` | `#8a4b2a` | 引号/竖线为锈棕，取样受光晕污染 | `#93572e` | 目视 + 对比度复核 |

其它新增令牌（全部进 `tokens.css` / `tokens-themes.css`，其它文件不许出现色值）：

- `--noise`：64×64 base64 噪点 PNG，横幅/封面叠加（任务书 §3.4）。
- `--cover-1..8`：封面渐变色块（哈希取色，同一标题恒定），夜间/日间同一套深色艺术块，文字固定用 `--cover-ink`。
- `--quote-bg`：引用块底（`color-mix(accent 12%, paper-raised)`）。
- `--bar-dark` / `--on-bar-dark`：选词工具栏等「深色浮条」（参考图右机在日间也是深色浮条）。
- `--hero-scrim`：横幅图片上的暗角渐变（用户自定义横幅图时保证文字可读）。

## 2. 结构：底部导航是「页面的一部分」，不是全局浮层

- `Tab` 扩为 `shelf | search | stats | settings | kit`；阅读页是二级页，**不渲染底部导航**。
- 每个一级 tab 页自己渲染 `<nav data-testid="tabbar">`（页面缓存后 DOM 常驻，不重复创建）。
- 底部导航与顶栏同属「小面积悬浮层」：玻璃选择器统一加进 `glass.css` 的 `[data-material='glass']` 规则里。
- 同屏玻璃预算（硬约束 ≤ 3）：
  | 场景 | 层 |
  |---|---|
  | 书架/搜索/统计/设置 | 顶栏 + 底部导航 = 2；再开菜单/浮层 = 3 |
  | 阅读页 | 顶栏 + 阅读底栏 = 2；选词工具栏 或 Aa 面板 或 更多菜单 = 3（三者不同时开） |
  | 全屏图片 | 实色，不计 |

## 3. 浮层新增三种（仍走 `nav.layers` 唯一返回路径）

`LayerKind` 扩为 `toc | search | lookup | menu | typeset | image`。

- `menu`：锚定在触发按钮附近的小菜单（书架排序/视图、阅读更多）。内容不进 state（state 只记「开着」），由 main.ts 持有当前 `MenuSpec`。
- `typeset`：阅读页 `Aa` 底部面板（字号/行距/段距/字体/主题/背景）。
- `image`：正文图片全屏查看（双击/双指缩放）。

系统返回键 → `nav/back` → 先弹浮层，语义不变。

## 4. 文件布局（一眼能找到「这页的样式在哪」）

```
web/src/views/tabbar.ts        底部导航（5 项，中间凸起＋）
web/src/views/shelf.ts         书架（C2 重写为自管局部状态）
web/src/views/search.ts        全库搜索 tab（E1 的前置最小实现）
web/src/views/stats.ts         统计 tab（C6）
web/src/views/menu.ts          锚定菜单 + 菜单规格类型
web/src/views/typeset.ts       阅读 Aa 面板
web/src/styles/tabbar.css      C1
web/src/styles/shelf.css       C2
web/src/styles/reader-shell.css C3
web/src/styles/typography.css  C4（正文，由 typography 子任务交付）
web/src/styles/settings.css    C5
web/src/styles/stats.css       C6
```

`index.html` 按顺序在 `app.css` 之后逐个引入；**旧 `app.css` / `library.css` 里的过期类随页面替换逐步删除**，不留两套。

## 5. 交互契约（testid 是脚本与界面的接头，先定后写）

新增（`tools/shot-c.mjs`、`tools/smoke-chrome.mjs` 依赖）：

- 底部导航：`tabbar`、`tab-shelf`、`tab-search`、`tab-stats`、`tab-settings`、`import-file`（中间＋，沿用旧 id，导入链路不变）
- 书架：`shelf-hero`、`shelf-continue`、`shelf-grid`、`shelf-more`、`shelf-view-list`、`shelf-view-grid`、`shelf-sort-recent|name|imported`、`doc-item`（沿用）、`shelf-empty`（沿用）、`empty-import`（沿用）
- 阅读：`reader-more`、`open-typeset`（Aa）、`typeset-sheet`、`reader-progress`、`bookmark-toggle`、`open-toc`（移到 more 菜单内，沿用 id）、`open-search`（顶栏，沿用）、`back-to-shelf`（顶栏返回，沿用）
- 统计：`stats`、`stats-chart`

必须保留（既有脚本依赖）：`app-title`、`shell`、`shelf`、`doc-item`、`empty-import`、`reader-bar`、`open-toc`、`open-search`、`back-to-shelf`、`search-input`/`search-hit`/`search-close`、`toc-item`/`toc-drawer-close`、`type-scale-increase/decrease`（含 disabled 边界）、`theme-night`/`theme-magazine`/`theme-warm-night`/…、`build-version`/`build-id`、`toast`。

`smoke-chrome.mjs` 中「顶栏只有一个操作入口」「导入 FAB」两条断言按新设计改写（书架顶栏 = 品牌 + 搜索 + 更多；导入入口 = 底部导航中间＋）。

## 6. 验收方式（每页都要）

1. `npm run verify` 全绿；`npm run smoke` 全绿。
2. `npm run shot:c` → `docs/screenshots/C/`，两套主题各一张；脚本内断言：无横向溢出、玻璃层 ≤ 3、无未捕获错误、底部导航只在 tab 页、阅读页有底栏与进度。
3. 每页在 `docs/PHASE-C.md` 写「与参考图的差异清单」，**没做到的诚实写没做到**。
