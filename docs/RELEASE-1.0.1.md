# 墨读 1.0.1 发布说明

发布日期：2026-11-18 · APK：`Mdlego-1.0.1-official.apk`（debug 签名，预览用）
版本：versionName `1.0.1` / versionCode `1000199`

本版只做一件事：**查词弹层（lookup sheet）返工**。8 项全部先在
`vite build` 产物上用真触摸复现，再逐项单独提交；未复现的那一项明确标注、不硬改。

## 8 项逐条结论

| # | 问题 | 修前实测 | 修后 | 提交 |
| :-- | :--- | :--- | :--- | :--- |
| 1 | 拖拽把手被放进标题行 | 把手中心 x 偏 **−161.5px**、距弹层顶 57.3px | 独立为首个子元素、居中 Δ**0.00px**、距顶 9px | `5ba11fc` |
| 2 | 顶部空白（安全区泄漏） | **已不复现**：`padding-top: 0px`、标题行距上沿 1.0px | 保持；改为双类选择器 + 5 条防退化断言 | `e075611` |
| 3 | 标题行对齐 / 按钮尺寸 | 生词本 29px、关闭 40px，点击区均 < 44px | 视觉 36px、点击区 44px、`align-items: center` | `e57f618` |
| 4 | 内容裁切 | `max-height: 40vh`（349px）硬截断，无底部渐隐 | `min(60vh, 520px)`、滚动 + 渐隐随滚到底淡出、无半裁块 | `29469d0` |
| 5 | 贴底 / 层级 / 状态栏 | 弹层 z-index 与阅读底栏同级，底栏横穿释义 | 弹层贴屏幕底（gap 0）、压住底栏、状态栏图标随主题 | `29469d0` `44b7a2e` |
| 6 | 被查词被弹层遮住 | 词 bottom 620 > 弹层 top 524，无让位 | 只在被挡住时滚，词完整可见（bottom 538 < top 550） | `cd7746a` |
| 7 | 释义排版 | `n. 景色, 展望` / `'prɒspekt` / 无词形行 | 词性胶囊、中文标点、标准 IPA `[ˈprɒspekt]`、`原形 · persist` | `81516d1` |
| 8 | 手势与动效 | 把手下拉 translateY 恒 0，两个关闭入口都失效 | 跟手 96px、把手/标题行均可下拉关闭、只动 transform+opacity | `9cae958` |

## 三个「不查就写错」的实现细节

1. **抓取区必须 `touch-action: none`**：留 `auto` 时垂直拖动被浏览器判成滚动，
   先发 `pointercancel` 再接管，手势库收不到完整序列 —— 表现是「拖了完全没反应」
   （实测 `data-dragging` 恒为 null）。
2. **拖动时必须 `animation: none`，只关 transition 不够**：入场动画用 `both` 填充，
   终帧优先级高于内联样式，JS 写的 `translateY` 被完全盖住。数据上跟手、
   屏幕上一动不动，靠**两张截图 sha256 完全相同**才抓到。
3. **词形行不能只在 `matchedBy === 'lemma'` 时显示**：词库里 49626 个变形词
   （persisted / better / went…）自己就有独立词条，查它们走 `exact` 分支。
   改成精确命中时也顺手查 lemma 索引，把 `lemmaOf` 一起带上来。

## 验证矩阵

| 门禁 | 结果 |
| :--- | :--- |
| `npm run verify`（boundaries/tokens/selectors/state + tsc + vitest + build） | ✅ 640 单测 |
| `node tools/verify-lookup-sheet.mjs --out=after`（日间，打包产物 + 真触摸） | ✅ **39/39**（修前 12/39） |
| `node tools/verify-lookup-sheet.mjs --theme=warm-night --out=after-night` | ✅ **39/39** |
| `node tools/verify-lookup-sheet.mjs --out=before`（修前证据） | 12/39，8 类问题逐条复现 |
| `npm run android:build`（build + push + apk + 打包产物布局断言 + CSS 声明审计） | ✅ 全过 |
| `node tools/verify-apk.mjs` | ✅ 1.0.1 / 1000199，包内前端与 www 字节一致 |

验收截图：`docs/screenshots/lookup-sheet/{before,after,after-night}/`
—— 日间 + 夜间各 3 张关键状态（弹出完成 / 下拉按住一半 / 关闭后），
全部为真触摸（CDP `Input.dispatchTouchEvent`）驱动、跑 `vite build` 产物。

## 布局断言已进测试

`tools/verify-lookup-sheet.mjs` 覆盖并要求全部通过：

- 把手：是弹层第一个子元素 / 不在标题行里 / 水平居中 |Δcx| ≤ 1px / 距顶 6–10px
- 标题行：`align-items: center` / 两个按钮视觉 36px / 点击区 ≥ 44px
- 弹层：底 == 视口底（gap ≤ 1）/ 底部安全区 15 个取样点全是弹层
- 内容：`max-height` == `min(60vh, 520px)` / `overflow-y: auto` /
  渐隐存在且滚到底淡出 / 无半裁内容块 / 无半裁圆角块
- 让位：被查词在弹层上方可见 / 为露出词而下滚 / 落库进度与滚动位置一致（差 ≤ 2%）
- 手势：把手下拉跟手 / 把手与标题行都能下拉关闭

## 已知限制

1. 弹层最大高度按 `min(60vh, 520px)` 取小；超长词条（如 incitative 16 行）
   需要滚动查看 —— 这是设计意图（不占满全屏），不是裁切缺陷。
2. 让位滚动会改变阅读位置，关闭后不回滚（按需求允许）；落库进度随之更新，
   已断言不会错位。
3. debug 签名包仅供预览；正式上架需 release keystore。
4. 状态栏图标明暗由原生 `setSystemBarsDark` 下发，只在真机生效；
   浏览器产物里该调用为空操作。

## 安装

```bash
adb install -r Mdlego-1.0.1-official.apk   # 保留应用数据
```
