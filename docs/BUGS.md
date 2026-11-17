# BUGS —— 阶段 F1 缺陷清单（真机走查）

> 设备：小米 M2102K1C（Android 14 / HyperOS，1440×3200，DTS 3.5，cutout 高 137px，圆角 196px）
> 安装包：`Mdlego-1.0.0-rc.1-E-preview.apk`（versionName 1.0.0-rc.1 / versionCode 1000051，debug 签名）
> 旧数据：0.1.0（versionCode 100）原地升级，升级前整目录备份到 `artifacts/device-backup-0.1.0/mdlego-0.1.0-data.tar`（7.9 MB，含 IndexedDB）
> 走查方式：真机 WebView + `adb forward` → CDP（`tools/device-eval.mjs`），屏幕锁定时也能读 DOM/截图；需要系统注入的操作（点击文件选择器、返回键、旋转、字体缩放）见「阻塞」一节
> 证据截图：`docs/screenshots/F/`

## 一、已验证通过（真机）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 0.1.0 → 1.0.0-rc.1 原地升级 | 安装成功，versionCode 100 → 1000051；5 篇旧文档、进度、设置全部可读，无迁移报错 | `02-shelf-home.png` |
| 书架首屏 | 横幅轮播 / 继续阅读 / 三列网格 / 底部五项导航 / 中间＋，无横向溢出，玻璃层 2 个 | `02-shelf-home.png` |
| 冷启动耗时 | 620 ms（`am start -W`） | — |
| 打开阅读页 | 顶栏、正文、底栏、进度文案正常；正文段落 17.5px/行高 32.9px | `03-reader-top.png` |
| 滚到底 | 最后一段不被底栏遮挡（`lastBottom=689 < barTop=852`） | `04-reader-bottom.png` |
| Aa 排版面板 | 字号 1–7 档：17.5px → 24.5px 即时生效；行距/段距/字体/主题齐备 | `05-typeset.png`、`06-typeset-max.png` |
| 主题切换 | 暖黑生效（body `rgb(26,21,18)`，正文 `rgb(239,230,216)`），重开后保持 | `07-reader-dark.png`、`26-relaunch-reader.png` |
| 文内搜索 | 「spect」命中 4 处，点击第 3 条跳转 341→539px，浮层关闭，命中块 flash，进度 58% | `08-search-layer.png`、`09-search-results.png`、`10-search-jump.png` |
| 目录 | 4 条（1 个 h1 + 3 个 h2，带层级），点第 4 条跳到 932px | `12-toc.png`、`13-toc-jump.png` |
| 划词工具栏 | 选区后出现 4 色 + 下划线 + 删除线 + 批注 + 查词 + 复制 | `13-toc-jump.png` |
| 高亮 | 黄色高亮写入 IndexedDB（`marks` 1 条，锚点 bid/start/end/quote 完整），CSS Highlight 组生效 | `14-highlight.png` |
| 批注 | 批注面板可输入（计数 13/500），保存后 `marks` 2 条、note 组生效、toast 提示 | `15-note-editor.png`、`16-note-saved.png` |
| 批注列表 | 「共 2 条」，逐条跳转/删除，导出 Markdown 复制成功（toast：已复制 2 条批注的 Markdown） | `17-marks-list.png`、`18-marks-export.png` |
| 收藏 | 顶栏书签 aria-pressed false→true，toast「已收藏」 | `19-reader-bookmarked.png` |
| 编辑原文 | 打开即带原文（334 字），改动后标记「未保存」→「271 字」 | `20-editor.png`、`21-editor-save.png` |
| 无原始 URI 时的保存降级 | 弹出「另存副本 / 取消」，不覆盖、不丢失；选副本后 toast「已存为应用内副本」，书架 5 → 6 篇 | `21`、`22-editor-copy.png` |
| 朗读降级 | Android WebView 无 Web Speech API（`speechSynthesis in window === false`），点朗读 → toast「当前系统不支持朗读」，不白屏 | `23-tts.png` |
| 材质=纯色降级 | `data-material=solid` 后全页 `backdrop-filter` 计数 0，底栏变为实色 `rgb(37,31,27)` | `28-material-solid.png` |
| 完整重启（force-stop → 冷启） | 主题 warm-night、字号 24.5px、2 条批注、阅读进度全部保留；无 JS 报错 | `25-relaunch.png`、`26-relaunch-reader.png` |

## 二、缺陷与待办

| ID | 级别 | 场景 | 现象（实测） | 证据 | 状态 |
| --- | --- | --- | --- | --- | --- |
| BUG-001 | **P1** | F3 全局错误边界 | 源码无 `window.onerror` / `unhandledrejection` / 渲染兜底：渲染函数抛错时只有未捕获异常，没有兜底页与日志导出（`views/app.ts:140` 先 `render(state)` 再 `replaceChildren`，构建期异常会让页面停在旧状态且无提示） | 源码检索 + 真机故障注入 | 待修复 |
| BUG-002 | **P1** | F4 超长文档首屏 | 注入 823k 字符 / 1.9 MB 文档：点击到首帧 **1378 ms**（目标 < 300 ms，1 MB 以内） | `31-stress-open.png` | 待修复 |
| BUG-003 | **P1** | F4 超长文档滚动 | 同一文档：正文 **31 080 个 DOM 节点 / 9 660 个块**、`scrollHeight` 2 735 352px；脚本滚动 60 帧 p50 8 ms / p95 73 ms / max **274 ms**，9 帧 > 50 ms（无块级懒挂载/虚拟化） | 同上 + 帧表 | 待修复 |
| BUG-004 | P2 | 排版面板 | 面板右上角深色 × 浮动在屏幕顶部（y≈130），压住正文首行；风格与浅色 sheet 不一致 | `05-typeset.png` | 待修复 |
| BUG-005 | P2 | 顶栏材质 | 阅读页滚到顶部时顶栏即显示 70% 玻璃带（`appbar--reader` 103px），与米纸背景之间有明显横向分界；书架页规格要求「顶栏透明，滚动后淡入」 | `02-shelf-home.png`、`03-reader-top.png` | 待修复/对照参考图 |
| BUG-006 | P3 | 另存副本 | 副本标题与原文完全相同，书架出现同名篇目不易区分 | `22-editor-copy.png` | 待修复 |
| BUG-007 | P3 | 朗读 | Android WebView 不支持 Web Speech API → 真机朗读功能实际不可用（降级提示正确）。若要交付朗读，需原生 `TextToSpeech` 桥（本阶段不新增依赖，先记档） | `23-tts.png` | 记档（是否做原生桥待定） |
| BUG-008 | P3 | 特色功能说明 | 编辑写回原文件、系统返回键、真实长按选词、状态栏/刘海、横屏、系统字体放大 —— 见下节阻塞，尚未真机验证 | — | 阻塞中 |

## 三、阻塞项（需要手机侧配合或真机权限）

1. **屏幕锁定/息屏**：`screencap` 只能拿到系统截图，锁屏时是黑屏；状态栏/刘海/手势条适配必须解锁亮屏后截一张「系统层 + 应用」的图。
2. **`adb shell input` 被拒**：`SecurityException: INJECT_EVENTS`（HyperOS 未开「USB 调试（安全设置）」）。导致：
   - 系统返回键链路（F2 必测）无法自动验证；
   - 文件选择器（SAF 导入）无法自动点击 → 「导入 → 阅读」全链路、以及「编辑后写回原文件（需 SAF 持久授权 URI）」无法真机验证；
   - 旋转/字体缩放（`settings put` 也被拒绝，缺 `WRITE_SETTINGS`）无法自动改。
3. 已绕过：WebView 内容层的一切走查用 `tools/device-eval.mjs`（CDP）完成，不依赖注入。

## 四、复现命令（可重复）

```bash
adb -s 518d68b2 forward tcp:9333 localabstract:webview_devtools_remote_$(adb -s 518d68b2 shell pidof cn.mdlego.reader | tr -d '\r')
node tools/device-eval.mjs --file tools/f1-helpers.js
node tools/device-eval.mjs --shot docs/screenshots/F/x.png '(async()=>{ __f1.click("doc-item"); await __f1.s(1200); return __f1.metrics(); })()'
```
