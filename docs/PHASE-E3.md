# 阶段 E3 验收 · 备份与恢复

> 设计说明见 `docs/DECISION-phase-E3.md`。

## 1. 交付范围

- **导出备份**：设置页「备份与恢复 → 导出」生成 JSON（文档/批注/进度/任务/阅读会话/设置/收藏），同时触发下载并写入剪贴板；提示写清两条路径。文件名 `mdlego-backup-YYYY-MM-DD.json`。
- **从文件恢复**：选择 `.json`（文件选择器）→ 校验 → 确认层（显示将覆盖的文档/批注数）→ 覆盖写入 → 状态原地刷新 + 提示。
- **从剪贴板恢复**：读剪贴板 JSON 走同一套校验/确认/写入；不支持读剪贴板的环境给明确提示。
- **校验与版本**：`format` + `schemaVersion` + `checksum`（FNV-1a 32 over 规范序 data）；未来版本明确拒绝；损坏/手改/结构缺失都有可读原因。
- **恢复语义**：单事务清空 `docs/marks/tasks/sessions` 后写入；`bookmarks` 与设置一并覆盖；失败原子回滚并提示。
- **WebDAV**：明确**不做**，设置页写清原因（应用不申请 INTERNET 权限、离线优先），没有留下不可用开关。
- 生词本：E4 未实现，备份 schema 里**没有空占位**（DECISION 已写明 E4 时升 schemaVersion 2）。

## 2. 验收证据

| 项 | 结果 |
| :--- | :--- |
| `npm run verify` | 四道门禁 + 类型 + **574 条测试** + 构建全绿（E2 是 564，新增 `core/backup` 10 条） |
| `npm run smoke` | 真实 Chrome **103/103**（+11）：导出提示 → 剪贴板读回含 `format/docs/marks/settings` → 恢复确认层写明范围 → **恢复成功提示「已恢复备份：1 篇文档 / 3 条批注」** → 文档仍在 → 损坏 JSON 被拒且不弹确认 |
| `npm run shot:e3`（新增） | 两套主题 **9 项断言全过**，`docs/screenshots/E3/` 4 张（备份分区、恢复确认层，日/夜） |
| 无回归 | E1/E2 的 smoke 段（标签、划词批注）仍全过；`verify:motion` 契约未改 |

截图：`docs/screenshots/E3/e3-backup-section-*`、`e3-restore-dialog-*`。

## 3. 过程中修掉的真实问题（smoke 抓到）

1. `data/backup.ts::applyBackupData` 在事务后 `db.close()`，而 `db.ts` 的 `openDb()` 返回**模块级缓存的连接** —— 关掉后立刻报 `database connection is closing`，恢复实际失败但 toast 文案里含「恢复」误通过断言。修：不关闭共享连接；断言收紧为必须包含「已恢复」。
2. 恢复最初用 `location.reload()`，headless 下提示时序不可靠（抓不到 toast）且闪屏。改为写入后按备份内容 dispatch + `refreshStats()`，原地刷新，smoke 可稳定断言。

## 4. 与任务书差异 / 明确限制

1. **WebDAV 未提供**（理由见 DECISION §4：不申请 INTERNET 权限的离线承诺）。
2. **导出是「下载 + 剪贴板」双路径**，不保证一定落成文件：WebView 对 Blob 下载支持不一致；设置页提示两条路径，不假装文件一定保存成功。
3. **恢复是整库覆盖**：没有选择性恢复/增量/多版本历史/加密。
4. **生词本不在备份里**：E4 才落地；届时升 schemaVersion 2 并把旧备份缺失字段视为空。
5. **未真机验证**：同 C/D/E1/E2，只有 headless 断言与截图。

## 5. 改动文件

- `web/src/core/backup.ts` / `.test.ts`（新增）：格式、规范序、校验和、解析校验（10 测试）
- `web/src/data/backup.ts`（新增）：收集本机数据、单事务覆盖恢复
- `web/src/main.ts`：导出（下载 + 剪贴板）、文件/剪贴板导入、确认弹层、恢复写入与状态刷新、deps
- `web/src/views/settings.ts`：设置页「备份与恢复」分区（导出 / 从文件 / 从剪贴板 / WebDAV 说明 + 隐藏 file input）
- `web/src/views/app.ts`：`exportBackup` / `importBackupFile` / `importBackupClipboard` 三个 deps
- `tools/smoke-chrome.mjs`（+11）、`tools/shot-e3.mjs`（新增，`npm run shot:e3`）
- `docs/DECISION-phase-E3.md`、本文件、ARCHITECTURE §13、README
