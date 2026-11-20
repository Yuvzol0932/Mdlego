// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { Doc } from '../core/types';
import {
  COVER_COUNT,
  COVER_PATTERNS,
  buildCoverElement,
  coverIndex,
  coverInitial,
  coverPattern,
  estimatedMinutes,
  relativeTime,
  resolveDocCover,
} from './cover';
import { createCoverEditorSheet } from './cover-editor';

function makeDoc(overrides: Partial<Doc> = {}): Doc {
  return {
    id: 'd1',
    title: '四级词汇 Day 1',
    text: '正文内容',
    encoding: 'utf-8',
    source: { kind: 'inline' },
    fingerprint: null,
    importedAt: 1000,
    lastReadAt: null,
    progress: null,
    ...overrides,
  };
}

describe('封面哈希取色', () => {
  it('同一标题永远同一个色板（1..8）', () => {
    for (const title of ['技术写作指南', 'Markdown 进阶指南', 'a', '']) {
      const first = coverIndex(title);
      expect(first).toBeGreaterThanOrEqual(1);
      expect(first).toBeLessThanOrEqual(COVER_COUNT);
      expect(coverIndex(title)).toBe(first);
    }
  });

  it('不同标题会分散到多个色板（不是所有标题一个颜色）', () => {
    const titles = [
      '技术写作指南', '设计系统入门', '人生的智慧', '离线优先笔记', '阅读方法札记',
      '词根 spect', 'React 设计模式', '写作这件事', '读书笔记',
    ];
    const used = new Set(titles.map(coverIndex));
    expect(used.size).toBeGreaterThanOrEqual(3);
  });
});

describe('封面首字', () => {
  it('中文取首字，拉丁字母转大写，空标题回落「墨」', () => {
    expect(coverInitial('技术写作指南')).toBe('技');
    expect(coverInitial('markdown 进阶')).toBe('M');
    expect(coverInitial('   ')).toBe('墨');
    expect(coverInitial(' 设计系统')).toBe('设');
  });
});

describe('估读时长与相对时间', () => {
  it('1 千字约 2 分钟，最小值 1', () => {
    expect(estimatedMinutes('')).toBe(1);
    expect(estimatedMinutes('字'.repeat(1000))).toBe(2);
  });

  it('相对时间文案', () => {
    const now = Date.now();
    expect(relativeTime(null)).toBe('未读');
    expect(relativeTime(now - 30_000)).toBe('刚刚');
    expect(relativeTime(now - 5 * 60_000)).toBe('5 分钟前');
    expect(relativeTime(now - 2 * 86_400_000)).toBe('2 天前');
  });
});

describe('装帧版式与自定义封面', () => {
  it('同一前缀不同标题也能分散到多种装帧版式', () => {
    const titles = Array.from({ length: 16 }, (_, i) => `四级仔细阅读 Day ${i + 1}`);
    const patterns = new Set(titles.map(coverPattern));
    expect(patterns.size).toBeGreaterThanOrEqual(4);
    expect(COVER_PATTERNS).toHaveLength(6);
  });

  it('resolveDocCover 正确合并自定义配置与自动派生', () => {
    const doc = makeDoc({
      folder: '考研英语',
      cover: { palette: 9, pattern: 'folio', monogram: 'CET4', subtitle: '第一轮' },
    });
    const resolved = resolveDocCover(doc);
    expect(resolved.palette).toBe(9);
    expect(resolved.pattern).toBe('folio');
    expect(resolved.monogram).toBe('CET4');
    expect(resolved.subtitle).toBe('第一轮');
    expect(resolved.image).toBeNull();
  });

  it('buildCoverElement 在非紧凑模式渲染角标/书脊/版式印记/徽标（不重复渲染书名），支持自定义图', () => {
    const doc = makeDoc({
      cover: { palette: 3, pattern: 'band', monogram: 'DAY5', image: 'data:image/jpeg;base64,abc' },
    });
    const el = buildCoverElement(doc, 'cover--card');
    expect(el.getAttribute('data-cover')).toBe('3');
    expect(el.getAttribute('data-cover-pattern')).toBe('band');
    expect(el.getAttribute('data-cover-photo')).toBe('1');
    expect(el.querySelector('.cover__spine')).not.toBeNull();
    expect(el.querySelector('.cover__title')).toBeNull();
    expect(el.querySelector('.cover__sub')).not.toBeNull();
    expect(el.querySelector('.cover__folio')?.textContent).toBe('MD');
    expect(el.querySelector('.cover__initial--multi')?.textContent).toBe('DAY5');
  });

  it('封面编辑面板支持切换配色/版式/自定义徽标并保存或恢复自动', () => {
    const saved: Array<{ id: string; cover: unknown }> = [];
    let closed = 0;
    const sheet = createCoverEditorSheet(makeDoc(), {
      pickImage: async () => null,
      save: (id, cover) => saved.push({ id, cover }),
      close: () => {
        closed += 1;
      },
    });
    sheet.el.querySelector<HTMLButtonElement>('[data-testid="cover-palette-11"]')?.click();
    sheet.el.querySelector<HTMLButtonElement>('[data-testid="cover-pattern-slash"]')?.click();
    const mono = sheet.el.querySelector<HTMLInputElement>('[data-testid="cover-monogram"]');
    if (mono !== null) {
      mono.value = '真题';
      mono.dispatchEvent(new Event('input'));
    }
    sheet.el.querySelector<HTMLButtonElement>('[data-testid="cover-save"]')?.click();
    expect(saved).toEqual([
      { id: 'd1', cover: { palette: 11, pattern: 'slash', monogram: '真题' } },
    ]);
    expect(closed).toBe(1);

    sheet.el.querySelector<HTMLButtonElement>('[data-testid="cover-reset"]')?.click();
    expect(saved[1]).toEqual({ id: 'd1', cover: null });
  });
});
