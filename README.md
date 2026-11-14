# 墨读 Mdlego

一个**完全离线**的 Android Markdown 阅读器。为「英语备考笔记 + 学习计划」这类每天要反复翻、反复画重点的文档而做。

> 当前进度：**M0 已完成**。工程底座与验证流水线全部跑通，业务功能从 M2 开始接入。

---

## 现在能做什么

**还不能读你自己的文件** —— 这一版是空壳，只验证了一件事：

> 写代码 → 编译 APK → 装进 Android → 截图核对 → 反读 APK 版本号 —— 整条链路是通的。

这一点很重要。上一代项目正是栽在「以为通了其实没通」上：版本号散落六处、
覆盖安装后界面不变、真机 bug 在测试里全绿放行。本项目在写第一行业务代码之前，
先把这些结构性问题解决掉。

---

## 目标功能（按里程碑推进）

| 里程碑 | 内容 | 状态 |
| :--- | :--- | :--- |
| M0 | 工程底座、四道机器门禁、APK 流水线 | ✅ 已完成 |
| M1 | 三份视觉方案（同一篇真笔记的对比截图） | 待做 |
| M2 | **能读**：书架、导入、渲染、目录、单篇搜索、字号行距主题、进度记忆 | 待做 |
| M3 | **批注**：划词高亮/下划线/删除线/批注、锚点重定位、任务勾选 | 待做 |
| M4 | **找得到**：全库搜索、备份导出/导入 | 待做 |
| M5 | **查词**：10 万词条离线词库 | 待做 |
| M6 | **能改**：编辑原文并保存回原文件、冲突检测 | 待做 |

---

## 技术选型

| 项 | 选择 | 为什么 |
| :--- | :--- | :--- |
| 壳 | **Capacitor 8** | WebView 渲染 + 原生能力按需接入；无需为「读文件」写整套原生 UI |
| 渲染 | **markdown-it 15** | CommonMark + GFM 覆盖面足够；`html:false` 保证原文里的 HTML 只转义不执行 |
| 构建 | **Vite 8 + TypeScript 5.9** | 内容哈希文件名，从结构上消灭「忘了改版本号」 |
| 测试 | **Vitest 5 + 真实 Chrome + Android 模拟器** | 三层验证，不拿 mock 冒充真机 |
| 依赖 | 运行时零第三方（除 Capacitor 与 markdown-it） | 体积可控、供应链面小 |

---

## 开发

```bash
npm install

npm run dev        # Vite 开发服务器
npm run verify     # 四道门禁 + 类型检查 + 单测 + 构建
npm run smoke      # 真实 Chrome（小米 14 Pro 尺寸 + 触摸模拟）冒烟 + 截图
npm run android:build     # 构建 Web → 推送 → Gradle 打包 → aapt2 反读校验
npm run android:install   # 装进模拟器并截图
```

### 四道机器门禁

这些不是文档里的约定，而是会**让构建失败**的检查：

| 命令 | 拦截什么 |
| :--- | :--- |
| `check:boundaries` | `core` 反向依赖 `data`/`views`；`views` 直接碰 `indexedDB` |
| `check:state` | 视图层直接给 `state` 字段赋值（绕过 dispatch） |
| `check:selectors` | 用裸 CSS 选择器找节点（改样式就打断逻辑） |
| `check:tokens` | 硬编码颜色值（换主题时要改五十处） |

四条都逐一注入过违规，确认确实会以退出码 1 失败 —— 不是仪式。

---

## 环境要求

| 依赖 | 版本 | 备注 |
| :--- | :--- | :--- |
| Node.js | `^22.22.2 \|\| ^24.15.0 \|\| >=26` | 已验证 24.19.0 |
| JDK | 21 | 已验证 Temurin 21.0.12 |
| Android SDK | Platform 36 + Build Tools 36 | 见下方说明 |
| Gradle | 8.14.3 | 本地有缓存则直接复用，不走 wrapper 下载 |

**两套 SDK 的坑**：Android Studio 自带的 SDK 只有 `android-37.0`（预览命名），
AGP 8.13 不认，会报 `Failed to find target with hash string 'android-37'`。
本项目固定使用 `D:\Workbuddyspace\.android-sdk`（含 android-36），
路径写在 `android/local.properties`。

**中文路径**：工程位于含中文的目录，依赖 `android/gradle.properties` 中的
`android.overridePathCheck=true`。

---

## 已知限制

- 当前是空壳，只能显示一篇内置示例文档
- 未接入文件导入、标注、查词、编辑
- 最低支持 Android 8.0（API 26），目标 API 36

---

## 数据与隐私

**本应用不申请 `INTERNET` 权限。** 没有任何联网请求、没有账号、没有统计。
笔记与标注只存在本机 IndexedDB，换设备靠导出备份文件。

---

## License

[MIT](LICENSE)。离线词库将来自 [ECDICT](https://github.com/skywind3000/ECDICT)（MIT）。
