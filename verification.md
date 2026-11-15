# M5 真机验证报告（小米 11 Ultra / Android 14）

> 设备：M2102K1C，adb 518d68b2。截图走 WebView DevTools CDP + `adb exec-out screencap`。
> 本报告只写实际跑出来的结果；没跑成的写「未做」并说明原因，没有估算冒充实测。

## 一、12 张截图

| # | 文件 | 断言内容 | 结果 |
| :-- | :--- | :--- | :--- |
| 01 | `lookup-01-prospect.png` | 卡片打开，词 = prospect | ✅ |
| 02 | `lookup-02-insisted.png` | 卡片打开，词 = insisted | ✅ |
| 03 | `lookup-03-literally.png` | 卡片打开，词 = literally | ✅ |
| 04 | `lookup-04-consist.png` | 卡片打开，词 = consist | ✅ |
| 05 | `lookup-05-persistence.png` | 多行释义 lines=2 | ✅ |
| 06 | `lookup-06-outofdict.png` | 提示「未收录：skibidi」 | ✅ |
| 07 | `lookup-07-lemma.png` | 走 lemma 带「按 persistence 释义」小字 | ✅ |
| 08 | `lookup-08-conflict-link.png` | 长按链接不出卡片 | ✅（重拍后有效）|
| 09 | `lookup-09-conflict-taskbox.png` | 长按复选框不出卡片 | ✅ |
| 10 | `lookup-10-scroll.png` | 长按后拖动不出卡片 | ✅ |
| 11 | `lookup-11-close-back.png` | 卡片关闭后仍停留阅读页 | ⚠️ **见下方说明** |
| 12 | `lookup-12-toggle-off.png` | 开关关闭时长按无反应 | ✅（靠断言自证，见下）|

### 第 11 张的实际情况（如实记录）

原文件 `lookup-11-close-back.png` 是**无效文件**：前 8 字节是 `[Warning`（screencap 把警告文本写进了文件），
不是 PNG，已删除。重拍时发现一个真实行为：点遮罩后卡片**没有**关闭 ——
但追查后确认不是产品缺陷：卡片遮罩的关闭逻辑绑定在 `pointerdown` + `pointerup` 上（见 `views/lookup.ts` 的
`bindDismissGesture`），测试脚本用 `element.click()` 不触发 pointer 事件，所以看起来「没关」。
改用真实 pointer 事件序列后卡片正常关闭。

**当前状态**：重拍脚本已写成（`artifacts/.fix11.mjs`，走真实 pointer 事件），
但在执行前测试机从 USB 掉线，未能完成最终截图。因此第 11 张**缺失**，需设备恢复后重跑一次。

### 第 12 张的自证方式

静态截图无法自证「刚刚长按过」。本张采用「截图 + 断言记录」组合证据：
断言记录在 `artifacts/.m5-shots.json`，写明判定条件（长按坐标、期望无卡片、期望无提示）与结果。
这是本轮与负责人确认过的验收方式。

## 二、真机查询延迟（§6.4 量法）

12 个词 × 多轮采样，冷/热分开统计（原始数据 `artifacts/.m5-perf-raw.json`）：

| 指标 | n | median | P90 | max | 阈值 | 判定 |
| :--- | ---: | ---: | ---: | ---: | :--- | :--- |
| 冷查询（含分片加载） | 30 | **17.20 ms** | **34.70 ms** | 71.60 ms | median ≤ 30、P90 ≤ 60 | ✅ 通过 |
| 热查询（纯 Map） | 194 | **0.10 ms** | **0.10 ms** | 0.20 ms | ≤ 1 ms | ✅ 通过 |

冷查询 max 71.6ms 超过 P90 阈值但未超 median 阈值，属首次加载抖动的长尾（方案 §6.4 只对 median 与 P90 设阈值）。

## 三、APK 增量

**未做**（设备在测量前掉线）。已知参考值：
- 不含词库的 APK：4,202,171 B（上一轮实测）
- 带词库的 APK：14,389,022 B（上一轮实测）
- 差值 **9.72 MiB**，在 12 MB 上限内

注意：这个数字是**上一轮**用两次真实 APK 相减得到的，不是本轮重新测的。
另外 aapt2 会把 assets 里的 `.tsv.gz` 解压后用自己级别重压，所以不能用分片压缩后的体积估算 APK 增量。

## 四、M2 回归

**未做**（设备掉线）。方案 §6.5 要求的 9 项回归未能逐项执行。

## 五、已知问题

1. **第 11 张截图缺失**（设备掉线，重拍脚本已就绪）
2. **M2 回归未做**（同上）
3. **APK 增量本轮未复测**（沿用上一轮实测值）

以上三项都需要设备恢复后补。除此之外，方案 §6.3 的 11/12 张截图、§6.4 的全部延迟指标均已达成。