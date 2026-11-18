# 墨读 1.0.0 发布说明

发布日期：2026-11-18 · APK：`Mdlego-1.0.0-official.apk`（debug 签名，预览用）

## 本版收口项

| 项 | 内容 | 证据 |
| :--- | :--- | :--- |
| B | 打包后「＋」按钮右偏半个身位：Lightning CSS 整条丢弃独立 `translate`，改 `left:0;right:0;margin-inline:auto` | `docs/screenshots/transition-rc3/{before,after}/00-built-plus-*.png`；真机 Δ0px |
| A | 书架⇄阅读页彻底移除 View Transitions，改 Web Animations `clip-path` 遮罩（打开 300ms / 关闭 240ms / 左缘滑动复用 / 三档动效 / 打断定位终态 / 低端降级） | `docs/screenshots/transition-rc3/`；`tools/repro-transition-rc3.mjs` 25/25（修前 10/25） |
| A 补 | 首屏分片 + Worker 解析：900KB 文档首帧 321→43ms、长任务消失、动画期间 3751→25 块 | `docs/screenshots/transition-rc3/lazy/`；`tools/repro-lazy-firstscreen.mjs` 3/8→8/8 |
| F3 | 全局错误边界：诊断日志采集/持久化/导出、渲染兜底页（重试/回书架） | `docs/screenshots/error-boundary/`；`tools/repro-error-boundary.mjs` 3/15→15/15 |
| F4 | 超长文档性能：增量进度恢复、Worker 载荷瘦身、滚动写入去重、进度落库二分、滚动期关模糊 | `docs/screenshots/perf-f4/`；真机 900KB/10080 块：首帧 61ms、p95 33ms、max 40.3ms、DOM 31080 |

## 验证矩阵（全部基于 `vite build` 产物 / 真机）

| 门禁 | 结果 |
| :--- | :--- |
| `npm run verify`（boundaries/tokens/selectors/state + tsc + vitest + build） | ✅ 610 单测 |
| `npm run smoke` | ✅ 128/128 |
| `npm run verify:motion` | ✅ 37/37 |
| `npm run verify:built`（打包产物布局断言 + CSS 声明审计） | ✅ 5/5 + 全部风险声明保留 |
| `node tools/repro-transition-rc3.mjs` | ✅ 25/25 |
| `node tools/repro-lazy-firstscreen.mjs` | ✅ 8/8 |
| `node tools/repro-error-boundary.mjs` | ✅ 15/15 |
| `node tools/repro-perf-f4.mjs`（Chrome 1.9MB） | ✅ 10/10 |
| `node tools/device-perf-f4.mjs`（真机 900KB） | ✅ 首帧/p95/DOM 均达标 |
| `node tools/device-repro-rc3.mjs`（真机安装包） | ✅ 版本、B 居中、A 起止矩形 <0.1px、无 VT、无残留 |

## 已知限制（记档，不阻塞发布）

1. 超长文档滚动探针窗口内偶发 1 次 ~70ms 长任务，attribution 为空、应用侧慢操作日志仅 15ms，判定为 GC/合成（BUG-003 残余记档）。
2. 超长文档（900KB）正文分片全部挂完约 6.8s；首屏与阅读不受影响，但「全文查找/滚动到文末」在挂完前可能找不到目标块（会触发同步补齐）。
3. 批注在正文分片挂完后才加载（超长文档约 7s），普通文档 <0.3s。
4. debug 签名包仅供预览；正式上架需 release keystore。
5. 朗读依赖系统 TTS；Android WebView 无 Web Speech 时使用原生 TextToSpeech 桥（BUG-011 记档）。

## 安装

```bash
adb install -r Mdlego-1.0.0-official.apk   # 保留应用数据
```
