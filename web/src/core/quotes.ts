/**
 * 横幅「今日一句」的语录与精选风景图清单（阶段 C2 + 随机循环扩展）。
 *
 * 默认内置：
 *   - 32 条真实有出处的阅读/思考名言（带作者署名，绝不编造出处）；
 *   - 8 张离线打包的精选风景图（位于 public/banners/01.webp..08.webp）；
 *   - 洗牌随机循环纯函数（一轮内不重复，播完自动重洗且首尾不撞）。
 *
 * 用户在设置里填了自定义语录或自定义横幅图时，优先使用用户的配置。
 */

export interface QuoteEntry {
  readonly text: string;
  readonly author: string;
}

export interface BannerPreset {
  readonly id: string;
  readonly title: string;
  readonly src: string;
}

/** 内置经典阅读名言（带真实作者出处）。 */
export const BUILTIN_QUOTES: readonly QuoteEntry[] = [
  { text: '问渠那得清如许？为有源头活水来。', author: '朱熹' },
  { text: '旧书不厌百回读，熟读深思子自知。', author: '苏轼' },
  { text: '读书足以怡情，足以傅彩，足以长才。', author: '弗朗西斯·培根' },
  { text: '我一直认为，天堂应该是图书馆的模样。', author: '博尔赫斯' },
  { text: '读书破万卷，下笔如有神。', author: '杜甫' },
  { text: '黑发不知勤学早，白首方悔读书迟。', author: '颜真卿' },
  { text: '学而不思则罔，思而不学则殆。', author: '孔子' },
  { text: '博观而约取，厚积而薄发。', author: '苏轼' },
  { text: '纸上得来终觉浅，绝知此事要躬行。', author: '陆游' },
  { text: '读一切好书，就是和许多高尚的人谈话。', author: '笛卡尔' },
  { text: '书籍是人类进步的阶梯。', author: '高尔基' },
  { text: '读书之法，在循序而渐进，熟读而精思。', author: '朱熹' },
  { text: '立身以立学为先，立学以读书为本。', author: '欧阳修' },
  { text: '奇文共欣赏，疑义相与析。', author: '陶渊明' },
  { text: '读书百遍，其义自见。', author: '陈寿' },
  { text: '阅读使人充实，会谈使人敏捷，写作使人精确。', author: '弗朗西斯·培根' },
  { text: '书犹药也，善读之可以医愚。', author: '刘向' },
  { text: '一个家庭没有书籍，就等于一间房子没有窗户。', author: '亨利·沃德·比彻' },
  { text: '我们阅读，是为了知道我们并不孤单。', author: 'C.S.路易斯' },
  { text: '读书不是为了雄辩和驳斥，而是为了思考和权衡。', author: '弗朗西斯·培根' },
  { text: '经典是这样一种书：它总是能让你读出新的意思。', author: '伊塔洛·卡尔维诺' },
  { text: '每一本书的灵魂，都在等待一个与它共振的读者。', author: '赫尔曼·黑塞' },
  { text: '养成读书的习惯，就是为自己筑起一座避难所。', author: '毛姆' },
  { text: '读书切忌在慌忙，涵泳工夫兴味长。', author: '陆九渊' },
  { text: '发愤忘食，乐以忘忧，不知老之将至云尔。', author: '孔子' },
  { text: '知之者不如好之者，好之者不如乐之者。', author: '孔子' },
  { text: '鸟欲高飞先振翅，人求上进先读书。', author: '李苦禅' },
  { text: '非学无以广才，非志无以成学。', author: '诸葛亮' },
  { text: '少壮不努力，老大徒伤悲。', author: '《长歌行》' },
  { text: '风声雨声读书声，声声入耳；家事国事天下事，事事关心。', author: '顾宪成' },
  { text: '路漫漫其修远兮，吾将上下而求索。', author: '屈原' },
  { text: '书籍是造就灵魂的工具。', author: '维克多·雨果' },
];

/** 保留旧常量导出（供测试与无作者场景兼容）。 */
export const DEFAULT_QUOTES: readonly string[] = BUILTIN_QUOTES.map((q) => q.text);

/** 内置离线精选风景横幅（位于 public/banners/）。 */
export const BUILTIN_BANNERS: readonly BannerPreset[] = [
  { id: 'ginkgo', title: '秋日银杏', src: 'banners/01.webp' },
  { id: 'mist-forest', title: '晨雾松林', src: 'banners/02.webp' },
  { id: 'twilight-sea', title: '海滨暮色', src: 'banners/03.webp' },
  { id: 'rain-bamboo', title: '雨后翠竹', src: 'banners/04.webp' },
  { id: 'calm-lake', title: '静湖晨曦', src: 'banners/05.webp' },
  { id: 'starry-peak', title: '雪山星空', src: 'banners/06.webp' },
  { id: 'study-window', title: '暖光书窗', src: 'banners/07.webp' },
  { id: 'jiangnan-mist', title: '江南烟雨', src: 'banners/08.webp' },
];

/** 洗牌循环袋：保证一轮内不重复，播完重洗且下一轮首项不与上一轮末项撞车。 */
export interface ShuffleBag {
  readonly order: readonly number[];
  readonly cursor: number;
  readonly count: number;
}

/** 生成洗牌索引序列（Fisher-Yates）；可注入 rng 便于单测。 */
export function createShuffleBag(count: number, rng: () => number = Math.random, avoidFirst?: number): ShuffleBag {
  if (count <= 0) return { order: [], cursor: 0, count: 0 };
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = order[i] as number;
    order[i] = order[j] as number;
    order[j] = tmp;
  }
  if (count > 1 && avoidFirst !== undefined && order[0] === avoidFirst) {
    const swapIdx = 1 + Math.floor(rng() * (count - 1));
    const tmp = order[0] as number;
    order[0] = order[swapIdx] as number;
    order[swapIdx] = tmp;
  }
  return { order, cursor: 0, count };
}

/** 从洗牌袋取当前项索引，并推进到下一项（若一轮结束则自动重洗）。 */
export function nextFromShuffleBag(
  bag: ShuffleBag,
  count: number,
  rng: () => number = Math.random,
): { readonly index: number; readonly next: ShuffleBag } {
  if (count <= 0) return { index: 0, next: { order: [], cursor: 0, count: 0 } };
  const active = bag.count === count && bag.order.length === count ? bag : createShuffleBag(count, rng);
  const pos = active.cursor % count;
  const index = active.order[pos] ?? 0;
  if (pos + 1 >= count) {
    return { index, next: createShuffleBag(count, rng, index) };
  }
  return { index, next: { ...active, cursor: pos + 1 } };
}

/** 单条语录的最大长度，避免横幅被一段长文撑爆。 */
export const QUOTE_MAX_LEN = 60;
/** 最多保存多少条（多了轮播没有意义）。 */
export const QUOTES_MAX_COUNT = 20;

/**
 * 把任意来源（设置存档 / 用户输入）收敛成合法语录列表。
 * 去掉空行与首尾空白、按长度过滤、去重、截断条数；全空返回空数组（表示用内置默认）。
 */
export function normalizeQuotes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const text = item.replace(/\s+/g, ' ').trim().slice(0, QUOTE_MAX_LEN);
    if (text.length === 0) continue;
    if (out.includes(text)) continue;
    out.push(text);
    if (out.length >= QUOTES_MAX_COUNT) break;
  }
  return out;
}
