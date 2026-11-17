/**
 * 朗读分块单测（阶段 E6）。
 */

import { describe, expect, it } from 'vitest';
import { TTS_MAX_LEN, buildTtsChunks, estimateSpeechSeconds, splitSentences } from './tts';

describe('句子切分', () => {
  it('按中文/英文句末标点切句，保留标点', () => {
    expect(splitSentences('第一句。第二句！Is it ok? Yes.')).toEqual([
      '第一句。',
      '第二句！',
      'Is it ok?',
      'Yes.',
    ]);
  });

  it('超长句按长度硬切，不产生空块', () => {
    const long = '甲'.repeat(TTS_MAX_LEN + 50);
    const parts = splitSentences(long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= TTS_MAX_LEN)).toBe(true);
    expect(parts.join('').length).toBe(long.length);
  });

  it('空白文本返回空数组', () => {
    expect(splitSentences('   \n  ')).toEqual([]);
  });
});

describe('朗读队列', () => {
  it('按块顺序生成，每块带 bid；空块跳过', () => {
    const blocks = new Map([
      ['p-1', '第一段。第二段。'],
      ['p-2', ''],
      ['p-3', 'Third paragraph.'],
    ]);
    const chunks = buildTtsChunks(blocks);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ bid: 'p-1', text: '第一段。' });
    expect(chunks[2]).toEqual({ bid: 'p-3', text: 'Third paragraph.' });
  });

  it('时长估算：中文按字数，英文按词数', () => {
    expect(estimateSpeechSeconds('你好世界')).toBe(1);
    expect(estimateSpeechSeconds('hello world')).toBe(1);
    expect(estimateSpeechSeconds('')).toBe(0);
  });
});
