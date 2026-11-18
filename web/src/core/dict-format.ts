/**
 * 词典条目的**显示**整形（lookup #7）。
 *
 * ECDICT 是给程序读的，直接上屏会露出三类毛病：
 *   1. 音标用的是非标准字符：ASCII 撇号 `'`、西里尔 schwa `ә`(U+04D9)、
 *      希腊 epsilon `ε`(U+03B5)、西里尔 `є`(U+0454)、上标尖 `ˊ`(U+02CA)、
 *      `ū`(U+016B) —— 它们长得像国际音标但不是，读屏软件与复制粘贴都会走样
 *   2. 释义里混着半角逗号 `,` 与分号 `;`（中文正文里应当是全角）
 *   3. 词性 `n.` / `vt.` / `a.` 与释义挤在同一行，视觉上没有层次
 *
 * 这一层只做**纯字符串变换**：不碰 DOM、不碰 IO，因此在 core（可被单测直接覆盖）。
 * 无法识别的字符一律原样保留 —— 宁可显示得难看，也不能把音标改错。
 */

/** 词性标签：ECDICT 里出现过的写法，按长度倒序匹配（`adv.` 必须先于 `a.`）。 */
export const POS_TAGS = [
  'adv.',
  'adj.',
  'int.',
  'conj.',
  'prep.',
  'pron.',
  'num.',
  'aux.',
  'art.',
  'vt.',
  'vi.',
  'v.',
  'n.',
  'a.',
  'ad.',
  'abbr.',
] as const;

export type PosTag = (typeof POS_TAGS)[number];

/** 一行释义的结构拆分结果。 */
export interface TranslationLine {
  /** 行首词性标签；没有则为 null。 */
  readonly pos: PosTag | null;
  /** 去掉词性标签后的释义正文（已做中文标点转换）。 */
  readonly text: string;
  /** 方括号领域标注（如 `[化]`）；没有则为 null。 */
  readonly domain: string | null;
}

/**
 * 音标字符替换表。
 *
 * 左列是 ECDICT 里实际出现过的非标准字符（按真实词库统计，见本文件末尾用例），
 * 右列是它们对应的国际音标符号。`ŋ ʃ ʒ θ ð ʌ ʊ ɔ ɑ ɪ ʊ ɡ` 这些本来就是标准符号，
 * 一个都不动 —— 之前把它们也「转」一遍是错的。
 */
const PHONETIC_MAP: Readonly<Record<string, string>> = {
  // 撇号家族 → 主重音符号
  "'": 'ˈ',
  '’': 'ˈ',
  '`': 'ˈ',
  // ECDICT 用上标尖表示重音
  'ˊ': 'ˈ',
  // 西里尔 schwa U+04D9 → 拉丁 schwa U+0259（16623 条，是最高频的错字）
  'ә': 'ə',
  // 希腊 epsilon U+03B5 / 西里尔 є U+0454 → 拉丁 ɛ U+025B
  'ε': 'ɛ',
  'є': 'ɛ',
  // 长音 u
  'ū': 'uː',
};

/**
 * 规范化音标。
 *
 * 只做「确定的字符映射」+ 统一的方括号包裹，不做任何音系推断：
 * 例如 `e` 到底该读 `e` 还是 `ɛ` 取决于具体词，这里绝不猜。
 */
export function normalizePhonetic(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  let out = '';
  for (const ch of trimmed) out += PHONETIC_MAP[ch] ?? ch;
  // 去掉可能已经存在的方括号，统一由这里加（避免出现 /['prɒspekt/] 这种）
  out = out.replace(/^[[/]+/, '').replace(/[\]]+$/, '').replace(/\/$/, '');
  return out;
}

/** 是否含中日韩文字（决定要不要把半角标点换成全角）。 */
function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(text);
}

/**
 * 中文标点转换。
 *
 * 只处理「贴在中日韩文字旁边」的 `,` 与 `;`：
 *   `景色, 展望`   → `景色，展望`
 *   `坚持; 维持`   → `坚持；维持`
 * 而 `1,000`、`a, b`（纯英文）保持原样 —— 它们不是中文标点。
 */
export function normalizePunctuation(text: string): string {
  if (!hasCjk(text)) return text;
  return text
    .replace(/([\u3400-\u9fff\uf900-\ufaff])\s*,\s*/g, '$1，')
    .replace(/,\s*(?=[\u3400-\u9fff\uf900-\ufaff])/g, '，')
    .replace(/([\u3400-\u9fff\uf900-\ufaff])\s*;\s*/g, '$1；')
    .replace(/;\s*(?=[\u3400-\u9fff\uf900-\ufaff])/g, '；');
}

/** 匹配行首词性标签（含可选的 `[领域]` 前缀）。 */
function splitPos(line: string): { pos: PosTag | null; rest: string } {
  for (const tag of POS_TAGS) {
    if (!line.toLowerCase().startsWith(tag)) continue;
    const after = line.slice(tag.length);
    // `n.` 后面必须跟空白或中文，否则 `n.a.` 这类缩写会被误切
    if (after.length > 0 && !/^[\s\u3400-\u9fff]/.test(after)) continue;
    return { pos: tag, rest: after.trim() };
  }
  return { pos: null, rest: line };
}

/** 匹配形如 `[化]` / `[计]` 的领域标注。 */
function splitDomain(text: string): { domain: string | null; rest: string } {
  const match = /^\[([^\]]{1,6})\]\s*/.exec(text);
  if (match === null) return { domain: null, rest: text };
  return { domain: match[1] ?? null, rest: text.slice(match[0].length) };
}

/**
 * 把一条词条的 translation（多行文本）拆成结构化行。
 *
 * 空行直接丢弃；`[化] 现象` 这种纯领域行也会带出 domain。
 */
export function parseTranslation(translation: string): TranslationLine[] {
  const out: TranslationLine[] = [];
  for (const raw of translation.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const { pos, rest } = splitPos(line);
    const { domain, rest: body } = splitDomain(rest);
    const text = normalizePunctuation(body);
    if (text.length === 0 && domain === null) continue;
    out.push({ pos, text, domain });
  }
  return out;
}

/**
 * 词形行的文案（lookup #7）。
 *
 * 信息来源只有 lemma 索引，绝不编造：
 *   - 查变形词（persisted / better / went…）→ 词库给出原形 → `原形 · persist`
 *   - 查的本来就是原形 → 没有信息量，返回 null
 *
 * `lemmaOf` 由 data/dict.ts 在精确命中/lemma 命中时都带上：
 * 词库里 49626 个变形词有自己的独立词条，走 exact 分支照样能给出原形。
 */
export function formLine(pressedWord: string, lemmaOf: string | undefined): string | null {
  if (lemmaOf === undefined) return null;
  const base = lemmaOf.trim();
  if (base.length === 0) return null;
  if (base.toLowerCase() === pressedWord.trim().toLowerCase()) return null;
  return `原形 · ${base}`;
}
