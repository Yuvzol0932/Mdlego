# M5 真机验证报告（小米 11 Ultra / Android 14）

> 设备：M2102K1C，adb `518d68b2`，Android 14。构建：本分支 `npm run android:build` 的 debug APK。
> 交互：MIUI 拦 `adb shell input`（INJECT_EVENTS），点击/长按一律走 WebView DevTools CDP + 页面内 PointerEvent；截图用 `adb shell screencap -p <设备文件>` + `adb pull`。
> 本报告只写实际跑出来的结果；没跑成的写「未做」并说明原因。没有估算冒充实测。

---

## 一、12 张截图（方案 §6.3）

全部 12 张有效，逐张断言后截图；文件均为 PNG（magic `89 50 4E 47`，> 280 KB）。

| # | 文件 | 截图前断言 | 结果 |
| :-- | :--- | :--- | :--- |
| 01 | `lookup-01-prospect.png` | `lookup-word` == `prospect`，`lookup-translation` 非空 | ✅ |
| 02 | `lookup-02-insisted.png` | `lookup-word` == `insisted` | ✅ |
| 03 | `lookup-03-literally.png` | `lookup-word` == `literally` | ✅ |
| 04 | `lookup-04-consist.png` | `lookup-word` == `consist` | ✅ |
| 05 | `lookup-05-persistence.png` | `.lookup__line` ≥ 2（多行释义） | ✅ |
| 06 | `lookup-06-outofdict.png` | `lookup-miss` 文本 == `未收录：skibidi`；截图时提示仍在（`shot-06-assertions.json`） | ✅ |
| 07 | `lookup-07-lemma.png` | `lookup-lemma-hint` == `按 persistence 释义` | ✅ |
| 08 | `lookup-08-conflict-link.png` | 长按链接后无 `lookup-card` | ✅ |
| 09 | `lookup-09-conflict-taskbox.png` | 长按复选框后无 `lookup-card`；随后点复选框仍能勾选（`data-task-checked` 0→1） | ✅ |
| 10 | `lookup-10-scroll.png` | pointerdown 后位移 90px 再抬手，无卡片 | ✅ |
| 11 | `lookup-11-close-back.png` | 卡片打开 → 点遮罩 → 卡片消失且 `article` 仍在 | ✅（见下注） |
| 12 | `lookup-12-toggle-off.png` | 开关关掉后长按 prospect：无卡片、无提示 | ✅（见下注） |

### 第 11 张：为什么用「点遮罩」而不是系统返回键

`adb shell input keyevent 4` 在这台机器上被 MIUI 拒绝：

```
java.lang.SecurityException: Injecting input events requires the caller ... to have the INJECT_EVENTS permission.
```

所以无法从 adb 注入 BACK 键。改用点遮罩关闭 —— **覆盖的代码路径相同**：
`views/lookup.ts` 的遮罩关闭、关闭按钮、以及 `main.ts` 的 `handleSystemBack()` 第一行，
三者都调用同一个 `closeLookupCard()`。断言文件 `shot-11-assertions.json` 里写明了这一点，没有假装是返回键。

### 第 12 张：静态图无法自证「刚刚长按过」

按负责人确认的方式：**截图 + 断言记录**一起进同一提交。
`shot-11-assertions.json` / `shots-assertions.json` 写明长按坐标、判定条件与结果。
本轮没有为了让截图自证而改产品代码。

---

## 二、真机查询延迟（方案 §6.4）

量法：12 词 × 20 轮 × 3 次冷启动（每次 `am force-stop` 后重开），共 720 次调用；
每组轮次开始前清空 `window.__dictPerf`。冷/热按「这次调用有没有真的加载分片」分类（分片缓存是模块级的）。

| 指标 | n | median | P90 | max | 阈值 | 判定 |
| :--- | ---: | ---: | ---: | ---: | :--- | :--- |
| 冷查询（含分片加载） | 30 | **16.70 ms** | **34.70 ms** | 71.60 ms | median ≤ 30、P90 ≤ 60 | ✅ 通过 |
| 热查询（纯 Map） | 194 | **0.10 ms** | **0.10 ms** | 0.20 ms | ≤ 1 ms | ✅ 通过 |

冷查询 30 个样本 = 3 次冷启动 × 10 个首次分片（12 个词里有 2 个与前面同分片）。
原始数据：`perf-raw.json`。

> 打点口径的一次修正（本提交前已修）：早先实现只在 `import.meta.env.DEV` 时打点，
> 但真机装的是 production 构建，DEV 恒为 false —— 真机永远采不到数。改成运行时开关
> `window.__dictPerfOn = true`，并新增 `window.__mdlegoLookup` 钩子供测速脚本调用（只在打点打开时存在）。

---

## 三、APK 增量（实测，两个真实 APK 相减）

| 项 | 字节 |
| :--- | ---: |
| 带词库 `app-debug.apk` | 14,389,150 |
| 不带词库（把 `assets/public/dict` 挪走重新 assembleDebug） | 4,202,299 |
| **增量** | **10,186,851 B = 9.72 MiB** |
| 复原后重建（确认可复现） | 14,389,150（与首次一致） |

在方案 §2.2 的 12 MB 上限内。

> 测量陷阱：aapt2 会把 assets 里的 `*.tsv.gz` **解压并按自己的 deflate 级别重压**，
> APK 里不存在 `.gz` 条目。所以绝不能用「分片 gzip 后体积」估算 APK 增量 ——
> 早期一次用 `du` 算出的 9.63 MiB 是错的，上面这组是真实字节相减。

---

## 四、M2 回归（方案 §6.5，9 项逐项结果）

| 项 | 结果 | 实测 |
| :--- | :--- | :--- |
| 1. 导入 | ✅ | 经系统「打开」投递 .md，书架出现样张文档 |
| 2. 书架 | ✅ | 卡片含标题、摘要片段与相对时间 |
| 3. 打开/渲染 | ✅ | `article` 内 `[data-bid]` 块 > 0，代码块/表格/复选框结构齐全 |
| 4. 目录跳转 | ✅ | 目录抽屉打开、列出标题，点击后抽屉关闭 |
| 5. 单篇搜索 | ✅ | 输入 `prospect` 命中 ≥ 1 条 |
| 6. 改字号/主题 | ✅ | 宋体下 `data-type-scale` 3→4，body 字号 **18px → 19.5px**；主题 magazine→night→magazine |
| 7. 退出重进看进度 | ✅ | 滚到 400px → 回书架 → 重开，滚动位置复现（误差 < 120px） |
| 8. 勾选任务 | ✅ | `data-task-checked` 0→1，再点回 1→0，状态随重渲染保持 |
| 9. `user-select:none` 无能力损失 | ✅ | `.article` 计算样式 `user-select: none` 已生效；正文文本仍可被程序读（`textContent` 226 字符，搜索仍能命中）；M2 本来不提供正文复制，零损失 |
| 10. 系统返回键 | ❌ **未验证** | MIUI 拦 `INJECT_EVENTS`，`adb shell input keyevent 4` 抛 SecurityException，无法从外部注入 BACK |

### 6a 与 9b 的两处修正（如实记录）

- **6a 首次判 FAIL**（`16px → 16px`）：当时 `data-font=sans`。sans 主题下 `tokens.css` 里
  `--fs-body: calc(var(--fs-body) - 0.5px)` 是**自引用循环**，非法的 calc 被丢弃，字号回落到浏览器默认 16px ——
  这是 **M2 既有缺陷，不是 M5 引入的**。切到宋体后实测 18px → 19.5px，档位正常工作。
  修复它要动 `tokens.css`（UI 线地盘），本轮按围栏未改，已记录待办。
- **9b 首次判 FAIL**（`getSelection().toString().length === 0`）：这是 `user-select: none` 的**预期行为**，
  不是能力损失。M2 本来就没有划词/M3 冻结；正文文本仍可被程序读、搜索仍命中。判定条件本身写错了，已改正。

---

## 五、仍未做 / 已知缺口

1. **系统返回键未真机验证**（MIUI 拦截，无法注入 BACK 键）。代码路径已由第 11 张的遮罩关闭间接覆盖（同一 `closeLookupCard()` 出口），但「按下 BACK 只退一层」这条真机行为**没有证据**。
2. **`--fs-body` 在 `data-font=sans` 下的自引用 calc 缺陷**（M2 既有，非 M5 引入），未修。
3. 冷查询 max 71.6ms 超过 P90 阈值 60ms 一次（长尾）；方案 §6.4 只对 median 与 P90 设阈值，均通过。
