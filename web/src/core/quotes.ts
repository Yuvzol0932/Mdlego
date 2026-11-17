/**
 * 横幅「今日一句」的语录（阶段 C2）。
 *
 * 默认只放几句通用阅读语录 —— 任务书明确要求「不要伪造内容」：
 * 这些不是名人名言，不标作者，避免编造出处。用户可在设置里替换成自己的句子。
 */

/** 内置默认语录（用户在设置里填了就完全不使用这些）。 */
export const DEFAULT_QUOTES: readonly string[] = [
  '阅读，是为了遇见更大的世界。',
  '把一本书读薄，再把自己的思考读厚。',
  '慢慢读，认真想，那些词句才会留下来。',
];

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
