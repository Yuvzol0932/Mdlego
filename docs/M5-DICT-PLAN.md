# M5 方案：长按查词 + 释义卡片（v1）

> 状态：**方案，未实现**。本文不含任何功能代码。本轮只做三件事：盘点已有契约、查证数据源、给出实现方案。
> 分支：`m5-dict`（基线 `main@53d0014`）。撰写日期：2026-11-15。
>
> **数字可信度约定**：全文每个数字都带标记 ——
> **【实测】** ＝ 本轮在本机真实跑出来，附命令与产物路径；
> **【查证】** ＝ 本轮从上游仓库 / GitHub API 真实读到，附 URL；
> **【待确认】** ＝ 没拿到一手证据，写明卡在哪、怎么补。
> 没有任何一个数字是估算后冒充实测的。

---

## 0. 范围围栏

**v1 只做两件事**：长按取词 → 弹一张释义卡片。

明确**不做**（也不许先铺接口）：

- 生词本 / 收藏 / 标记已掌握
- 发音、音频资源
- 划词选区查词（M3 仍冻结，`core/selection.ts` 不存在，也不新建）
- 词组查询、中文查英文、例句、近义词
- 顺手改其它界面（书架、设置页其余部分、阅读器工具栏）
- 本轮不改 `web/src/main.ts` 的接线（实现轮只加查词相关最小接线）
- 不下载词库进仓库、不安装任何新依赖

**唯一允许改的已有文件**：`web/src/core/text.ts`（本轮也不改）。

---

## 1. 数据源

### 1.1 选型结论

**ECDICT（Free English to Chinese Dictionary Database）**，作者 skywind3000。

- 仓库：<https://github.com/skywind3000/ECDICT>
  【查证】GitHub API `repos/skywind3000/ECDICT` 返回 `license.spdx_id = MIT`，默认分支 `master`，star 8619，`updated_at 2026-11-15T05:33:54Z`
- 许可证：**MIT License**，Copyright (c) 2025 Linwei
  【查证】<https://raw.githubusercontent.com/skywind3000/ECDICT/master/LICENSE>，全文 1063 字节，标准 MIT 三段式
- 最新 release：`1.0.28`，资产含 `ecdict-sqlite-28.zip` 216,765,132 字节
  【查证】`api.github.com/repos/skywind3000/ECDICT/releases/latest`

**MIT 意味着可以合法打包进 APK 分发**，义务只有一条：随包保留版权声明与许可全文。落地要求：

- `android/app/src/main/assets/dict/LICENSE-ECDICT.txt` 原样拷贝 MIT 全文
- 设置页「关于/版本」区块追加一行纯文本：「离线词库 ECDICT (MIT) © Linwei」——纯文本行，不算改界面风格

### 1.2 上游数据事实

| 项 | 值 | 依据 |
| :--- | :--- | :--- |
| 主数据文件 | `ecdict.csv`，66,009,548 字节（约 63.0 MiB） | 【实测】`curl -I` 返回 `Content-Length: 66009548` |
| 内容指纹 | git blob `0e527e22e0e0d22f012b0ed251a8dddd5891773b`；本机 md5 `231b274d84f74a8ceca152c574678198` | 【实测】contents API + `md5sum` |
| 总行（词条）数 | **770,611** | 【实测】Python `csv.DictReader` 逐行计数 |
| 有中文释义的行 | 770,238 | 【实测】`translation` 非空 |
| 字段（13 列） | word, phonetic, definition, translation, pos, collins, oxford, tag, bnc, frq, exchange, detail, audio | 【查证】README 数据格式表 + 【实测】CSV 表头 |
| `exchange` 格式 | 类型:变换词，/ 分隔。类型码 p 过去式、d 过去分词、i 现在分词、3 三单、r 比较级、t 最高级、s 复数、0 lemma 原型、1 lemma 的变换形式 | 【查证】README「词形变化」节 |
| 释义换行编码 | 单元格内是**字面量反斜杠+n**，不是真换行 | 【实测】前 5000 行：真换行 0 行，字面 `\n` 320 行；`repr()` 已确认 |
| 词条大小写 | 数据本身大小写不敏感；实测 401,614 条保留词里小写去重后仍是 401,614 | 【实测】 |

**一条关键事实**：ECDICT 连变形词本身也单独收词条，所以 insisted / looked / gave / teeth / better 都能精确命中，且 `exchange` 里带 `0:lemma` 指回原型【实测，逐词结果见 §4.1】。

### 1.3 字段 → DictEntry 映射

现有契约（`web/src/core/types.ts:263-276`，本轮只读不改）：

~~~ts
export interface DictEntry {
  readonly word: string;
  readonly phonetic: string;     // 音标，可能为空串
  readonly translation: string;  // 中文释义（多行，以 \n 分隔）
}
export type LookupResult =
  | { readonly hit: true; readonly entry: DictEntry; readonly matchedBy: 'exact' | 'lemma' }
  | { readonly hit: false };
~~~

| ECDICT 字段 | 去向 | 说明 |
| :--- | :--- | :--- |
| `word` | `DictEntry.word` | 保留原大小写形态；走 lemma 时仍显示用户长按的词形 |
| `phonetic` | `DictEntry.phonetic` | 空则空串，不做音标格式化 |
| `translation` | `DictEntry.translation` | 字面量 `\n` 还原成真换行，逐行保留 |
| `exchange` | **不进 DictEntry** | 只提取 `0:lemma` 与各「类型:形态」建词形索引，不上卡片 |
| `definition` | 丢弃 | 英文释义，v1 用不上，体积大 |
| `pos / collins / oxford / tag / bnc / frq` | 丢弃 | 卡片不展示；v2 要做「考试标签/词频」再接 |
| `detail / audio` | 丢弃 | 上游标注「待添加」，实际为空 |

**为什么丢弃而不塞进 DictEntry**：DictEntry 是三层共享契约，加字段要改 `core/types.ts`。v1 卡片只要「词 + 音标 + 中文」，不为 v2 提前铺路。

### 1.4 裁剪规则（逐条可复现）

裁剪脚本本轮**不进仓库**；实现轮以 `tools/build-dict.mjs` 形式提交并写进 README。规则如下：

1. **去重键 = word 小写**。实测保留的 401,614 条无大小写冲突。
2. **只要有中文释义**：`translation` 非空（丢 373 行）。
3. **只留单个英文词**：正则 `^[A-Za-z][A-Za-z'\-]*$`。被裁掉的分类【实测】：

| 分类 | 行数 |
| :--- | ---: |
| 含空格（词组，如 long time） | 366,450 |
| 含数字或 . _ / 等 | 1,445 |
| 以连字符开头（后缀条目，如 -able） | 408 |
| 释义为空 | 373 |
| 其它（非 ASCII 字母起始等） | 321 |
| **保留（单英文词 + 有中文释义）** | **401,614** |

4. **不做额外语义筛选**：`[网络] …` 这类释义行保留。曾量过「删掉以 [网络] 起始行」的版本：21,427,567 字节，只省 0.42 MB，不值得多一条规则【实测】。

**裁剪后词条数：401,614 条**【实测】，占上游 770,611 行的 52.1%。

> 与 README 里「10 万词条」口径的差异：那是早先粗估。401,614 是上游真实能提供的**单英文词全量**，且体积可控（见 §2）。若要压到 10 万，规则是按 `frq`（当代语料库词频）取前 N、`frq=0` 排最后 —— 这条本轮没跑数，属【待确认】。

---

## 2. 体积账

### 2.1 原始 / 裁剪后

| 指标 | 值 | 依据 |
| :--- | ---: | :--- |
| 原始 ecdict.csv | 66,009,548 B（63.0 MiB） | 【实测】Content-Length |
| 裁剪后未压缩（word ⇥ phonetic ⇥ translation 三列 TSV） | **21,848,692 B（20.8 MiB）** | 【实测】401,614 条，均摊 32.1 字符/条 |
| 同数据 gzip -9 | 8,769,749 B（8.36 MiB） | 【实测】740 个分片逐个 gzip 累加 |
| 分片目录整体 zip -9 | **9,132,687 B（8.71 MiB）** | 【实测】`zip -9 -r` |

**解压后占用户空间按 20.8 MiB 计；APK 里按 8.71 MiB 计**（APK 自身会对 assets 做 deflate）。

### 2.2 报一个具体上限

> **APK 增量上限：不超过 12 MB。**

理由（全部实测）：词库本体 zip 后 8.71 MiB + 词形索引 0.27 MiB + 分片 manifest 与许可文本，再留约 3 MB 余量吸收「未压缩对齐差异 / json 索引 / 打包摩擦」。超过 12 MB 说明裁剪规则或格式选错，回到方案而不是继续打包。

### 2.3 词形索引体积

| 项 | 值 | 依据 |
| :--- | ---: | :--- |
| lemma 对（变形词 → 原形） | 58,610 条 | 【实测】扫 `exchange` 的 `0:` 项 |
| 未压缩 | 1,086,660 B（1.04 MiB） | 【实测】 |
| gzip -9 | 274,140 B（268 KiB） | 【实测】 |

规则兜底用的后缀表是几十行代码，体积可忽略。

### 2.4 首次加载方式与耗时

**推荐：分片 + 按需加载**（不首启全量解压，也不全量塞内存 Map）。

- 打包进 assets 的路径（推荐走 Vite publicDir，见 §8 末尾）：`web/public/dict/d_<前缀>.tsv` → 构建后落 `assets/public/dict/`，共 **740 个分片**（键＝词前 2 字符，1 字符词归 `_` 组）【实测】。
- 分片体积：min 19 B、**median 2,059 B**、mean 29,525 B、max 612,975 B（`co` 组，10,550 条）【实测】。
- **不首启全量拷贝到私有目录**：首启解压 20.8 MiB 会带来一次明显启动卡顿（真机耗时未测，【待确认】），而分片按需读只要毫秒级。

**耗时（桌面 Node 实测；真机数字属【待确认】）**：

| 动作 | 实测（桌面 Node） | 真机预期 |
| :--- | ---: | :--- |
| 读一个分片文件（0.15–0.61 MB） | 0.2–0.4 ms | 慢 3–8 倍（assets 读取 + 校验），约 1–3 ms |
| TextDecoder 解码 | 0.1–0.4 ms | 同级 |
| 按行 split + 建 Map | 0.8–2.4 ms | 约 1.5–2 倍 |
| **单分片总计（5 个分片各 5 次取中位数）** | **1.1–3.5 ms** | 估计 5–15 ms |
| 已加载索引上单次查词 | **0.03 µs**（1 万次共 0.32 ms） | 同级 |

**为什么否掉「首启全量加载进内存 Map」**：实测全量加载 401,614 条 → **341 ms、JS heap 116.5 MB、RSS 189.4 MB**【实测，Node `--expose-gc`】。WebView 里只会更差，小米 11 Ultra 上大概率内存抖动甚至 OOM。这条数据直接否掉了内存全量方案。

---

## 3. 查询方案

### 3.1 存储格式：分片索引 TSV，不用 SQLite

| 方案 | 判定 | 理由 |
| :--- | :--- | :--- |
| SQLite | 否 | 需原生插件（新依赖，见 §3.3）；合库后仍约 20 MB，单次 SQL 固定开销高于「读一个小分片」 |
| 内存 Map 全量 | 否 | 116.5 MB heap / 341 ms，实测否掉 |
| **分片 TSV + 懒加载 Map** | **采用** | 单分片 1–3.5 ms、单查词 0.03 µs；零新依赖；浏览器可降级 |

每行一条，制表符三列：

~~~text
prospect	'prɒspekt	n. 景色, 展望\nvt. 勘探, 勘察\nvi. 勘探, 有前途
~~~

- 第三列换行用字面量反斜杠+n（与上游一致），读入后还原成真换行。
- 分片键 = 小写后前 2 字符；长度 < 2 的词归 `_` 组。
- 文件内按 word 字典序排列 —— 将来要做前缀补全/二分查找不用重排。
- **实测过的两种编码**：普通 TSV 21,848,692 B；「前缀增量编码」（只存与上一词的最长公共前缀长度）20,228,469 B，只省 **1.58 MB（7.2%）**，但解析要重建每行、复杂度上升。**v1 用普通 TSV**，增量格式记为可选项。

### 3.2 一次查询的完整调用链

~~~text
[用户长按]
  → views/ 侧长按判定（见 §5.1）
  → core/text.ts: wordAt(文本, 偏移)            ← 已有，不改
  → data/dict.ts: lookup(word)                  ← 新增，data 层是唯一 IO 边界
      ├─ 归一化：小写、去首尾连字符/撇号
      ├─ 分片键 = word.slice(0, 2)
      ├─ 懒加载该分片：fetch assets/dict/d_<key>.tsv → TextDecoder → Map<word, [phonetic, translation]>
      │    └─ 模块级 cache：Map<shardKey, Map<...>>，进程内常驻
      ├─ 精确命中 → LookupResult{ hit: true, matchedBy: 'exact' }
      ├─ 未命中 → ① lemma 索引（变形词→原形）再查 → matchedBy: 'lemma'
      │            ② 仍无 → 后缀规则候选（§4.2）→ matchedBy: 'lemma'
      └─ 仍无 → LookupResult{ hit: false }
  → views/ 渲染卡片（复用现有 drawer 视觉语汇，见 §5.3）
~~~

**分层纪律（四道门禁会拦）**：

- core 不得 import data/views。所以「取词」留 core（纯函数 `wordAt`），「查词」放 data，「渲染」放 views。
- views 不得直接 fetch / 碰 localStorage。查词必须经 `data/dict.ts`，视图只拿 `LookupResult`。
- views 不得裸 CSS 选择器（`check:selectors`）。新节点必须带 `data-testid`。
- 新颜色只能写 `styles/tokens.css`（`check:tokens`）。卡片不许出现裸色值。

### 3.3 【需要新增依赖 —— 停等批准，不许先装】

| 依赖 | 用途 | 现状 |
| :--- | :--- | :--- |
| 任何 SQLite 插件（如 `@capacitor-community/sqlite`） | **本方案不需要** | 走分片 TSV 就零新增依赖；运行时依赖仍是 @capacitor/core + @capacitor/android + @capacitor/app + markdown-it（`package.json` 现状未变） |
| 任何分词/词干库（natural、wink-porter2 等） | **不需要** | 词形靠上游 `exchange` 字段 + 几十行规则 |

> **结论：v1 不需要任何新依赖。**
> 若后续有人主张改 SQLite 路线，那必须新装 SQLite 插件 —— **该情况下先停等批准，不许先装**，并重新量：插件本体 + 合库后的 APK 增量、首启建库耗时、四道门禁是否仍全绿。

---

## 4. 变形词处理

### 4.1 主路径：上游自带的词形字段（覆盖 99.06%）

| 查询词 | 精确命中 | 命中内容 | 依据 |
| :--- | :--- | :--- | :--- |
| prospect | 是 | 独立词条，exchange 含 s:prospects/i:prospecting/p:prospected/3:prospects/d:prospected | 【实测】 |
| insisted | 是 | 独立词条，exchange = 0:insist/1:pd，释义「insist 的过去式和过去分词」 | 【实测】 |
| literally | 是 | 独立词条，exchange 为空，释义「adv. 逐字地, 按照字面上地, 不夸张地」 | 【实测】 |
| consist | 是 | exchange 含 3:consists/i:consisting/p:consisted/d:consisted | 【实测】 |
| persistence | 是 | 独立词条，exchange 为空，两行释义（第二行 [电] 持久） | 【实测】 |
| prospects | 是 | 独立词条 + exchange = 1:s3/0:prospect | 【实测】 |

**覆盖率实测**：把全库 `exchange` 展开成形态，共 **176,143** 个生成形态，其中只有 **1,664 个（0.94%）** 在词库里查不到 → 覆盖率 **99.055%**【实测】。这 1,664 个几乎全是冷僻词（abacuse、accipite 之类），`frq` 基本为 0。

### 4.2 兜底：lemma 索引 + 规则还原（覆盖剩余 1%）

优先级严格从上到下，命中即停：

1. **精确命中**（小写后查分片 Map）→ `matchedBy: 'exact'`
2. **lemma 索引**：58,610 对「变形词 → 原形」【实测】；命中后用原形词条，卡片标题仍显示用户长按的原词形 → `matchedBy: 'lemma'`
3. **后缀规则**（纯 core 函数，零 IO，只对长度 ≥ 4 的词跑，候选 ≤ 5）：
   - -ies → -y；-ied / -ier / -iest → 去 ed/er/est 后补 y
   - -es → 去 es / 保留 e 再试 / 只去 s
   - -s → 去 s
   - -ing → 去 ing；-ying → -y；-gging → 去一个 g；动词 -e 形态（making → make）
   - -ed → 去 ed；-ied → -y；-d（liked → like）
   - -er / -est / -ly / -ness / -ment / -tion → 去后缀试一次
4. 全部失败 → `{ hit: false }`

### 4.3 规则还原的局限（必须写进注释，不许假装没有）

- **不规则变化靠规则一定错**（went→go、teeth→tooth、better→good）—— 但这些上游已单独收词条（实测 gave/taken/teeth/better/happier 全部精确命中），实际走不到规则。
- **规则会造出「合法但错误」的原形**：axes 去 es 得 ax（在库但词义偏离）→ 把 axes 显示成 ax 的释义。缓解：`matchedBy === 'lemma'` 时卡片显示一行小字「按 ax 释义」，让用户知道这是推断。
- **连字符词**：`wordAt` 会把 well-known 整体取出（`text.test.ts:106` 已断言），上游也有 well-known 词条（实测命中）→ v1 只做整体精确查，不拆词。
- **词组**：`wordAt` 天然只取单个 token，look forward to 只会取到 look。v1 **明确只查单词，不识别词组**。

### 4.4 查不到时界面显示什么

`LookupResult` 的注释写得很清楚：「查不到时静默返回，调用方不弹窗 —— 这是刻意设计」（`core/types.ts:275`）。

**v1 遵守该设计**：

- 取不到词（长按落在中文、数字、空白、代码块、链接、复选框上）→ **完全静默**，不弹、不 toast、不震动。
- 取到合法英文词但 `hit: false` → 默认同样静默。**建议但需产品拍板**的折中：弹一张只有一行的极简提示「skibidi 不在离线词库中」，2 秒自动消失、点任意处关闭 —— 避免用户误判「长按失灵」。这条若不做，就在验收报告里明写「查不到=无反馈」。

---

## 5. 交互方案

### 5.1 触发方式与「系统选词菜单」避让（最容易翻车的一环）

WebView 里长按默认行为：Android 长按文本会弹系统文本选择手柄 + 复制/全选菜单（WebView 的 ActionMode）。它会盖住卡片，也会抢走事件。

**三层处置，缺一不可**：

1. **CSS**：阅读正文 `.article` 加 `-webkit-user-select: none; user-select: none; -webkit-touch-callout: none;`，写进 `styles/app.css`（不写内联 style）。
   副作用评估：M2 目前正文本来就没有选区能力（`core/selection.ts` 不存在、M3 冻结），关掉 user-select **不破坏任何现有能力**。这一点必须写进实现轮 commit message，避免被误判成「顺手做 M3」。
2. **事件**：在 `.article` 上以 capture 阶段监听 `contextmenu` 并 `preventDefault()` —— 部分 ROM 即使关了 user-select 仍会弹 ActionMode。
3. **判定**：自己实现长按 --
   - pointerdown 记 (x0, y0, t0, target)，起 500 ms 定时器（与系统长按同量级）
   - pointermove 位移 > 10 px → 取消（说明在滚动）
   - pointerup / pointercancel → 取消
   - 定时器到点 → 用 `document.caretRangeFromPoint(x, y)`（不支持时退 `caretPositionFromPoint`）拿到「文本节点 + 节点内偏移」→ 对**该文本节点的 textContent** 调 `wordAt(text, offset)`。

> **实现轮必须先解掉的第一个坑**：`RenderResult.blockTexts` 是 `collapseWhitespace` 过的块纯文本（`core/types.ts:92`），与 DOM 字符偏移**不是一一对应**，直接把 DOM 偏移套到 blockTexts 上会取错词。建议**不依赖 blockTexts**，直接在 DOM 文本节点上取词；`wordAt` 是纯函数，两种用法都成立。这点要用单测钉住。

### 5.2 与现有交互的冲突避让

| 冲突 | 处置 |
| :--- | :--- |
| **滚动** | 位移 > 10 px 即取消；且**不**对 pointerdown 做 preventDefault（一旦默认阻止会拖死滚动） |
| **点击链接** | 长按目标 `closest('a')` 命中 → 放弃查词，不出卡片；轻点链接仍走 `markdown.ts` 的白名单协议校验 |
| **任务清单复选框** | 复选框是 `input.task-box`（`markdown.ts:334` 注入）；长按目标 `closest('.task-box')` 命中 → 放弃查词。勾选仍走 `reader.ts:35` 的 change 监听，互不影响 |
| **代码块** | `pre[data-bid]` 内不查词（代码不是英文散文，误触率高） |
| **表格单元格** | td / th 有 data-bid，可查词，行为与段落一致 |
| **系统返回键** | 卡片打开时按返回只关卡片。接线点：`main.ts:343-364` 的 `handleSystemBack()`，在 activeOverlay 分支前插一层 |
| **重复触发** | 卡片已开时再长按别处 → 直接换新词，不叠加；点卡片外 → 关闭 |

### 5.3 卡片形态（杂志风，不换风格）

现有视觉语汇已有 `.drawer-root / .mask / .drawer / .drawer__head / .drawer--top`（`views/overlays.ts:11-40`）。**卡片直接复用这套 class**，不引入新视觉语言。

- **位置**：**底部弹层**（`.drawer--bottom`，drawer--top 的镜像），不做跟随手指的浮层 —— 跟随手指要处理边界翻转，真机调试成本高；底部弹层与现有目录/搜索浮层一致，用户已熟悉。
- **高度**：自适应，最多 40vh，超出内部滚动。
- **关闭**：点遮罩 / 点右上角关闭图标（复用已有 `icon('close')`）/ 系统返回键 / 直接长按新词替换。
- **字段**（严格对应 DictEntry，不多不少）：
  - 第一行：word（字号大于正文，宋体，杂志风）+ 关闭按钮
  - 第二行：phonetic（小一号、次要色；空则不占行）
  - 分隔线（用 token 色，1px）
  - 正文：translation 逐行
  - 仅 `matchedBy === 'lemma'` 时追加一行小字：「按 X 释义」
- **testid 规划**：`lookup-card / lookup-word / lookup-phonetic / lookup-translation / lookup-lemma-hint / lookup-close`

### 5.4 各类输入 v1 的处理

| 输入 | v1 行为 | 依据 |
| :--- | :--- | :--- |
| 英文单词（prospect） | 查词，出卡片 | 主路径 |
| 变形词（insisted） | 精确命中显示词形本身；走 lemma 则加「按 X 释义」小字 | §4 |
| 连字符词（well-known） | 整体精确查，不拆词 | `wordAt` 已支持，`text.test.ts:106` 断言过 |
| 带撇号词（don't） | 整体查；`isWordChar` 认直撇与弯撇 | `core/text.ts:62-69` |
| 中文 | `wordAt` 返回 null（`isWordChar` 只认 ASCII 字母/连字符/撇号）→ 完全静默 | 实测 `text.test.ts:93` |
| 数字 / 标点 / 空白 | 静默 | 同上 |
| 词组（look forward to） | **v1 不查词组**，只会取到第一个单词 look | 明说，不含糊 |
| 中文→英文 / 拼音 | 不支持 | 范围外 |

> **写进 README 的一句话**：v1 只查「单个英文单词」（含连字符与撇号的简单词），不查词组、不查中文。

---

## 6. 真机验证计划

### 6.1 环境（本轮已确认）

- 设备：**小米 11 Ultra**，`ro.product.model = M2102K1C`【实测】
- 系统：**Android 14**，`ro.build.version.release = 14`【实测】
- adb：序列号 `518d68b2`，`adb devices -l` 状态 `device`，transport_id 3【实测】
- 构建链：`npm run android:build`（Vite 构建 → push-web → Gradle → aapt2 反读版本号）→ `npm run android:install`，脚本均已存在
- 调试：`capacitor.config.json` 已开 `webContentsDebuggingEnabled: true`，可用 chrome://inspect 连 WebView

### 6.2 固定词表（12 词）

**A. 指定 5 词（全部实测在库）**

| # | 词 | 期望 |
| :--- | :--- | :--- |
| 1 | prospect | 精确命中，音标 'prɒspekt，三行释义 |
| 2 | insisted | 精确命中，释义含「insist 的过去式和过去分词」 |
| 3 | literally | 精确命中，音标非空，单行释义 |
| 4 | consist | 精确命中，单行释义 |
| 5 | persistence | 精确命中，两行释义（第二行 [电] 持久） |

**B. 3 个确定在库外的词（实测全部 MISS）**

| # | 词 | 期望 |
| :--- | :--- | :--- |
| 6 | skibidi | 查不到 → 静默（或 §4.4 的一行提示） |
| 7 | kubernetes | 同上 |
| 8 | chatgpt | 同上 |

备选库外词（也实测 MISS）：rizz、quuxify、zorbnak、cromulent。
**不要用 yeet 当「库外」** —— 实测它在库里（释义：表达兴奋的感叹词；投掷或用力甩（网络用语））。

**C. 变形词专项 4 词（验证 lemma 路径）**

| # | 词 | 期望 |
| :--- | :--- | :--- |
| 9 | prospects | 精确命中独立词条（exchange = 1:s3/0:prospect） |
| 10 | teeth | 精确命中，释义「pl. 牙齿」 |
| 11 | gave | 精确命中，释义「give的过去式」 |
| 12 | persistences | **精确查不到**（实测 MISS）→ 走 lemma/规则 → 显示 persistence 释义 + 「按 persistence 释义」小字 |

### 6.3 要交的截图（缺一张都不算过）

1. lookup-01-prospect.png — 正常命中，含词/音标/多行释义
2. lookup-02-insisted.png — 变形词精确命中
3. lookup-03-literally.png — 精确命中
4. lookup-04-consist.png — 精确命中
5. lookup-05-persistence.png — 多行释义换行正确
6. lookup-06-outofdict.png — 库外词，证明「静默/一行提示」符合 §4.4
7. lookup-07-lemma.png — persistences 走 lemma，带小字
8. lookup-08-conflict-link.png — 长按链接：不出卡片
9. lookup-09-conflict-taskbox.png — 长按复选框：不出卡片，勾选仍正常
10. lookup-10-scroll.png — 长按后拖动：不出卡片、正常滚动
11. lookup-11-close-back.png — 卡片打开按系统返回：只关卡片
12. lookup-12-toggle-off.png — lookupEnabled 为 false 时长按：完全无反应（见 §7.1）

截图命令（现成能力，不新增工具）：
`adb -s 518d68b2 exec-out screencap -p > artifacts/lookup-01-prospect.png`
产物落 artifacts/（已被 .gitignore 忽略 artifacts/*.png，不算提交内容）。

### 6.4 实测查询延迟：怎么量

**要求：报 median 与 P90，不报单次。**

在 `data/dict.ts` 里埋一个仅 debug 构建生效的打点（`import.meta.env.DEV` 或 buildId 含 debug 时挂到 `window.__dictPerf`）：

~~~ts
// 打点位置示意，不是实现
const t0 = performance.now();
await ensureShard(key);        // 冷：fetch + decode + parse
const t1 = performance.now();
const hit = shardMap.get(w);   // 热：纯 Map 查询
const t2 = performance.now();
window.__dictPerf.push({ cold: t1 - t0, hot: t2 - t1, word: w, shard: key });
~~~

量法（在真机 WebView 里跑，不在桌面）：

1. 12 个词跑 **20 轮**（共 240 次），每轮开始清空 `window.__dictPerf`；
2. chrome://inspect 连上 WebView，在 console 里取 `JSON.stringify(window.__dictPerf)`；
3. 分两组统计：**冷启动**（每个分片键只取第一次 cold）、**热查询**（其余 hot）；
4. 排序后报 **median / P90 / max**，写进实现轮交付报告。

验收阈值（本轮先定，实现轮照此判）：

| 指标 | 阈值 | 理由 |
| :--- | :--- | :--- |
| 热查询 median | **≤ 1 ms** | 桌面 0.03 µs，给 WebView 30 倍余量 |
| 冷查询 median | **≤ 30 ms** | 桌面 1.1–3.5 ms，给真机 8 倍余量 |
| 冷查询 P90 | **≤ 60 ms** | 首次要读 assets + 解析，允许偶发 |

超阈值 → 不合并，回来改格式（换增量编码，或把大分片再切一层）。

### 6.5 回归（不许破坏 M2）

真机跑一遍 M2 验收清单：导入 → 书架 → 打开 → 目录跳转 → 单篇搜索 → 改字号/主题 → 退出重进看进度 → 勾选任务 → 系统返回键。**重点确认**：为避让选词菜单加的 `user-select: none` 没有让任何既有能力消失（M2 本来就没提供正文复制，零损失）。

---

## 7. 落地顺序（实现轮，不在本轮）

| 步 | 内容 | 产出 |
| :-- | :--- | :--- |
| 1 | `tools/build-dict.mjs`：下载 → 裁剪 → 分片 → 词形索引，输出到 `web/public/dict/` | 可复现构建脚本 + LICENSE-ECDICT.txt |
| 2 | `web/src/data/dict.ts`：懒加载分片、lemma、规则兜底，返回 LookupResult | data 层唯一 IO |
| 3 | `web/src/core/lemma.ts`：后缀规则纯函数（可单测） | 零依赖纯函数 |
| 4 | views 长按 + 卡片；styles 加 user-select 与卡片样式；tokens 加卡片用色 | 视图层 |
| 5 | main.ts 接线：系统返回键多一层 | 最小接线 |
| 6 | 设置页加「长按查词」开关（见 §7.1） | 见下 |
| 7 | `npm run verify` → `npm run android:build` → `npm run android:install` → §6 真机验证 | 交付 |

### 7.1 必须由产品拍板的缺口：开关没有界面入口

盘点结果：

- `Settings.lookupEnabled` 已存在（`core/types.ts:199`）
- 默认 true（`data/settings-store.ts:30`），反序列化容错 `obj['lookupEnabled'] !== false`（同文件 :66）
- 经 `settings/changed` 进状态树（`state/store.ts:129-139`），由 `main.ts:113-119` 的订阅者写回 localStorage
- **但 `views/settings.ts` 里没有任何控件能改它**（全文 260 行只有字号/行距/段间距/字体/主题/构建信息）

所以「lookupEnabled 现在流到哪」的答案是：**能存、能读、能派发，但用户摸不到**。若要让 §6.3 第 12 张截图成立，实现轮必须先加一个开关控件 —— 这属于「改 UI 组件」，与本轮围栏冲突，故本轮不做。请 lead 拍板：① 实现轮允许加这一个开关（推荐，符合「设置项必须有入口」的常识）；② v1 不做开关，lookupEnabled 恒为 true。

---

## 8. 已确认的现有契约（盘点结论）

| 契约 | 位置 | 现状 |
| :--- | :--- | :--- |
| DictEntry / LookupResult | `core/types.ts:263-276` | 已定义，**零调用方**（全仓 grep 仅定义处命中） |
| Settings.lookupEnabled | `core/types.ts:199` | 已定义、有默认值、能持久化、**无 UI 入口** |
| wordAt / isWordChar | `core/text.ts:62-89` | 已实现 + 有单测（`text.test.ts:61-107`），只认 ASCII 字母、连字符、直撇与弯撇 |
| data-bid 块 | `core/markdown.ts`（BID_TAGS = p / h1-h6 / li / td / th / pre） | 已实现；容器 table / blockquote / ul **不带** bid |
| 任务复选框 | `core/markdown.ts:305-343` 注入，`views/reader.ts:19-48` 套用与绑定 | input.task-box + data-task-bid，change 事件 |
| 浮层视觉语汇 | `views/overlays.ts:11-40` | 可直接复用 drawer 那一套 class |
| 系统返回键 | `main.ts:343-364` | 已有优先级链，插一层即可 |
| 原生封装模式 | `data/native.ts` | registerPlugin + 浏览器降级 + try/catch 不抛；**本方案不需要新原生能力** |
| 原生插件写法 | `android/.../MdlegoNative.java` | @CapacitorPlugin + @PluginMethod + call.resolve/reject；**本方案不需要新增插件方法** |

> **实现轮要定的一个细节：WebView 怎么读词库。**
> `tools/push-web.mjs` 只把 `www/` 推到 `assets/public/`，其它 assets 不经过 Capacitor 的本地服务器。两条路：
> ① 把词库放 `web/public/dict/`（Vite publicDir 原样拷到 www，最终落 assets/public/dict/），前端用相对路径 `fetch('./dict/d_xx.tsv')` 直接读 —— **零原生代码、浏览器也能跑**；
> ② 放 `assets/dict/` 并由原生插件开 AssetManager —— 需新插件方法，且浏览器无降级。
> **推荐 ①**：完全复用现有构建流水线，不改原生代码。注意 `web/public/` 目前为空目录（实测），加子目录不影响现有构建。

---

## 9. 待确认清单

| # | 待确认项 | 卡在哪 | 怎么补 |
| :-- | :--- | :--- | :--- |
| 1 | **真机冷/热查询耗时** | 功能未实现，无从量 | 实现轮按 §6.4 打点，240 次样本取 median / P90 |
| 2 | **APK 实际增量** | 仓库里没有现存 APK（android 下无 .apk，构建产物被 .gitignore 忽略），无基线可量 | 实现轮 android:build 前后各量 APK 字节数报差值；§2.2 的 12 MB 是**上限约束**，不是实测增量 |
| 3 | **首启全量解压耗时**（若最终选该方案） | 未实现 | 走分片方案则不需要此项 |
| 4 | **caretRangeFromPoint 与 DOM 偏移对齐** | 需真机/真 Chrome 验证 | 实现轮用 `npm run smoke` 的真实 Chrome 跑一次，并用单测钉住 |
| 5 | **压到 10 万词条的裁剪效果** | 本轮只量了全量 401,614 | 按 frq 排序取前 N 再量体积，并确认 §6.2 的 12 个词仍在库 |
| 6 | **lookupEnabled 开关要不要做 UI**（§7.1） | 产品决策 + 与本轮围栏冲突 | 交 lead 拍板 |
| 7 | **库外词是否给一行提示**（§4.4） | 产品决策 | 交 lead 拍板；默认按现有契约「静默」 |

---

## 10. 本轮自查

- 没有写任何功能代码：本轮提交只有本文档一个新增文件
- 没有下载词库进仓库：66 MB CSV 与分片实验产物全部落在仓库外的临时目录（%TEMP%\m5probe\）
- 没有安装任何依赖：package.json 未改，node_modules 未装
- 没有改 UI 组件、没有改 main.ts、没有碰 M3
- 没有碰主工作区 Mdowner/
- 每个数字都带【实测】/【查证】/【待确认】标记
