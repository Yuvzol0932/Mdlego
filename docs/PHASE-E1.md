# 阶段 E1 验收 · 全库搜索增强 + 书架筛选/标签/收藏/文件夹

> 设计取舍见 `docs/DECISION-phase-E.md`。本文记录交付范围、证据、与任务书的差异。
> 任务书 §6 阶段 E 要求「逐项独立可发布」，E1 是第一个可单独发布的增量。

## 1. 交付范围

### 1.1 全库搜索（增强）

- **按文档分组**：每篇文档一条分组（标题 + 命中数 + 展开箭头），组内最多展示 3 条片段，其余概括成「还有 N 处」。
- **关键词高亮**：片段按关键词切成普通/命中片段，命中用 `<mark>`（DOM 文本节点渲染，安全）。
- **范围筛选**：「全部文档 / 仅收藏」两个 chip，带计数；仅收藏时只保留收藏文档的命中。
- **诚实空态**：空库引导导入；无结果 `没有找到「q」`；仅收藏无结果 `收藏里没有找到「q」`；上限提示仍然明确。
- 纯函数：`core/search.ts` 新增 `groupHitsByDoc` / `highlightSegments`（不碰 DOM，单测覆盖）。

### 1.2 书架筛选 / 标签 / 文件夹

- **筛选条**：`全部 N / 收藏 N / #标签 N / 文件夹 N`，横向滚动；单选，点已选回「全部」；筛选后仍可排序、网格/列表切换。
- **筛选空态**：`这个筛选下还没有文档。` + 一键「清除筛选」，不是白屏。
- **标签**：多标签（每篇最多 12 个、单个 ≤24 字符、大小写不敏感去重）；长按多选 → 「标签」面板：已有标签三态 chip（全有/部分/没有），点击加或减；输入框新建（非法输入禁用提交）。
- **文件夹**：**单层**文件夹（≤40 字符）；同一面板选一个移入，或「移出文件夹」；筛选条按文件夹过滤。
- **数据**：`Doc.tags?` / `Doc.folder?` 为可选字段；读库时 `normalizeLibraryDoc` 补默认值并归一化；写回时只写真正变化的文档。
- **为什么没有 DB 版本升级**：没有新增仓库/索引，只给文档记录加可选字段；旧记录读出来归一化成 `[]/null`，不需要迁移事务（`db-migration.test` 仍覆盖 v1→v2 历史路径）。

### 1.3 一个被截图抓出来的 bug（已修）

标签面板的「移出文件夹」按钮用 `hidden` 属性隐藏，但 `.ui-btn { display: inline-flex }` 覆盖了浏览器默认的 `[hidden]{display:none}` —— 标签模式下按钮仍然显示。
修法：`app.css` 增加 `[hidden] { display: none !important; }` 全局兜底（长按选择条等其它用 `hidden` 的组件同样受益），重新截图确认。

## 2. 验收证据

| 项 | 结果 |
| :--- | :--- |
| `npm run verify` | 四道门禁 + 类型 + **498 条测试** + 构建全绿（阶段 D 是 462，新增 36：core/library 20、core/search 分组与高亮 9、views/search 6、views/collection 6、views/shelf 筛选 4，另含少量联动调整） |
| `npm run smoke` | 真实 Chrome 393×873 **80/80**（原 69 + 新增 11）：长按多选 → 标签面板 → 写标签 → 筛选条出现标签 chip → 按标签筛选 → 再点回全部；搜索分组/范围 chip/仅收藏文案 |
| `npm run shot:e`（新增） | 两套主题 **15 项断言全过**：`docs/screenshots/E/` 10 张（筛选条、标签筛选、标签面板、文件夹面板、搜索分组 × 日/夜） |
| 无回归 | 阶段 A–D 的 `verify`/`smoke`/`verify:motion` 用例未改，全部仍绿 |

截图：`docs/screenshots/E/e-shelf-filters-*`、`e-collection-tags-*`、`e-collection-folder-*`、`e-search-grouped-*`（`warm-paper` / `warm-night`）。

## 3. 与任务书的差异 / 明确没做

1. **文件夹是单层**（不做嵌套/拖拽归档）：任务书只写「文件夹」，单层足够表达「课程/项目」，嵌套会带来路径迁移与面包屑成本；已在 DECISION 记录。
2. **没有全局标签管理页**：标签在面板里随文档增删，不再单独维护一套标签库；全局整理留给 E3 备份/恢复一起考虑。
3. **搜索仍是按需渲染 + 内存匹配**（不建索引）：避免与 E5 编辑原文的一致性风险；结果上限与提示沿用 C1 策略。
4. **标签面板是「即时生效」而不是「保存」**：每次点击立即落库，面板随 state 重建选中态；写库失败会 toast 提示并且不改 UI 成功态。
5. **未真机验证**：与 C/D 相同，只有 headless Chrome 的断言与截图。

## 4. 改动文件

- `web/src/core/library.ts` / `.test.ts`（新增）：标签/文件夹归一化、筛选、三态、批量变更（纯函数）
- `web/src/core/search.ts`：新增分组与高亮纯函数；`search.test.ts` 补 9 条
- `web/src/core/types.ts`：`Doc.tags?` / `Doc.folder?`，`LayerKind` 增加 `collection`
- `web/src/data/library.ts`：`loadShelf` 读出后归一化（旧文档补默认值）
- `web/src/views/collection.ts` / `.test.ts`（新增）：标签/文件夹面板
- `web/src/views/layers.ts`：`collection` 浮层（含下拉关闭与转场）
- `web/src/views/shelf.ts`：筛选条、筛选空态、多选「标签/文件夹」入口、签名包含 tags/folder/bookmarks
- `web/src/views/search.ts`：分组/高亮/范围筛选（重写渲染层）
- `web/src/main.ts`：集合面板状态、批量写库（`doc/updated` + `saveDoc`）、deps 与浮层接线
- `web/src/styles/{app,shelf,search,reader-shell}.css`：`[hidden]` 兜底、筛选 chip、分组结果、标签面板
- `tools/smoke-chrome.mjs`（+11 项）、`tools/shot-e.mjs`（新增，`npm run shot:e`）
- `docs/DECISION-phase-E.md`、本文件、`docs/ARCHITECTURE.md` §11、README
