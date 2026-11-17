/**
 * 朗读分块（阶段 E6，纯函数）。
 *
 * 系统 TTS（Web Speech API）对超长 utterance 的支持不一致，也听不出「读到哪」。
 * 这里把文档按块文本切成短句（<= maxLen），每块带上 bid 方便高亮/滚动。
 */

/** 一段待朗读文本。 */
export interface TtsChunk {
  /** 来源块 id（用于正文高亮）；没有块时为空串。 */
  readonly bid: string;
  readonly text: string;
}

/** 单段最大长度（字符）。太长会被部分 TTS 引擎截断。 */
export const TTS_MAX_LEN = 160;

/** 把一段文本按句末标点切句；无标点时按长度硬切。 */
export function splitSentences(text: string, maxLen = TTS_MAX_LEN): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return [];
  const parts = cleaned.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [cleaned];
  const out: string[] = [];
  for (const part of parts) {
    const sentence = part.trim();
    if (sentence.length === 0) continue;
    if (sentence.length <= maxLen) {
      out.push(sentence);
      continue;
    }
    // 超长句：按长度硬切，尽量在逗号/空格处断开
    let rest = sentence;
    while (rest.length > maxLen) {
      let cut = -1;
      for (let i = maxLen; i > maxLen * 0.5; i -= 1) {
        const ch = rest[i] ?? '';
        if (ch === '，' || ch === ',' || ch === ' ') {
          cut = i + 1;
          break;
        }
      }
      if (cut < 0) cut = maxLen;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest.length > 0) out.push(rest);
  }
  return out;
}

/**
 * 把「块 id → 块文本」切成朗读队列。
 * 跳过空块与纯代码块（代码朗读没有意义，且符号会被念成乱码）。
 */
export function buildTtsChunks(blockTexts: ReadonlyMap<string, string>): TtsChunk[] {
  const chunks: TtsChunk[] = [];
  for (const [bid, text] of blockTexts) {
    for (const sentence of splitSentences(text)) {
      chunks.push({ bid, text: sentence });
    }
  }
  return chunks;
}

/** 估算朗读时长（中文约 4.5 字/秒，英文按词数），用于界面提示。 */
export function estimateSpeechSeconds(text: string): number {
  const chinese = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const words = (text.match(/[A-Za-z]+/g) ?? []).length;
  return Math.round(chinese / 4.5 + (words * 60) / 180);
}
