#!/usr/bin/env node
/**
 * 阶段 C 验收夹具：6 篇真实感的中文 Markdown 文档。
 *
 * 注意：这是测试夹具，不是产品内置内容。仅由 tools/shot-c.mjs 通过 seed-c.mjs
 * 写进临时 Chrome 的 IndexedDB，用来在书架上造出「近几天的阅读痕迹」。
 *
 * 字段严格按 web/src/core/types.ts 的 Doc：
 *   id / title / text / encoding / source / fingerprint / importedAt / lastReadAt / progress
 *
 * 长文里内联的图片是运行时生成的 320x180 暖色渐变 PNG（data URI），
 * 生成逻辑在 makeGradientPng：不依赖任何图片文件，也不需要外部依赖。
 */
import { deflateSync } from 'node:zlib';

// ─────────────────────────────────────────────
// 内联渐变 PNG（320x180）
// ─────────────────────────────────────────────

/** CRC32 查表，PNG 每个 chunk 都要用。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 组装一个 PNG chunk：长度 + 类型 + 数据 + CRC。 */
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBytes = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

/**
 * 生成一张 320x180 的暖色渐变 PNG，返回 base64（不含 data: 前缀）。
 *
 * 用 256 级索引调色板 + Up 行过滤（每行存相对上一行像素的差值）。
 * 渐变相邻行只差几个色阶，差值几乎全是 0，deflate 后不到 2KB，
 * 适合内联进 Markdown 的 data URI。
 */
export function makeGradientPng(width = 320, height = 180) {
  // 从暖米纸色渐变到陶土色，再压深成暖黑 —— 和阅读器的暖夜配色同一家族。
  const from = [236, 205, 168];
  const to = [78, 46, 38];
  const palette = Buffer.alloc(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    for (let c = 0; c < 3; c++) palette[i * 3 + c] = Math.round(from[c] + (to[c] - from[c]) * t);
  }

  const stride = width; // 调色板索引：每像素 1 字节
  const raw = Buffer.alloc((stride + 1) * height);
  const prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 2; // filter type 2 = Up
    const row = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) {
      const tx = width > 1 ? x / (width - 1) : 0;
      const ty = height > 1 ? y / (height - 1) : 0;
      // 斜向渐变，左上偏亮、右下偏暗
      const t = Math.min(1, Math.max(0, tx * 0.55 + ty * 0.45));
      row[x] = Math.round(t * 255);
    }
    // Up 过滤：存本行与上一行的差值（需要先与 prev 比较完再覆盖）
    for (let i = stride - 1; i >= 0; i--) {
      raw[rowStart + 1 + i] = (row[i] - prev[i]) & 0xff;
    }
    row.copy(prev);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // color type: indexed palette
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', palette),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return png.toString('base64');
}

/** 长文里内联的图片 data URI。 */
export const INLINE_IMAGE_BASE64 = makeGradientPng(320, 180);
export const INLINE_IMAGE_DATA_URI = `data:image/png;base64,${INLINE_IMAGE_BASE64}`;

// ─────────────────────────────────────────────
// 长文：Markdown 进阶指南（约 120 行）
// ─────────────────────────────────────────────

const LONG_TEXT = [
  '# Markdown 进阶指南',
  '',
  '> 写给已经会写 Markdown、想把笔记变成长期资产的人。',
  '',
  '大多数人第一次接触 Markdown，是在某个项目的 README 里。它看起来像纯文本，却能在需要的时候变成整齐的网页。真正把它用起来之后你会发现，语法从来不是难点——难点是**怎么组织内容**。',
  '',
  `![暖色渐变插图](${INLINE_IMAGE_DATA_URI})`,
  '',
  '## 为什么选择 Markdown？',
  '',
  '答案通常有三个层次。',
  '',
  '第一是**可移植**。Markdown 的本质是文本。二十年后的编辑器未必还能打开今天的富文本格式，但一定能打开一个 .md 文件。',
  '',
  '第二是**可版本化**。纯文本的差异逐行可见，`git diff` 会精确告诉你改了哪一句话，而不是丢给你一个看不懂的二进制补丁。',
  '',
  '第三是**可转换**。同一份源文件可以渲染成网页、导出成 PDF、塞进静态站点，不需要维护三套互相打架的内容。',
  '',
  '### 一条够用的分层规则',
  '',
  '把内容分成三层，写作时就不容易乱：',
  '',
  '- **标题层**：只用 `#` 到 `###`，每一级都回答「这一段在讲什么」。',
  '- **段落层**：一个自然段只讲一件事，超过五行就考虑拆开。',
  '- **辅助层**：引用、清单、表格、代码块，只在能降低阅读成本时使用。',
  '',
  '## 文件结构：从第一天就可维护',
  '',
  '推荐每个主题一个文件，文件名用日期加短标题：',
  '',
  '```bash',
  'notes/',
  '  2026-03-01-markdown-advanced.md',
  '  2026-03-04-reading-method.md',
  '  drafts/',
  '    2026-03-05-design-system.md',
  '```',
  '',
  '文件名里的日期不是给机器看的，是给半年后的自己看的。你未必记得内容，但通常记得「大概是三月初写的」。',
  '',
  '## 写作节奏：先写后改',
  '',
  '把写作拆成两遍，效率会明显变高：',
  '',
  '1. **粗写**：只管把想法倒出来，不回头改句子，不纠结格式。',
  '2. **精修**：第二天再读一遍，删掉重复的段落，把长句拆短，补上标题。',
  '',
  '> 好文章是改出来的，不是写出来的。第一遍的目标只有一个：让第二遍有东西可改。',
  '',
  '## 任务清单：让待办留在上下文里',
  '',
  '待办写进正文，比单独建一个清单更有上下文：',
  '',
  '- [x] 把零散的速记合并成一个主题文件',
  '- [x] 给每个二级标题写一句摘要',
  '- [ ] 删除三处重复论述',
  '- [ ] 给代码示例补上语言标记',
  '',
  '清单的勾选状态只存在应用内，不会改写原文——这一点很重要，原文应该始终是干净的。',
  '',
  '## 表格：把对比压进同一行',
  '',
  '当你在比较三个以上的选项时，表格比段落更省读者的力气。',
  '',
  '| 写法 | 适合的场景 | 注意点 |',
  '| --- | --- | --- |',
  '| 无序清单 | 并列的要点 | 超过七条就该分组 |',
  '| 有序清单 | 有先后顺序的步骤 | 步骤之间别跳步 |',
  '| 表格 | 多维度的对比 | 列数不要超过四列 |',
  '| 引用块 | 强调一段独立的话 | 不要整篇文章都是引用 |',
  '',
  '## 代码：让示例可复制',
  '',
  '围栏代码块一定要带语言标记。它决定了高亮的规则，也决定了别人能不能直接把示例跑起来。',
  '',
  '```ts',
  'interface Note {',
  '  readonly id: string;',
  '  readonly title: string;',
  '  readonly text: string;',
  '}',
  '',
  'export function wordCount(note: Note): number {',
  '  const words = note.text.trim().split(/ +/);',
  '  return words.filter((w) => w.length > 0).length;',
  '}',
  '```',
  '',
  '同一段示例也可以写成配置文件的形式，方便复制到项目里：',
  '',
  '```json',
  '{',
  '  "theme": "warm-night",',
  '  "material": "glass",',
  '  "typeScale": 3',
  '}',
  '```',
  '',
  '## 引用块：把别人的话和自己的话分开',
  '',
  '> 阅读不是为了记住每一个字，而是为了在需要的时候知道自己该回到哪里。',
  '',
  '引用块适合放三类内容：原文摘录、需要强调的结论、以及和自己观点明确分开的他人表述。',
  '',
  '## 标题的写法：让目录可读',
  '',
  '标题是目录的原料。判断一个标题好不好，最简单的办法是只看目录，问自己能不能看懂整篇文章的结构。',
  '',
  '- 标题里不要出现编号，编号由渲染器生成，手写编号在插入新章节时就成了负担。',
  '- 同级标题保持相近的抽象层次，不要一个讲概念、一个讲操作。',
  '- 标题可以长一点，但不要长到折行；折行的标题在目录里会被截断。',
  '',
  '## 阅读与批注的配合',
  '',
  '一篇值得反复读的长文，通常会被批注三次以上。第一次标记事实，第二次标记疑问，第三次才写下自己的判断。',
  '',
  '批注和正文分开存储的好处是：原文一个字都不改，而你的理解可以一层层叠上去。等到某天原文更新，批注还能按上下文重新定位，而不是直接消失。',
  '',
  '## 常见误区',
  '',
  '- 用空行手动控制间距，而不是用标题层级。',
  '- 在正文里堆砌装饰性符号，让内容看起来比实际更有结构。',
  '- 把整个文件写成一个大列表，失去段落之间的过渡。',
  '- 只在开头写标题，后文不再分节，读者滚到一半就迷路。',
  '',
  '## 小结',
  '',
  'Markdown 的价值不在语法本身，而在于它把「内容」和「表现」分开了。等你写了一百篇之后，真正起作用的往往是最朴素的几条：标题分级、一段一事、清单克制、代码可复制。',
  '',
  '把这几条守住，文件放三年也还能读。',
].join('\n');

// ─────────────────────────────────────────────
// 5 篇短文
// ─────────────────────────────────────────────

const TECH_WRITING_TEXT = [
  '# 技术写作指南',
  '',
  '> 写得清楚，是一种可以被训练的能力。',
  '',
  '技术文档最常见的毛病不是写得不够多，而是读者读完不知道结论是什么。',
  '',
  '## 先写结论',
  '',
  '每一篇文档、每一节的开头，先用一两句话回答「所以呢」。原因、背景、推导过程放在后面。',
  '',
  '## 一个段落只做一件事',
  '',
  '段落的功能写清楚，读者才能跳读。如果你自己都说不出这段在做什么，就说明它该拆了。',
  '',
  '## 术语要统一',
  '',
  '同一个概念只用一种叫法。第一次出现时给出定义，之后不要再换同义词。',
  '',
  '## 检查清单',
  '',
  '- [x] 第一段是否给出结论',
  '- [x] 每个段落是否只有一个主题',
  '- [ ] 术语是否前后一致',
  '- [ ] 有没有可以直接删掉的形容词',
  '',
  '## 最后一步：读出声来',
  '',
  '把文档朗读一遍，凡是读起来打结的地方，基本都是句子太长了。',
].join('\n');

const DESIGN_SYSTEM_TEXT = [
  '# 设计系统入门',
  '',
  '> 设计系统不是组件库，而是一套共同的语言。',
  '',
  '很多团队做设计系统的第一步是画组件，最后得到一堆漂亮的按钮，却没有任何人遵守规则。',
  '',
  '## 三个层次',
  '',
  '1. **令牌**：颜色、字号、行高、间距、圆角、动效时长。',
  '2. **组件**：按钮、输入框、卡片、导航，只消费令牌，不写魔法数字。',
  '3. **规则**：什么时候用哪个组件，什么情况下允许例外。',
  '',
  '## 令牌先行',
  '',
  '令牌是唯一值得一开始就死抠的部分。颜色按语义命名（表面、正文、强调），而不是按色相命名（灰色、红色）。',
  '',
  '## 组件的边界',
  '',
  '一个组件只做一件事。按钮负责「可点击」，不负责「加载中要不要显示文案」。',
  '',
  '> 设计系统不是把页面做统一，而是让统一不依赖某个人记得住。',
  '',
  '## 常见误解',
  '',
  '- 以为设计系统是一次性项目，实际上它需要持续维护。',
  '- 以为统一就是所有页面长得一样，实际上统一的是规则，不是长相。',
  '- 以为组件越多越好，实际上能被正确使用的组件越少越好。',
].join('\n');

const LIFE_WISDOM_TEXT = [
  '# 人生的智慧',
  '',
  '> 一个人如何安排自己的生活，比命运给了他什么更接近「幸福」这个词。',
  '',
  '## 关于独处',
  '',
  '独处不是把自己关起来，而是留出一段不被打扰的时间，让想法有机会沉淀。',
  '',
  '能安静地待上一个下午的人，通常不太容易被别人的情绪牵着走。',
  '',
  '## 关于欲望',
  '',
  '欲望本身没有问题，问题在于把「想要」当成了「需要」。',
  '',
  '每隔一段时间，把想买、想做、想达成的事情列出来，逐条问一句：如果没有它，我的生活真的会变差吗？',
  '',
  '## 关于时间',
  '',
  '时间最公平的地方在于，它不允许储存。今天没用完的注意力，明天不会加倍奉还。',
  '',
  '> 把时间花在会积累的事情上：读过的书、写下的字、认真维护的关系。',
  '',
  '## 一句提醒',
  '',
  '不要为了显得忙碌，把日程填满。留白不是浪费，是给重要的事情腾出位置。',
].join('\n');

const OFFLINE_FIRST_TEXT = [
  '# 离线优先笔记',
  '',
  '> 网络是奢侈品，不是前提。',
  '',
  '地铁、飞机、电梯、山区——一个人每天总有一段时间没有网络。如果笔记应用在这段时间里只能转圈，那它就不算可靠。',
  '',
  '## 数据先落本地',
  '',
  '写入永远先落在本地数据库，同步是之后的事。用户按下保存的那一刻，数据就应该已经在磁盘上了。',
  '',
  '## 冲突是常态',
  '',
  '离线修改、在线修改，两边都改同一段内容时，冲突是必然的。与其假装不会发生，不如提前决定：保留哪一份、怎么合并、失败时怎么告诉用户。',
  '',
  '## 同步的三个原则',
  '',
  '- 先写本地，再排队上云。',
  '- 网络恢复时按顺序重放，不并发抢写。',
  '- 任何一步失败都要能解释清楚，而不是静默丢弃。',
  '',
  '## 清单',
  '',
  '- [x] 本地数据库写入完成后再更新界面',
  '- [x] 同步队列在应用重启后仍在',
  '- [ ] 冲突时展示两个版本供用户选择',
  '- [ ] 断网超过三天时提醒检查存储空间',
  '',
  '## 离线不是降级',
  '',
  '离线能力不是「有网时的简化版」，而是产品可靠性的底线。把这条底线守住，在线功能才有意义。',
].join('\n');

const READING_NOTES_TEXT = [
  '# 阅读方法札记',
  '',
  '> 读得快不是目的，读得进去才是。',
  '',
  '## 三遍读法',
  '',
  '第一遍通读，不求记住，只求知道作者想解决什么问题。',
  '',
  '第二遍带着问题读，把答案所在的段落折角或标记，读完之后用自己的话写三句摘要。',
  '',
  '第三遍只读标记过的位置，检查自己的理解有没有被原文修正。',
  '',
  '## 摘录与转述',
  '',
  '摘录容易，转述难。摘录只是复制，转述才逼你确认自己真的理解了。',
  '',
  '> 如果一段话你无法用自己的语言说出来，那你大概还没有读懂它。',
  '',
  '## 什么时候放弃一本书',
  '',
  '- 读了三分之一，仍然说不出作者的核心主张。',
  '- 每一章都在重复同一句话，只是换了例子。',
  '- 内容已经过时，且你只是想找资料，不是想读它。',
  '',
  '放弃不是失败。人的阅读时间是有限的，把它留给更值得的书。',
].join('\n');

// ─────────────────────────────────────────────
// 文档夹具
// ─────────────────────────────────────────────

const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * 构建 6 篇夹具文档。
 *
 * @param {number} now 当前时间（毫秒），可注入以便测试稳定。
 * @returns {Array<import('../../web/src/core/types').Doc>} 文档数组（纯数据，可直接 structuredClone）。
 */
export function buildFixtureDocs(now = Date.now()) {
  /** 基础内容：id / 标题 / 正文 / 阅读时间偏移 / 进度。 */
  const base = [
    {
      id: 'fixture-markdown-advanced',
      title: 'Markdown 进阶指南',
      text: LONG_TEXT,
      offset: 2 * HOUR,
      progress: { bid: 'b-fixture-mk-01', ratio: 0.42 },
    },
    {
      id: 'fixture-tech-writing',
      title: '技术写作指南',
      text: TECH_WRITING_TEXT,
      offset: 1 * DAY,
      progress: null,
    },
    {
      id: 'fixture-design-system',
      title: '设计系统入门',
      text: DESIGN_SYSTEM_TEXT,
      offset: 2 * DAY,
      progress: null,
    },
    {
      id: 'fixture-life-wisdom',
      title: '人生的智慧',
      text: LIFE_WISDOM_TEXT,
      offset: 3 * DAY,
      progress: null,
    },
    {
      id: 'fixture-offline-first',
      title: '离线优先笔记',
      text: OFFLINE_FIRST_TEXT,
      offset: 4 * DAY,
      progress: null,
    },
    {
      id: 'fixture-reading-notes',
      title: '阅读方法札记',
      text: READING_NOTES_TEXT,
      offset: 5 * DAY,
      progress: { bid: 'b-fixture-read-03', ratio: 0.18 },
    },
  ];

  return base.map((item, index) => ({
    id: item.id,
    title: item.title,
    text: item.text,
    encoding: 'utf-8',
    source: { kind: 'inline' },
    fingerprint: null,
    importedAt: now - (30 - index) * DAY,
    lastReadAt: now - item.offset,
    progress: item.progress,
  }));
}

/** 默认时间快照下的一组夹具（shot-c 直接使用）。 */
export const FIXTURE_DOCS = buildFixtureDocs();

/** 方便脚本做数量与唯一性自检。 */
export const FIXTURE_META = {
  count: FIXTURE_DOCS.length,
  longDocLines: LONG_TEXT.split('\n').length,
  imageBytes: Buffer.from(INLINE_IMAGE_BASE64, 'base64').length,
  imageBase64Length: INLINE_IMAGE_BASE64.length,
};
