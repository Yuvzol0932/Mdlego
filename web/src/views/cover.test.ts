import { describe, expect, it } from 'vitest';
import { COVER_COUNT, coverIndex, coverInitial, estimatedMinutes, relativeTime } from './cover';

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
