# 阶段 E5/E6 设计说明

> E5：轻量编辑器 + 实时预览、保存回原文件、冲突检测。E6：TTS 朗读、护眼、屏幕常亮（已有）、导出 HTML/PDF。
> 两阶段一起做，因为都要碰阅读页菜单与设置，拆开会产生两次菜单/设置改动。

## 1. E5 · 编辑原文

### 1.1 页面而不是弹层

编辑器用 `Page kind 'editor'`（压栈页面），不是浮层：编辑需要整屏、需要返回键的未保存保护、需要与阅读页缓存共存。`pageKey` 用 `editor:<docId>`，宿主按页缓存。

### 1.2 保存路径（核心在这里）

```
保存前：读原文件（原生）→ 算 sha256 → 与文档指纹比对
  ├─ 一致            → 写回原文件 → 更新文档 text/title/fingerprint → 重建阅读页渲染 + 重载批注
  ├─ 不一致（conflict）→ 弹「覆盖原文件 / 存为应用内副本 / 取消」（auto 模式不写）
  ├─ 原文件不存在（missing）→ 只能存副本
  └─ 浏览器/无原文件（no-original）→ 只能存副本
写回失败 → 退回「存为应用内副本」并提示，不假装成功
```

- 纯决策在 `core/editor.ts::decideSave`（可单测）；IO 与指纹在 main + data 层。
- 指纹复用导入时的 `FileFingerprint{size,mtimeMs,sha256}`；写回成功后按新字节更新，避免下次误判冲突。
- 写回后的阅读页：`reader/ready` 重建渲染 + `loadMarksForDoc` 重定位批注；失效项在批注列表可见可重挂。
- **明确不做合并**：没有 diff/三方合并编辑器；冲突只给覆盖/副本/取消三选一。

### 1.3 浏览器降级

`<input type=file>` 导入的文件在浏览器里没有可写句柄 → `no-original`，只提供「存为应用内副本」。这是诚实降级，不是 bug。

## 2. E6 · 阅读增强

### 2.1 TTS

- 技术选型：Web Speech API（系统引擎）。不引第三方 TTS（包体/权限/离线都不划算）。
- 分块：`core/tts.ts` 按块文本切句（≤160 字），带 `bid` 便于高亮；代码块/空块跳过。
- 播放条：玻璃浮条（上一段/播放/下一段/速度/停止），放在阅读底栏上方；离开阅读页或读完自动销毁。
- 高亮：块级 `tts-current`（强调条 + 轻底色）并滚动到可见位置。**不做逐字同步**：`SpeechSynthesis` 的 word boundary 事件在 Android WebView 不可靠，不伪造进度。
- 失败：不支持/引擎报错都 toast 明确原因。

### 2.2 护眼模式

- 实现为固定覆盖层：`html[data-eyecare='1'] body::after`，`pointer-events:none` + `mix-blend-mode:multiply` + 主题各自的 `--eyecare-tint`。
- 为什么不改主题令牌：主题令牌影响玻璃/图表/导出等多处；覆盖层是「观感滤镜」，不改设计系统，也不影响布局、选区、批注坐标。
- 设置 schema 4 → 5（新增 `eyeCare` 默认 false），旧数据照常可读。

### 2.3 导出 HTML / PDF

- HTML：`core/export-html.ts` 纯函数生成独立文档（内嵌最小阅读排版）；颜色从当前主题令牌读取后传入（core 不硬编码色值，遵守 check:tokens）。下载 + 剪贴板双路径。
  - 图片若是外链/data URI 原样保留，不内嵌外部图片（避免导出文件巨大且依赖网络语义不清）。
- PDF：调用 `window.print()`，桌面 Chrome 可「另存为 PDF」；Android WebView 无打印服务时无对话框 —— toast 说明，不假装生成了文件。没有引入原生打印插件。

### 2.4 屏幕常亮

阶段 C5 已实现（Wake Lock + 设置开关）。E6 只做回归确认，不重复实现。

## 3. 验收

- 单测：`core/editor`（6）、`core/tts`（5）、`core/export-html`（3）、设置迁移 v4→v5（2）。
- smoke：编辑器打开/编辑/预览/保存方式/副本落库；护眼属性；朗读条；导出 HTML 提示；打印入口。
- 截图：`npm run shot:e56`（编辑器、预览、保存方式、护眼阅读页、朗读条，日/夜）。
