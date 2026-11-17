# 交接文档：阶段 A、B 已完成，从阶段 C 接手

> 读者：接手的下一个 Agent。
> 配套材料：《墨读 Mdlego 2.0 大改任务书（v2）》（下称「任务书」）+ 本文。
> 任务书是**目标与验收标准**，本文是**当前真实状态 + 已经定下来的做法 + 踩过的坑**。两者冲突时，以本文的「已落地事实」为准，以任务书的「验收标准」为准。

---

## 0. 先做这三件事（不要跳）

1. 通读任务书，再读：`README.md`、`docs/ARCHITECTURE.md`、`docs/CONVENTIONS.md`、`docs/DECISION-render-A.md`、`docs/PHASE-B.md`。
2. 打开参考图 `docs/design/reference.webp`（左机夜间·暖黑书架，右机日间·米纸阅读页）。**每个阶段都要对照它**，阶段末写「与参考图的差异清单」。
3. 跑一遍基线，确认你接手的是绿的：
   ```bash
   npm ci
   npm run verify        # 期望：4 道门禁 + 314 条测试 + 构建，全绿
   npm run shot:kit      # 期望：真实 Chrome 断言全过，截图写入 docs/screenshots/B/
   ```

## 1. 工作规则（用户明确要求过，沿用）

- **严格按阶段推进，每个阶段做完停下汇报，不要一口气做完。** 用户在阶段 A 开头明确说过「先只做 A，做完停下」，B 做完又让停。**阶段 C 同样：做完停下汇报，等用户说继续。**
- 汇报要给证据：命令输出、截图路径、差异清单；**没有测试和截图不要宣布完成**。没验证的东西要明说（例如「未真机验证」）。
- 小步快跑：改一小块就 `npm run verify`。
- 不要伪造内容（假封面图、假章节号、假统计数据）。没有数据就显示空状态。
- **发布到 GitHub 要先问用户。** 见 §7。

## 2. 当前状态

分支 `claude/hungry-colden-9c4538`（已推送，未合入 main，未开 PR）。

| 提交 | 内容 |
|---|---|
| `9d376a3` | 阶段 A：页面栈路由 + 局部更新渲染；`artifacts/` 移出版本库；解冻 M3–M6 |
| `e4873d1` | 阶段 B：设计系统与材质 |
| `e69995c` | 用户自己提交：版本号升到 `0.5.2`（为 A+B 预发布 `v0.5.2` 对齐，Gradle 推导 versionCode 502） |

- **阶段 A、B：完成。** 阶段 C–F：未开始。
- **A+B 已由用户自己发布为预发布版本 `v0.5.2`**（用户亲口确认，合并了 A 和 B 的改动）。我没有在 GitHub 上核对该 Release 的具体内容（资产、说明），接手者如需引用请自行 `gh release view v0.5.2`。见 §7。
- 验证过的：`npm run verify` 全绿（314 条）、`npm run shot:kit`（真实 Chrome）、阶段 A 末的 `npm run smoke`（27/27）。
- **没验证的**（接手后别当成已验证）：
  - 真机/模拟器：系统返回键、低端机玻璃表现、安全区。
  - 阶段 B 之后**没有重跑 `npm run smoke`**（只跑了 verify 和 shot:kit）。阶段 C 开工前先跑一遍，确认主链路没被 B 打坏。
  - A+B 的 APK 构建过一次（A 时），B 之后没再构建。

## 3. 架构：现在是什么样（和旧文档冲突处以此为准）

### 3.1 导航与渲染（阶段 A）

- `core/nav.ts`（纯函数）：**页面栈 `pages` + 浮层栈 `layers`**，状态在 `state.nav`。
  - 一级 tab：`'shelf' | 'settings' | 'kit'`（`Tab` 类型）；二级页：`reader`。
  - **返回只有一条路**：`dispatch({ type: 'nav/back' })`——先弹浮层、再弹页面、到底才退出应用。系统返回键（`main.ts` 的 `handleSystemBack`）与应用内返回按钮都走它。**不要再写手写优先级链。**
  - action：`nav/tab`、`nav/push`、`nav/back`、`layer/opened`、`layer/closed`；浮层种类 `toc | search | lookup`。
  - `pushPage` 开阅读页时会替换已有阅读页并清浮层；页面栈变化会清浮层。
- `views/app.ts` 的 `createAppHost`：DOM 里只挂栈顶一页；栈内其它页作为脱离文档的节点缓存，回来时原样挂回；按页记忆 `window.scrollY`。
  - 页面用 `signaturePage(render, signature, state)` 包装：**签名不变就不重建**。新增页面时必须认真设计签名，别图省事用整个 state。
  - 设置页/kit 页的签名是 `{...settings, glassLevel: 0}`——**刻意排除** `glassLevel`，否则拖滑块时页面被重建、手势中断。新增会连续变化的控件时照此处理。
- `views/reader.ts` 的 `createReaderPage`：外壳与 `<article>` 创建一次；**仅「`RenderResult` 对象变了」或「长按查词开关变了」才换 article**（`data-gen` 递增，测试靠它断言节点身份）。勾选只原地改属性。
  - 铁律（任务书 A1 验收）：滚动、勾选、保存进度、开关浮层、改排版，**正文节点不得重建**。`views/host.test.ts` 守着这条，故意把重建逻辑打开时 5 条测试会失败。**C3/C4 改阅读页时不要破坏它。**
- `views/layers.ts` 的 `createLayerHost`：让 DOM 里的浮层与 `nav.layers` 一致。目录、搜索是它建的；**查词卡片的节点由 `views/lookup.ts` 管，但已登记为 `lookup` 层**（`onLookupVisibility`），返回键先关它。
- hash 只是导航的镜像：`#/settings`、`#/kit` 深链保留，写 hash 用 `history.replaceState`，不触发 `hashchange`。
- 阅读进度的像素级恢复逻辑还在 `main.ts`（`persistProgress` / `scrollToBid` / `restorePending`），基线用 `appbarBottom()`。**阅读页是文档级滚动（`window.scrollY`），不是内部容器滚动**——C3 做「随滚动方向收放顶栏」时要基于这一点。
- 滚动位置、进度、任务勾选的持久化行为没有改，沿用 M2。

### 3.2 设置与主题（阶段 B）

- `Settings` 升到 **schema v2**（`data/settings-store.ts`）：新增 `accent`、`material`、`glassLevel`、`motion`、`materialHinted`；`theme` 变成 `ThemeChoice = ThemeName | 'system'`，**默认 `'system'`**。
  - v1 数据可读：旧主题名（`magazine/night/paper`）原样保留，新字段落默认值。迁移测试在 `data/settings-store.test.ts`。
  - 设置仍存 `localStorage`（要在第一帧同步生效，见 ARCHITECTURE §4.5），不是 IndexedDB。
- `core/theme.ts`（纯）：`visualAttrs()` 把设置解析成根节点属性 `data-theme / data-scheme / data-accent / data-material / data-glass / data-motion`；`main.ts` 的 `syncVisualSettings` 写到 `<html>`。**即时预览就是靠这条链：dispatch → 订阅者写属性 → CSS 变量立刻生效。** 外观项不要自己改样式。
- 跟随系统：`resolveTheme('system', prefersDark)` → 暖黑/米纸；`main.ts` 监听 `prefers-color-scheme` 变化。`systemPrefersDark()` 在 `views/app.ts`，对没有 `matchMedia` 的环境（jsdom）安全。
- 7 个主题：`warm-night`、`warm-paper`（两套主力，取自参考图）、`forest`、`slate`、以及旧的 `magazine`、`night`、`paper`。

## 4. 设计语言（风格一脉相承的关键，请逐条遵守）

这一节是「为什么界面要长成这样」。阶段 C 做的每个界面，都应该让人觉得出自同一双手。

### 4.1 令牌是唯一来源

- 颜色、圆角、间距、阴影、时长、缓动**只能**在 `web/src/styles/tokens.css` / `tokens-themes.css` 定义。其它 `.css/.ts` 里**不许出现硬编码色值**（`check:tokens` 会拦）。需要新颜色 → 先进令牌。
- 文件名以 `tokens` 开头的 CSS 被门禁视为令牌层，新增令牌文件请沿用这个前缀。
- 间距走 `--sp-1..7`（4px 基准），圆角只用：
  `--r-sm 6` / `--r-md 10` / `--r-card 18`（卡片）/ `--r-xl 24`（横幅、大卡片、底部面板顶角）/ `--r-media 12`（正文图片）/ `--r-pill`。**不要在组件里散落写数字。**
- 强调色由 `--accent` / `--on-accent` / `--accent-soft` 提供；**压在强调色底上的文字必须用 `--on-accent`**（对比度已测）。
- 阴影：卡片 `--card-edge` + `--shadow-raised`；悬浮玻璃件 `--shadow-glass`。

### 4.2 材质规则（任务书第 3 节，已落地为代码）

- **`backdrop-filter` 只允许出现在 `styles/glass.css`**，且必须限定在 `[data-material='glass']` 之下。`check:tokens` 已把这条做成门禁；**不要绕过门禁，要加玻璃件就把选择器加进 glass.css。**
- 三档材质：`glass`（半透明+模糊）/ `soft`（半透明，无模糊）/ `solid`（不透明+描边）。不支持 `backdrop-filter` 的 WebView 自动等同 `solid`。
- **只许小面积悬浮层**：底部导航、阅读顶/底栏、选词工具栏、bottom sheet 背板、对话框、Toast、菜单。**禁止**整页背景、正文区域、列表卡片本体用玻璃。
- **同屏玻璃层 ≤ 3**。目前 kit 页就占满 3 层（`.appbar` + 两个 `.glass` 演示件）。**C 阶段上线底部导航后，书架页就有「顶栏 + 底部导航」2 层，阅读页「顶栏 + 阅读底栏」2 层，再叠选词工具栏正好 3 层——不能再多。**每做完一页，用 `tools/shot-kit.mjs` 里 `glassCount()` 的办法在真实 Chrome 里数一遍。
- 使用玻璃：给元素加 `.glass` 类（自带描边、柔影、顶部高光 `::before`），吸顶/吸底条（`.appbar`、`.reader-bar`）已在 glass.css 里接入。
- 卡片是**实色 + 极淡内描边 + 轻阴影**，不用玻璃（`.ui-card`）。

### 4.3 组件与图标

- 图标：`views/icons.ts` 的精灵（30 个，24 栅格、2px 描边、圆头圆角、`currentColor`），用 `icon('name')`（内部是 `<use href="#i-name">`）。**要新图标就往 `ICON_PATHS` 里加路径，不要内联 SVG、不要引图标字体、不要 emoji。**
- 统一组件在 `views/components.ts`（`button / switchControl / segmentedControl / slider / card / chip / accentPalette / themeChoice`），样式 `styles/components.css`（`.ui-*`）。**新界面先用这些，缺什么补到这里，不要在页面里各写一套。**
- 按压反馈：`.ui-press`（按下 `scale(.96)`，松开弹性回弹）。
- 每个可交互节点要有 `data-testid`（`check:selectors` 要求 `views/` 之外不得出现裸选择器）。**保留既有 testid**：`tools/smoke-chrome.mjs`、`tools/verify-typography.mjs` 依赖 `theme-night`、`theme-magazine`、`type-scale-*`、`back-home`、`open-settings`、`doc-item`、`empty-import` 等。

### 4.4 动效规则（任务书第 4 节；令牌已备，实现属阶段 D）

- 令牌已有：`--dur-fast 120 / base 220 / slow 360 / page 420`，`--ease-standard / decel / accel / spring`（`spring` 用 `linear()` 近似，不支持则回落 standard）。
- **只动画 `transform` 与 `opacity`**，禁止动画 `width/height/top/left/margin`。动画结束移除 `will-change`。
- `data-motion='off'` 与 `prefers-reduced-motion` 都已把时长令牌置 0。**阶段 C 写任何过渡都必须用 `var(--dur-*)` / `var(--ease-*)`，这样阶段 D 的「动效强度」开关才对你写的东西生效。**
- 「动效：简约」目前**只有令牌，没有逻辑**，区分（只淡入淡出 vs 完整）留给阶段 D 的 `motion.ts`。

### 4.5 视觉基调（对照参考图）

- 夜间·暖黑：背景 `#191411`，卡片 `#26201b`，强调琥珀金 `#e8b86d`，正文米白 `#efe6d8`，次级 `#a89c8c`。
- 日间·米纸：背景 `#f5ebdc`，卡片 `#faf3e6`，强调锈红棕 `#8a4b2a`，正文 `#2a2118`。
- 这些值是**目测校色，不是逐像素取样**；用户可能会让你微调。调的时候改 `tokens-themes.css`，并确保 `core/contrast.test.ts` 仍全绿（正文 ≥ 4.5:1）。
- 标题衬线、界面无衬线，用系统字体栈，不打包字体文件。
- **参考图里的横幅与封面是摄影图，任务书明确要求不要硬塞摄影图当默认封面**：横幅用「主题强调色渐变 + 噪点」，封面用「标题哈希生成的渐变色块 + 首字大号衬线字」；允许用户在设置里选本地图片做横幅背景（叠暗角保证文字可读）。
- 章节眉标「第 1 章」**仅当一级标题以数字或「第…章」开头才显示**，否则不显示，不要伪造。

## 5. 阶段 C 怎么接（顺序按任务书：C1 → C6）

已有的底座可以直接用，**界面本身目前还是 M2 的样子（顶栏 + 列表卡片 + FAB）**：

| 任务 | 已有 | 你要做的 |
|---|---|---|
| C1 底部导航 | 玻璃类 `.glass`、图标 `shelf/search/plus/chart/settings`、`nav/tab` action、`Tab` 类型 | 五项：书架、搜索、**中间凸起圆形「＋」导入（琥珀金）**、统计、设置。需要新增 `search`、`stats` 两个 Tab（改 `core/types.ts` 的 `Tab` 并补 `nav.test.ts`）；阅读页隐藏底部导航（用阅读底栏）。选中项图标变强调色 + 上浮缩放（动效细节属 D，先用令牌写好过渡）。 |
| C2 书架 | `.ui-card`、`chip`、`icon('play')`、`--r-xl` | 顶栏（logo+应用名，右侧搜索/更多，滚动后淡入玻璃）、Hero 轮播（今日一句/继续阅读/导入引导，**渐变+噪点**，先把 `--noise` 令牌补进 tokens.css）、「继续阅读」横向卡（进度条 + 圆形播放键）、三列网格封面（哈希取色）、网格/列表切换、排序、长按多选、空状态。 |
| C3 阅读壳层 | `layers.ts`、`kit` 的玻璃演示 | 顶栏（返回/标题居中省略/搜索/书签/更多）随滚动方向收放、点击空白切沉浸模式；阅读底栏（`已读 23%` + 进度条 + `Aa` + 亮度/主题 + 下一章）；`Aa` bottom sheet（字号滑块、行距、段距、字体、主题、背景色）。**排版档位仍走根节点 `data-*` 属性，不要改成直接写 px。** |
| C4 正文精修 | `--r-media` | 图片圆角 12 + 点击全屏放大（可双指缩放）、引用块（浅底 + 强调色竖线 + 引号装饰）、任务清单自绘勾选框、代码块复制按钮 + 轻量高亮、表格斑马纹。这些在 `core/markdown.ts` 的输出与 `styles/app.css`，注意 markdown 测试（`html:false`、`data-bid` 规则）。 |
| C5 设置页 | `components.ts`、外观区已做 | 按任务书 2.6 分区（外观/阅读/数据/查词/关于）、每项带图标与一行说明；把旧 `stepper` 换成统一组件。**注意 `tools/verify-typography.mjs` 依赖 `type-scale-increase/decrease`，换组件要么保留这些 testid，要么同步更新该脚本。** |
| C6 统计页 | — | **需要 IndexedDB 迁移**：`data/db.ts` 当前 `DB_VERSION = 1`，要升到 2 并新增 `sessions` 表；**必须带迁移测试，旧数据可读**（任务书总原则 5）。统计页自绘 SVG 柱状图，没数据就显示空状态。 |

C 阶段的验收（任务书）：**每页在「夜间·暖黑」「日间·米纸」两套主题下各截一张图**，对照 `docs/design/reference.webp` 写差异清单；无错位、无溢出，状态栏/刘海/手势条安全区正确（用 `--safe-top` / `--safe-bottom`，**不要自己写 `padding-top: 24px`**）。截图存 `docs/screenshots/C/`。

### 一个需要你决定/确认的小点

- `index.html` 里 `<html>` 的静态默认属性是 `data-theme="paper"`，而应用默认主题现在是 `system`。JS 执行前会有一帧旧主题闪现。要不要把默认静态属性改成 `warm-paper`，或在 `<head>` 里加一段同步脚本在首帧读取设置——这是个值得顺手收拾的小债，改的时候留意 `data-scheme` 也要同步。

## 6. 环境与坑（我踩过的，别重复踩）

1. **这个终端会吃反斜杠。** 用 `bash` 的 heredoc / `node -e` / `sed` 写带正则或 `\` 的内容时，转义经常被破坏（我遇到过很多次，包括正则里的 `\/`、`\n` 被吞）。**改文件请用 Write / Edit 工具；需要脚本逻辑就写成 `.cjs` 文件再运行**，或者避免正则（我给 `check-tokens.mjs` 和 `contrast.test.ts` 写的注释剥离就是用 `indexOf` 循环）。
2. **没有 Python。** 别用 `python3`。
3. **`npm ci` 先跑**，工作树里一开始没有 `node_modules`。
4. **vitest 默认会把 `.css` 内容清空。** `contrast.test.ts` 用 `import x from '...css?raw'` 读令牌原文，所以 `vite.config.ts` 里加了 `test.css.include: [/tokens.*\.css/]`。**新增以 `tokens` 开头的令牌文件会自动被读到；改名会让对比度测试读到空串并全红。**
5. **Chrome 把 `0ms` 序列化成 `0s`**——断言时间令牌要两种都认。
6. **Android 构建**（`npm run android:build`）在新工作树里需要：
   ```bash
   npx cap sync android          # 生成 capacitor-cordova-android-plugins/
   ```
   并需要 `android/local.properties`（被 git 忽略）。我从主仓库复制过：`cp "C:/Users/30462/Desktop/徐上茗工作空间/Mdowner/android/local.properties" android/local.properties`（里面 `sdk.dir` 是 Windows 风格路径，指向 Workbuddyspace/.android-sdk，直接复制别手敲）。JDK 在 `/d/Tools/jdk21`。产物是 **debug 包**。
7. **真实 Chrome 路径**写在 `tools/smoke-chrome.mjs` / `tools/shot-kit.mjs` 的 `CHROME_CANDIDATES`；两个脚本用不同调试端口（9333 / 9334）。`shot-kit` 会先构建 `--mode kit` 到 `www-kit/`（已 gitignore）。
8. **组件展示页 `#/kit`** 只在 `npm run dev` 或 `--mode kit` 构建可见（`KIT_ENABLED`）；正式构建里被摇树掉。想给新组件做目检，就把它加进 `views/kit.ts`，并在 `tools/shot-kit.mjs` 里补断言/截图。
9. **`check:state` 只认 `state` / `S` / `appState` 这几个变量名**，视图里别写 `state.xxx = ...`。`check:boundaries`：`core` 不得依赖 `data/views/state`，`views` 不得碰 `indexedDB/localStorage/fetch`。
10. 提交信息约定见 `docs/CONVENTIONS.md`（修复类要带 `Evidence:`）。本会话的提交末尾带 `Co-Authored-By` 署名行。
11. 这是个 **git worktree**，别 `cd` 到主仓库；`git stash` 是共享的，别用裸 `git stash`。

## 7. 发布

- **`v0.5.2`（预发布，A+B 合并）已经由用户发布，不要重复发布。** 版本号 0.5.2 由 `e69995c` 对齐。
- 发布权在用户手里：我的 `gh release create` 曾被权限分类器拦下（它会往公开仓库 `Yuvzol0932/Mdlego` 发带 APK 的版本），**没有绕过**，后来用户自己发了。你若被拦，同样**停下来告诉用户**，不要换工具硬发。
- 阶段 C 之后的下一次发布，版本号走 `package.json`（单一来源，Gradle 自动推导 versionCode），**先问用户**要不要发、发什么版本号。流程参考：`npm run verify` → `npm run android:build` → 产物 `android/app/build/outputs/apk/debug/app-debug.apk`；说明里写明「debug 包、是否真机验证」。往期发布惯例见 `gh release view v0.1.0-m2`（附 APK 与 SHA256）。

## 8. 已知债务与取舍（诚实清单）

- 噪点纹理（`--noise`）**未做**，属 C2；B 阶段的第二次写入里为避免出错没有放进去。
- `「动效：简约」`只有令牌无逻辑（D 阶段）。
- 旧 CSS（`app.css` / `library.css`）里的 `.btn`、`.switch`、`.segmented`、`.stepper`、`.fab`、`.doc-item` 等仍在使用，**统一组件 `.ui-*` 与它们并存**。C 阶段逐页替换后记得删旧类，别留两套。
- `index.html` 的首帧主题闪现（见 §5 末尾）。
- 设置里的 `focusMode`、`lookupEnabled` 沿用 M2/M5，没动。
- `web/public/dict`（11MB，几百个词库分片）仍在仓库里；任务书第 1 节把它列为臃肿来源，但 A3 只明确要求清 `artifacts/`，我没动它。是否迁出请先问用户。
- 阶段 B 的色值是目测的，用户未逐一确认；**没有真机验证**。

## 9. 目录速查（本次新增/变化）

```
docs/HANDOFF-A-B.md          本文
docs/DECISION-render-A.md    阶段 A 渲染/路由决策（不新增渲染库）
docs/PHASE-B.md              阶段 B 验收与差异清单
docs/design/reference.webp   参考图
docs/screenshots/A|B/        阶段截图
tools/shot-kit.mjs           阶段 B 截图 + 材质/玻璃层数断言（npm run shot:kit）
web/src/core/nav.ts          页面栈/浮层栈（纯）
web/src/core/theme.ts        主题/强调色/材质解析（纯）
web/src/core/contrast.ts     WCAG 对比度（纯）
web/src/views/layers.ts      浮层宿主
web/src/views/icons.ts       图标精灵
web/src/views/components.ts  统一组件
web/src/views/kit.ts         #/kit 展示页（开发期）
web/src/styles/tokens-themes.css  主题/强调色/玻璃/动效强度令牌
web/src/styles/glass.css     玻璃（唯一允许 backdrop-filter 的文件）
web/src/styles/components.css     .ui-* 组件样式
```

## 10. 一句话总结给接手的你

地基（路由、局部更新、令牌、玻璃、组件、主题）已经铺好并有测试守着；**接下来的工作是在这块地基上「把界面按参考图搭起来」**——用现成的令牌和组件，别另起炉灶；每做完一页就数玻璃层、拍两套主题截图、写差异清单；做完阶段 C 就停下来汇报，等用户决定下一步。
