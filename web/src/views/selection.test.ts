// @vitest-environment jsdom
/**
 * 选区换算与工具条行为（阶段 E2）。
 *
 * 验的是「Range → 块内归一化偏移 → 选区切片」的契约，以及长按/原生选区的兼容路径。
 * jsdom 没有 caretRangeFromPoint / CSS.highlights，手势部分用程序化选区覆盖。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { wordRangeInText, rangeToParts } from './selection';

function paragraph(html: string, bid = 'p-1'): HTMLElement {
  const article = document.querySelector<HTMLElement>('[data-testid="article"]') as HTMLElement;
  const p = document.createElement('p');
  p.setAttribute('data-bid', bid);
  p.innerHTML = html;
  article.append(p);
  return p;
}

beforeEach(() => {
  document.body.innerHTML = '<article class="article" data-testid="article"></article>';
});

describe('Range → 选区切片', () => {
  it('单块选区：quote 取归一化文本', () => {
    const p = paragraph('Hello world');
    const article = document.querySelector<HTMLElement>('[data-testid="article"]') as HTMLElement;
    const text = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    const parts = rangeToParts(article, range);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ bid: 'p-1', start: 0, end: 5, quote: 'Hello' });
  });

  it('连续空白折叠成一个空格（与 blockTexts 同一坐标系）', () => {
    const p = paragraph('a  b');
    const article = document.querySelector<HTMLElement>('[data-testid="article"]') as HTMLElement;
    const text = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 4);
    const parts = rangeToParts(article, range);
    expect(parts[0]?.quote).toBe('a b');
    expect(parts[0]?.end).toBe(3);
  });

  it('跨块选区拆成多片，块内偏移各自独立', () => {
    const p1 = paragraph('alpha', 'p-1');
    const p2 = paragraph('beta', 'p-2');
    const article = document.querySelector<HTMLElement>('[data-testid="article"]') as HTMLElement;
    const range = document.createRange();
    range.setStart(p1.firstChild as Text, 2);
    range.setEnd(p2.firstChild as Text, 2);
    const parts = rangeToParts(article, range);
    expect(parts.map((part) => part.bid)).toEqual(['p-1', 'p-2']);
    expect(parts[0]).toMatchObject({ start: 2, end: 5, quote: 'pha' });
    expect(parts[1]).toMatchObject({ start: 0, end: 2, quote: 'be' });
  });

  it('纯空白选区被丢弃', () => {
    const p = paragraph('a   b');
    const article = document.querySelector<HTMLElement>('[data-testid="article"]') as HTMLElement;
    const text = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 1);
    range.setEnd(text, 3);
    expect(rangeToParts(article, range)).toEqual([]);
  });
});

describe('长按取词范围', () => {
  it('光标在词中/词尾都能取到整个英文词', () => {
    expect(wordRangeInText('hello world', 2)).toEqual({ start: 0, end: 5 });
    expect(wordRangeInText('hello world', 5)).toEqual({ start: 0, end: 5 });
    expect(wordRangeInText('hello world', 7)).toEqual({ start: 6, end: 11 });
  });

  it('非英文词返回 null', () => {
    expect(wordRangeInText('中文内容', 1)).toBeNull();
    expect(wordRangeInText('', 0)).toBeNull();
  });
});
