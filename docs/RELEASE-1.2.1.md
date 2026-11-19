# 墨读 1.2.1 发布说明

发布日期：2026-11-19 · APK：`Mdlego-1.2.1-official.apk`（debug 签名，预览用）
版本：versionName `1.2.1` / versionCode `1020199`

本版是 **1.2.0 真机实测缺陷修复版**，不含新功能。四项缺陷逐项「先取证、再修、
修后真机复测」，每项一个独立提交。

## 一、四项缺陷与结论

| # | 现象 | 根因（确认程度） | 修后真机结果 |
| :-- | :--- | :--- | :--- |
| **A** | 预测式返回「开始后取消」→ 页面错位 / 白屏 | **已在代码中确认 + 真机复现** | 17/17 |
| **B** | 转场中出现「屏幕比例大矩形」 | **已在代码中确认 + 浏览器验收复现** | 13/13 |
| **C** | 打开动画掉帧、卡一帧 | **先量后改**（基线见下） | 首帧 40.8 → **28.5ms** |
| **D** | 刚打开时第一次长按没反应 | **原猜测不成立**，真机重新定位 | 12/12 |

---

## 二、#A 跟手取消后页面错位 / 白屏

**修前真机取证**（`tools/diag-gesture-dirty.mjs`）：

```
阅读页 style: null → "transform: scale(0.9995);"   ← 永久残留
.appbar top : -103 → -94.23            （Δ=8.77px）
```

**根因**：`prepareGestureStage()` 只盖了快照层与压暗层、**没有挂书架**
（它不调 `update()`）。于是「转场层前面那个兄弟节点」不是书架，而是
**真实阅读页**；逐帧写景深时 `shelfBehindStage()` 拿到它，每帧给它写
`style.transform`。取消路径只拆临时层，**没有任何代码还原这些内联样式**。
带 `transform` 的祖先会成为 `position: fixed` 后代的包含块，顶栏于是不再
贴屏幕顶部 —— 表现为「阅读中」跑到屏幕中间；叠加残留图层后部分机型白屏。

**修法**：
- 新增 [views/gesture-stage.ts](web/src/views/gesture-stage.ts)：把形变层生命周期
  抽成可单测模块。铁律是**所有写入只发生在临时层自己身上**，真实页面只加一个
  类名（`is-gesture-hidden`）并按原值还原，绝不写内联样式。
- 手势期间不再挂书架、不再做书架景深 scale（下方就是压暗层）。
- 收尾收敛到唯一幂等出口 `endGestureStage()`，并接入 cancel / commit /
  `visibilitychange` / `pagehide` / 路由变化全部路径。
- 新增 `assertPageIntegrity()` 兜底：检查残留临时层、残留隐藏类、真实页面被写脏，
  命中就用当前 store 状态强制重建视图。
- 原生侧：`onBackStarted` 时若上一次没收到结束事件，先合成一个 `cancel`。

**修后**（`tools/verify-gesture-integrity.mjs`，17/17）：
`.appbar` Δ = **0.00px**，阅读页 style 恒为 `null`。覆盖三条序列：
`start→move→cancel`、`start→cancel→start→commit`、
`start→move→切后台再回来（无结束事件）`。

---

## 三、#B 转场中的「屏幕比例大矩形」

**根因**：`core/morph.ts` 的 `fitToCard()` 早就算出 `clipBottom`（卡片态该裁掉
多少）与反向补偿的 `cardRadius`，但 `page-mask.ts` 把 `clipBottom` 当**布尔**用：

```ts
stage.style.clipPath = fit.clipBottom > 0 ? 'inset(0px 0px 0px 0px)' : 'none';
//                                        ↑ 这是零裁剪
```

于是卡片态是「按卡片宽度等比缩小的整个屏幕」，高出一倍多，盖住卡片标题与邻居。

**修法**：
- `core/morph.ts` 新增 `clipPathForScale(fit, scale, vh, collapsed)`：
  卡片态 `inset(0 0 clipBottom 0 round cardRadius)`，全屏态 `inset(0 0 0 0 round 0)`，
  圆角做反向补偿（布局半径 = `cardR/scale`，视觉半径恒为 `cardR`）。
- 打开/关闭两条路径都改用 `clip-path` 承载「裁高 + 圆角」，**删除关键帧里的
  `borderRadius`**（它每帧要在主线程重绘圆角裁剪，也是 #C 的掉帧来源之一）。
- `.page-mask__cover` 不再 `inset: 0` 拉成屏幕比例：高度由 JS 设为
  `cardUnscaledH`、顶部对齐，与书架里那张真实封面同比例。
- `.page-mask` 的 `will-change` 从 `clip-path` 改为 `transform, clip-path`
  （v1.2.0 实际动画的是 `transform`，写错属性等于没声明）。

**修后**（`tools/verify-cover-aspect.mjs`，13/13）：

```
打开第 0 帧可见区域 104.3×139.1，封面 104.3×139.1
  → Δw=0.01px Δh=0.02px，宽高比误差 0.00%
关闭末帧宽高比误差 0.00%
两帧 clip-path 都真的裁了底部（349.0px）
形变壳无内联 border-radius（圆角确实由 clip-path 承担）
不盖住任何相邻卡片标题
```

> 取证脚本第一版把「点击后 30ms」当成第 1 帧，量出来是中间态（ratio 0.61）。
> 改成把动画 `pause()` 在 `currentTime=0` 后再量，才拿到真正的端点值。

---

## 四、#C 打开动画掉帧

**先量后改**。基线（真机，`tools/perf-first-frame.mjs`）：

| 指标 | 修前 | 修后 | 红线 |
| :--- | :--- | :--- | :--- |
| 首帧（点击→遮罩出现）中位 | **40.8ms** | **28.5ms** | <30ms |
| 首帧最慢 | 48.6ms | 34.1ms | <30ms ⚠️ |
| 长任务（>50ms） | 0 个 | **0 个** | 0 |
| 首屏挂载块数 | **481 块** | **64 块** | — |
| gfxinfo janky 比例 | 0.6% | 1.5% | <5% |
| gfxinfo p95 | 18.7ms | 19.9ms | <20ms |

> 注意：只看 gfxinfo 会误判「已达标」（整轮抽样把首帧问题摊薄了）。
> 必须单独量首帧。

按贡献顺序改了三处（每改一处重测）：

1. **首屏窗口与补齐粒度拆开**（`core/window.ts` 新增 `FIRST_WINDOW_BLOCKS=24`）。
   块窗口按「块」算，但 DOM 插入粒度是「分片」（首片 24 块、其余每片 64 块），
   窗口 64 块会跨 2–3 片 → 实际挂载 481 块。改后首屏 **481 → 64 块**。
2. **删掉阅读层的 opacity 动画**（打开与关闭两处）。阅读层是装着几千像素 DOM
   的滚动容器，对它做 opacity 会让浏览器生成整屏离屏渲染面并每帧重新合成。
   「从书封展开」由封面层淡出 + 形变壳缩放负责，视觉无损。
3. **低端机自检改成「只在开场 120ms 内判定」**。原来探针整段动画都在跑，
   中途连续三帧超时就当场 cancel 几何动画改淡入 —— 用户看到的是
   「卡一帧再跳变」，比全程掉帧更难受。另删掉一个空转的
   `requestAnimationFrame` 循环与一次重复的 `fitToCard` 调用。

**未达标项（如实记录）**：最慢单次仍 34–35ms（>30ms 红线），属个别轮次抖动，
本轮未继续追（需要更细的 trace，优先级低于四项功能修复）。

逐段打点（修前，供后续参考）：点击同步 44.2ms 中，`dispatch` 12.4ms、
`openDoc` 1.9ms、`mountInitialWindow` 0–3.7ms、`freshArticle` 0.1–0.6ms。

---

## 五、#D 刚打开时第一次长按没反应

**任务书给的候选原因（首次/二次走不同渲染路径、绑定到被替换的节点）经真机
验证均不成立** —— 实测首次与第二次的 `data-gen`、`blocks`、事件序列完全一致。

**真正的差异在时间点，不在「第几次」**：

```
t+150ms（转场中）    ：caretRangeFromPoint 命中 DIV（形变壳自身）→ 长按失效
t+400ms 起（转场结束）：命中 #text / P → 长按正常
```

**根因**：打开方向 `.page-mask__reader` 里装的是**真实阅读页**，但这一层声明了
`pointer-events: none`（本意是给关闭方向的快照层用）。于是转场期间
`getComputedStyle(article).pointerEvents === 'none'`，`pointerdown` 到不了正文，
`bindTextSelection` 的 `onDown` 不执行，长按计时器根本不会启动。转场结束、
该层被移除后恢复正常 —— 所以现象看起来像「第一次不行、第二次可以」。

**修法**：
1. `styles/motion.css`：新增 `.page-mask__reader--live { pointer-events: auto }`，
   默认态仍是 `none`（关闭方向装快照，不该拦事件）。
2. `views/page-mask.ts`：**打开方向**给承载层加 `--live`；关闭方向保持默认。
3. `views/selection.ts`：
   - 新增 `toLayoutPoint()`：视觉坐标 → 布局坐标（形变壳带 scale 时两者差
     `1/scale` 倍，`caretRangeFromPoint` 要的是布局坐标）；
   - `textPointAt()` 自动识别当前形变壳的 scale 与 `transform-origin` 并换算；
   - 转场中按下但取不到词时记下位置，在 `mdlego:transition-end` /
     `mdlego:article-complete` 时补判一次（带 4s 老化，避免用户早已松手
     却很久之后突然弹工具条）。

**修后**（`tools/verify-longpress-firstopen.mjs`，12/12）：
转场期间 `article` 的 `pointer-events = auto`；冷启动第一次长按 "Android" →
工具条出现、可见（347×46）、完整在视口内、9 个按钮；第二次同样可用。

---

## 六、验证矩阵

| 门禁 | 结果 |
| :--- | :--- |
| `npm run verify`（四道架构门禁 + tsc + vitest + build） | ✅ **761 条测试 / 53 文件** |
| `tools/verify-gesture-integrity.mjs`（#A，真机） | ✅ **17/17** |
| `tools/verify-cover-aspect.mjs`（#B，打包产物） | ✅ **13/13** |
| `tools/perf-first-frame.mjs`（#C，真机） | 首帧中位 **28.5ms**、长任务 0 |
| `tools/verify-longpress-firstopen.mjs`（#D，真机） | ✅ **12/12** |
| Android 构建 | ✅ `./gradlew assembleDebug` BUILD SUCCESSFUL |

新增单测：`views/gesture-stage.test.ts` 9 条（形变层绝不污染真实页面）、
`core/morph-clip.test.ts` 11 条（卡片态裁成封面宽高比）、
`views/selection-layout.test.ts` 6 条（视觉→布局坐标换算）。

性能与取证数据：[docs/perf/1.2.1/](docs/perf/1.2.1/)。

---

## 七、未验证项（如实记录，不写成通过）

1. **第二台设备未复测**：任务书要求「至少一台 Android 14+ 小米/HyperOS + 一台
   系统不同的手机」。当前环境只连接了一台小米 11 Ultra（M2102K1C /
   Android 14 / HyperOS OS2.0），**另一台不同系统的设备未参与验证**。
   白屏问题（#A 的候选分支）因此**只在小米上复现与验证**，其他机型未确认。
2. **#C 最慢单次仍 34–35ms**（>30ms 红线），未进一步优化。
3. **帧率未做录屏逐帧验收**：本轮用 CDP + gfxinfo 量数据，没有按任务书
   §3 做 ≥24fps 的录屏逐帧「看到了什么」记录。
4. **#D 的极端快按（转场开始 150ms 内）仍不出工具条**：那时正文只挂了
   首屏 64 块，用户按的位置可能尚未进入 DOM。已有 `pendingPress` 补判机制，
   但本轮未构造出「按在已挂载块上且取不到词」的稳定复现，故未断言该分支。

---

## 八、与 1.2.0 的兼容性

- 数据格式未变（IndexedDB schema 未改），可直接覆盖安装。
- 唯一的行为变化：**转场期间阅读页可交互了**（1.2.0 是 `pointer-events: none`），
  转场中长按/点击正文会开始被响应；转场本身仍在 400ms 内完成。
- 圆角改由 `clip-path` 承担后，形变壳上不再有内联 `border-radius`；
  视觉结果一致（可见圆角恒为卡片圆角）。
