/**
 * 英文变形词 → 候选原形（纯函数，零 IO、零依赖）。
 *
 * 为什么需要它：上游 ECDICT 给每条词带 exchange 字段，实测 99.06% 的变形形态
 * 上游都单独收了词条，data/dict.ts 已把「变形词 → 原形」索引用好。
 * 这里只兜住剩下的约 1%：上游没收录的变形形态，用后缀规则猜候选原形。
 *
 * 规则一定会错，所以这里只产出「候选」，命中与否交给 data 层查词库决定 ——
 * 猜错就是查不到，不会硬凑一个不存在的词。
 *
 * 局限（必须知道，不许假装没有）：
 *   - 不规则变化靠规则一定错（went→go、teeth→tooth、better→good）。
 *     但这些上游已单独收词条，实际走不到这里；真走到了也只会落空。
 *   - 规则会造出「合法但错误」的原形：axes 去 es 得 ax（在库，但词义偏离）。
 *     缓解在视图层：matchedBy === 'lemma' 时卡片多一行「按 X 释义」。
 *   - 词组不还原：wordAt 天然只取单个 token，look forward to 只会取到 look。
 *   - 带连字符与撇号的词不拆：上游有 well-known / don't 这类整词条目，拆开只会错。
 *   - 只跑一层后缀，不递归；长度小于 4 的词直接跳过（太短的词去后缀全是垃圾）。
 */

/** 太短的词跑后缀规则只会造垃圾候选。 */
const MIN_WORD_LENGTH = 4;

/** 单次最多给几个候选。候选越多，查词要读的分片越多。 */
const MAX_CANDIDATES = 5;

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

/** 词尾是否「重复的辅音字母」，如 stopp / runn / travell。 */
function endsWithDoubledConsonant(stem: string): boolean {
  if (stem.length < 2) return false;
  const last = stem[stem.length - 1] ?? '';
  const prev = stem[stem.length - 2] ?? '';
  if (last !== prev) return false;
  if (last < 'a' || last > 'z') return false;
  return !VOWELS.has(last);
}

/**
 * 按优先级给出候选原形，命中即停由调用方保证。
 *
 * 优先级不是随便排的：越靠前的规则越可能对（复数/过去式先于派生词缀），
 * 并且单次最多 5 个 —— 排太后的规则本来也轮不到。
 */
export function lemmaCandidates(word: string): readonly string[] {
  const lower = word.toLowerCase();
  if (lower.length < MIN_WORD_LENGTH) return [];
  // 只处理纯英文单词；连字符/撇号词上游有整词条目，不拆。
  if (!/^[a-z]+$/.test(lower)) return [];

  const out: string[] = [];
  const add = (candidate: string): void => {
    if (candidate.length < 2) return;
    if (candidate === lower) return;
    if (out.includes(candidate)) return;
    if (out.length >= MAX_CANDIDATES) return;
    out.push(candidate);
  };

  // ① 复数与第三人称单数
  if (lower.endsWith('ies')) {
    add(lower.slice(0, -3) + 'y'); // studies → study
  } else if (lower.endsWith('es')) {
    add(lower.slice(0, -2)); // boxes → box
    add(lower.slice(0, -1)); // closes → close
  } else if (lower.endsWith('s') && !lower.endsWith('ss')) {
    add(lower.slice(0, -1)); // prospects → prospect
  }

  // ② 过去式与过去分词
  if (lower.endsWith('ied')) {
    add(lower.slice(0, -3) + 'y'); // carried → carry
  } else if (lower.endsWith('ed')) {
    const stem = lower.slice(0, -2);
    add(stem); // looked → look
    add(lower.slice(0, -1)); // liked → like
    if (endsWithDoubledConsonant(stem)) add(stem.slice(0, -1)); // stopped → stop
  }

  // ③ 现在分词
  if (lower.endsWith('ing')) {
    const stem = lower.slice(0, -3);
    add(stem); // looking → look
    if (endsWithDoubledConsonant(stem)) add(stem.slice(0, -1)); // running → run
    add(stem + 'e'); // making → make
  }

  // ④ 比较级与最高级
  if (lower.endsWith('iest')) add(lower.slice(0, -4) + 'y'); // happiest → happy
  else if (lower.endsWith('ier')) add(lower.slice(0, -3) + 'y'); // happier → happy
  if (lower.endsWith('est')) add(lower.slice(0, -3)); // highest → high
  else if (lower.endsWith('er')) add(lower.slice(0, -2)); // worker → work

  // ⑤ 常见派生词缀：只去一层，不再往下递归
  if (lower.endsWith('ly')) add(lower.slice(0, -2)); // quickly → quick
  if (lower.endsWith('ness')) add(lower.slice(0, -4)); // darkness → dark
  if (lower.endsWith('ment')) add(lower.slice(0, -4)); // movement → move
  if (lower.endsWith('tion')) add(lower.slice(0, -4)); // 只去后缀试一次

  return out;
}
