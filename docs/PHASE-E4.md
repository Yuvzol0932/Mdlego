# 阶段 E4 验收 · 查词完善

> 设计说明见 `docs/DECISION-phase-E4.md`。

## 1. 交付范围

- **玻璃底查词卡片**：M5 的释义卡片改为 `glass` 底部面板（圆角上沿、顶部把手、遮罩关闭、返回键可关），头部新增**生词本按钮**（未收藏/已收藏两态）。
- **生词本**：查词时一键收藏（重复收藏更新时间不重复占位）；设置 → 查词 →「生词本 N 个」打开浮层：单词/音标/释义/删除/清空；上限 500、按收藏时间倒序。
- **查词历史**：每次查词成功自动记录（同词只留最近一次、最新在前、上限 100）；设置 →「查词历史 N 条」打开浮层，可清空。
- **数据存放**：IndexedDB `meta` 的 `wordbook` / `lookupHistory` 键；读写都过 `core/vocabulary.ts` 归一化，脏数据过滤不崩界面。不新增 DB 仓库/版本。
- **词库加载失败降级**：`lookup()` 抛错不再伪装成「未收录」，改为红色提示「词库加载失败，点此重试「word」」，可点击重试。
- **备份联动**：`BACKUP_SCHEMA_VERSION` 升到 **2**，备份含 `vocabulary`；v1 旧备份仍可恢复（缺少字段视为空），生词本损坏明确拒绝；恢复时生词本一并覆盖并同步回 state。

## 2. 验收证据

| 项 | 结果 |
| :--- | :--- |
| `npm run verify` | 四道门禁 + 类型 + **588 条测试** + 构建全绿（E3 是 574，新增 14：core/vocabulary 7、views/wordbook 5、backup 增 2） |
| `npm run smoke` | 真实 Chrome **116/116**（+13）：选中 `inspect` → 查词卡片（单词+释义+玻璃面板）→ 收藏生词提示 → 设置显示生词本 1 / 历史 1 → 生词本面板含 inspect → 历史含 inspect；E3 段新增断言「备份为 schemaVersion 2 且含 vocabulary」 |
| `npm run shot:e4`（新增） | 两套主题 **13 项断言全过**，`docs/screenshots/E4/` 6 张（查词卡片、生词本、历史，日/夜） |
| 无回归 | 划词批注、备份恢复、标签筛选、动效验收用例仍全过 |

截图：`docs/screenshots/E4/e4-lookup-card-*`、`e4-wordbook-*`、`e4-history-*`。

## 3. 与任务书差异 / 明确限制

1. **不提供单词发音**：没有音频资源，不放假的播放按钮。
2. **无复习/错题本/记忆曲线**、无生词本导出（Anki/Markdown）——备份 JSON 已有全部数据。
3. **历史条目不可跳回原文**：历史只存单词与时间，不存锚点；点击不做事，避免「跳过去找不到」的伪交互。
4. **生词本存 meta 而不是独立仓库**：千级以内够用，避免为预览版升 DB 版本；数据量增长后再迁移（备份 schema 已预留字段）。
5. **查词历史不进备份**（任务书只要求生词本）。
6. **未真机验证**（同 C/D/E1–E3）。

## 4. 改动文件

- `web/src/core/vocabulary.ts` / `.test.ts`（新增）：归一化、去重、上限、历史（7 测试）
- `web/src/core/backup.ts` / `.test.ts`：schemaVersion 2 + vocabulary、v1 兼容、损坏拒绝
- `web/src/data/vocabulary.ts`（新增）：meta 读写
- `web/src/data/backup.ts`：收集/恢复带上生词本
- `web/src/core/types.ts` / `state/store.ts`：`words` / `lookupHistory` 状态与 actions
- `web/src/views/lookup.ts`：玻璃底卡片、生词按钮、历史钩子、词库失败降级
- `web/src/views/wordbook.ts` / `.test.ts`（新增）：生词本/历史浮层（5 测试）
- `web/src/views/{layers,settings,app}.ts` / `main.ts`：wordbook 浮层、设置入口、收藏/历史/清空/切分段接线
- `web/src/styles/{dict,wordbook}.css` + `index.html`：玻璃卡片、生词按钮、失败提示、生词本样式
- `tools/smoke-chrome.mjs`（+13）、`tools/shot-e4.mjs`（新增，`npm run shot:e4`）
- `docs/DECISION-phase-E4.md`、本文件、ARCHITECTURE §13 修订 + §14、README
