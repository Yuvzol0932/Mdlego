// @vitest-environment jsdom
/**
 * 选区换算与工具条行为（阶段 E2）。
 *
 * 验的是「Range → 块内归一化偏移 → 选区切片」的契约，以及长按/原生选区的兼容路径。
 * jsdom 没有 caretRangeFromPoint / CSS.highlights，手势部分用程序化选区覆盖。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindTextSelection,
  hideSelectionToolbar,
  longPressRangeInText,
  makeOrderedRange,
  rangeToParts,
  wordRangeInText,
} from './selection';

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

describe('通用长按选区（支持中文、英文及其他语言）', () => {
  it('英文文本仍选中完整单词，中文与数字都能取到非空词语或字符范围', () => {
    const en = longPressRangeInText('hello world', 1);
    expect(en).toEqual({ start: 0, end: 5 });

    const zhText = '阅读是与作者进行跨时空的深度对话。';
    const zh = longPressRangeInText(zhText, 12);
    expect(zh).not.toBeNull();
    expect((zh?.end ?? 0) - (zh?.start ?? 0)).toBeGreaterThanOrEqual(1);
    expect(zhText.slice(zh?.start ?? 0, zh?.end ?? 0).trim().length).toBeGreaterThan(0);

    const numText = '第 2026 届考研计划';
    const num = longPressRangeInText(numText, 3);
    expect(num).not.toBeNull();
    expect(numText.slice(num?.start ?? 0, num?.end ?? 0)).toBe('2026');

    expect(longPressRangeInText('   ', 1)).toBeNull();
  });

  it('中文选区弹出的工具条保留高亮/批注/复制并隐藏查词按钮；英文选区包含查词按钮', () => {
    vi.useFakeTimers();
    const article = document.querySelector<HTMLElement>('[data-testid="article"]') as HTMLElement;
    const zh = paragraph('深度阅读与批判性思考', 'p-zh');
    const en = paragraph('deep reading skill', 'p-en');

    const binding = bindTextSelection(article, {
      blockTexts: () => new Map([['p-zh', '深度阅读与批判性思考'], ['p-en', 'deep reading skill']]),
      onMark: () => undefined,
      onNote: () => undefined,
      onLookup: () => undefined,
      onCopy: () => undefined,
      onMarkTap: () => undefined,
      isReanchorPending: () => false,
      onReanchor: () => undefined,
      lookupEnabled: () => true,
    });

    const proto = Range.prototype as unknown as { getBoundingClientRect?: () => DOMRect };
    const hadRect = typeof proto.getBoundingClientRect === 'function';
    if (!hadRect) {
      proto.getBoundingClientRect = () =>
        ({ left: 10, top: 80, right: 50, bottom: 100, width: 40, height: 20 } as DOMRect);
    }

    const selectNode = (node: Text, from: number, to: number): void => {
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, to);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      vi.advanceTimersByTime(150);
    };

    try {
      // 纯中文选区：工具条出现，支持标注/批注/复制，不显示查词按钮
      selectNode(zh.firstChild as Text, 0, 4);
      expect(document.querySelector('[data-testid="mark-toolbar"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="mark-color-yellow"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="mark-note"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="mark-copy"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="mark-lookup"]')).toBeNull();

      // 英文选区：额外出现查词按钮
      selectNode(en.firstChild as Text, 0, 4);
      expect(document.querySelector('[data-testid="mark-toolbar"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="mark-lookup"]')).not.toBeNull();
    } finally {
      if (!hadRect) delete proto.getBoundingClientRect;
      hideSelectionToolbar();
      binding.destroy();
      vi.useRealTimers();
    }
  });
});

function createPointerEvent(
  type: string,
  opts: { clientX: number; clientY: number; pointerId?: number; pointerType?: string; button?: number },
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: opts.clientX,
    clientY: opts.clientY,
    button: opts.button ?? 0,
  });
  Object.defineProperty(event, 'pointerId', { value: opts.pointerId ?? 1 });
  Object.defineProperty(event, 'pointerType', { value: opts.pointerType ?? 'touch' });
  return event;
}

describe('左右选区手柄与自由拖选', () => {
  it('makeOrderedRange 支持正向、反向、跨块构造并在重合时返回 null', () => {
    const p1 = paragraph('深度阅读体验', 'p-1');
    const p2 = paragraph('跨段连续拖选', 'p-2');
    const t1 = p1.firstChild as Text;
    const t2 = p2.firstChild as Text;

    const forward = makeOrderedRange({ node: t1, offset: 1 }, { node: t1, offset: 4 });
    expect(forward?.toString()).toBe('度阅读');

    const backward = makeOrderedRange({ node: t1, offset: 4 }, { node: t1, offset: 1 });
    expect(backward?.toString()).toBe('度阅读');

    const crossForward = makeOrderedRange({ node: t1, offset: 4 }, { node: t2, offset: 2 });
    expect(crossForward?.toString()).toBe('体验跨段');

    const crossBackward = makeOrderedRange({ node: t2, offset: 2 }, { node: t1, offset: 4 });
    expect(crossBackward?.toString()).toBe('体验跨段');

    expect(makeOrderedRange({ node: t1, offset: 2 }, { node: t1, offset: 2 })).toBeNull();
  });

  it('中文选区出现时渲染起止游标手柄；点击手柄不收起，隐藏时一并清除', () => {
    vi.useFakeTimers();
    const article = document.querySelector<HTMLElement>('[data-testid="article"]') as HTMLElement;
    const zh = paragraph('深度阅读与批判性思考', 'p-zh');

    const binding = bindTextSelection(article, {
      blockTexts: () => new Map([['p-zh', '深度阅读与批判性思考']]),
      onMark: () => undefined,
      onNote: () => undefined,
      onLookup: () => undefined,
      onCopy: () => undefined,
      onMarkTap: () => undefined,
      isReanchorPending: () => false,
      onReanchor: () => undefined,
      lookupEnabled: () => true,
    });

    const proto = Range.prototype as unknown as { getBoundingClientRect?: () => DOMRect };
    const hadRect = typeof proto.getBoundingClientRect === 'function';
    if (!hadRect) {
      proto.getBoundingClientRect = () =>
        ({ left: 10, top: 80, right: 50, bottom: 100, width: 40, height: 20 } as DOMRect);
    }

    try {
      const range = document.createRange();
      range.setStart(zh.firstChild as Text, 0);
      range.setEnd(zh.firstChild as Text, 2);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      vi.advanceTimersByTime(150);

      const startHandle = document.querySelector<HTMLElement>('[data-testid="sel-handle-start"]');
      const endHandle = document.querySelector<HTMLElement>('[data-testid="sel-handle-end"]');
      const toolbar = document.querySelector<HTMLElement>('[data-testid="mark-toolbar"]');
      expect(startHandle).not.toBeNull();
      expect(endHandle).not.toBeNull();
      expect(toolbar).not.toBeNull();

      // 按在手柄上时不应触发「点空白收起」
      endHandle?.dispatchEvent(createPointerEvent('pointerdown', { clientX: 50, clientY: 104 }));
      expect(document.querySelector('[data-testid="sel-handle-start"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="mark-toolbar"]')).not.toBeNull();
      endHandle?.dispatchEvent(createPointerEvent('pointerup', { clientX: 50, clientY: 104 }));

      hideSelectionToolbar();
      expect(document.querySelector('[data-testid="sel-handle-start"]')).toBeNull();
      expect(document.querySelector('[data-testid="sel-handle-end"]')).toBeNull();
      expect(document.querySelector('[data-testid="mark-toolbar"]')).toBeNull();
    } finally {
      if (!hadRect) delete proto.getBoundingClientRect;
      hideSelectionToolbar();
      binding.destroy();
      vi.useRealTimers();
    }
  });

  it('拖动终点手柄可将 2 字中文词扩展为整段并输出完整复制文本', () => {
    vi.useFakeTimers();
    const article = document.querySelector<HTMLElement>('[data-testid="article"]') as HTMLElement;
    const text = '深度阅读与批判性思考';
    const zh = paragraph(text, 'p-zh');
    const textNode = zh.firstChild as Text;
    const onCopy = vi.fn();

    const binding = bindTextSelection(article, {
      blockTexts: () => new Map([['p-zh', text]]),
      onMark: () => undefined,
      onNote: () => undefined,
      onLookup: () => undefined,
      onCopy,
      onMarkTap: () => undefined,
      isReanchorPending: () => false,
      onReanchor: () => undefined,
      lookupEnabled: () => true,
    });

    const proto = Range.prototype as unknown as { getBoundingClientRect?: () => DOMRect };
    const hadRect = typeof proto.getBoundingClientRect === 'function';
    if (!hadRect) {
      proto.getBoundingClientRect = () =>
        ({ left: 20, top: 120, right: 60, bottom: 140, width: 40, height: 20 } as DOMRect);
    }

    const doc = document as unknown as { caretRangeFromPoint?: (x: number, y: number) => Range | null };
    const prevCaretFn = doc.caretRangeFromPoint;
    doc.caretRangeFromPoint = (x: number): Range | null => {
      const offset = Math.max(0, Math.min(text.length, Math.round((x - 20) / 16)));
      const r = document.createRange();
      r.setStart(textNode, offset);
      r.collapse(true);
      return r;
    };

    try {
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 2);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      vi.advanceTimersByTime(150);

      const endHandle = document.querySelector<HTMLElement>('[data-testid="sel-handle-end"]') as HTMLElement;
      expect(endHandle).not.toBeNull();

      // 在终点手柄下方按住并向右拖到文本末尾（10 * 16 + 20 = 180）
      endHandle.dispatchEvent(createPointerEvent('pointerdown', { clientX: 60, clientY: 142 }));
      expect(document.querySelector('[data-testid="mark-toolbar"]')?.classList.contains('sel-toolbar--hidden')).toBe(
        true,
      );
      endHandle.dispatchEvent(createPointerEvent('pointermove', { clientX: 180, clientY: 142 }));
      endHandle.dispatchEvent(createPointerEvent('pointerup', { clientX: 180, clientY: 142 }));

      const copyBtn = document.querySelector<HTMLElement>('[data-testid="mark-copy"]') as HTMLElement;
      expect(copyBtn).not.toBeNull();
      expect(document.querySelector('[data-testid="mark-toolbar"]')?.classList.contains('sel-toolbar--hidden')).toBe(
        false,
      );
      copyBtn.click();
      expect(onCopy).toHaveBeenCalledWith(text);
    } finally {
      if (prevCaretFn === undefined) delete doc.caretRangeFromPoint;
      else doc.caretRangeFromPoint = prevCaretFn;
      if (!hadRect) delete proto.getBoundingClientRect;
      hideSelectionToolbar();
      binding.destroy();
      vi.useRealTimers();
    }
  });

  it('起点手柄越过终点反向拖选时仍保持有效有序选区而不折叠消失', () => {
    vi.useFakeTimers();
    const article = document.querySelector<HTMLElement>('[data-testid="article"]') as HTMLElement;
    const text = '深度阅读与批判性思考';
    const zh = paragraph(text, 'p-zh');
    const textNode = zh.firstChild as Text;
    const onCopy = vi.fn();

    const binding = bindTextSelection(article, {
      blockTexts: () => new Map([['p-zh', text]]),
      onMark: () => undefined,
      onNote: () => undefined,
      onLookup: () => undefined,
      onCopy,
      onMarkTap: () => undefined,
      isReanchorPending: () => false,
      onReanchor: () => undefined,
      lookupEnabled: () => true,
    });

    const proto = Range.prototype as unknown as { getBoundingClientRect?: () => DOMRect };
    const hadRect = typeof proto.getBoundingClientRect === 'function';
    if (!hadRect) {
      proto.getBoundingClientRect = () =>
        ({ left: 52, top: 120, right: 84, bottom: 140, width: 32, height: 20 } as DOMRect);
    }

    const doc = document as unknown as { caretRangeFromPoint?: (x: number, y: number) => Range | null };
    const prevCaretFn = doc.caretRangeFromPoint;
    doc.caretRangeFromPoint = (x: number): Range | null => {
      const offset = Math.max(0, Math.min(text.length, Math.round((x - 20) / 16)));
      const r = document.createRange();
      r.setStart(textNode, offset);
      r.collapse(true);
      return r;
    };

    try {
      // 初始选中「阅读」[2, 4)
      const range = document.createRange();
      range.setStart(textNode, 2);
      range.setEnd(textNode, 4);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      vi.advanceTimersByTime(150);

      const startHandle = document.querySelector<HTMLElement>('[data-testid="sel-handle-start"]') as HTMLElement;
      expect(startHandle).not.toBeNull();

      // 按住起点手柄并越过终点「4」拖到末尾「10」（x=180）
      startHandle.dispatchEvent(createPointerEvent('pointerdown', { clientX: 52, clientY: 118 }));
      startHandle.dispatchEvent(createPointerEvent('pointermove', { clientX: 180, clientY: 118 }));
      startHandle.dispatchEvent(createPointerEvent('pointerup', { clientX: 180, clientY: 118 }));

      const copyBtn = document.querySelector<HTMLElement>('[data-testid="mark-copy"]') as HTMLElement;
      expect(copyBtn).not.toBeNull();
      copyBtn.click();
      expect(onCopy).toHaveBeenCalledWith('与批判性思考');
    } finally {
      if (prevCaretFn === undefined) delete doc.caretRangeFromPoint;
      else doc.caretRangeFromPoint = prevCaretFn;
      if (!hadRect) delete proto.getBoundingClientRect;
      hideSelectionToolbar();
      binding.destroy();
      vi.useRealTimers();
    }
  });
});
