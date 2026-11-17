/**
 * 统计 tab（阶段 C1 建壳，C6 接真实数据）。
 *
 * 数据来自 `state.stats`（main.ts 从 IndexedDB 的 sessions 表算出）；为 null 表示
 * 还没读过任何东西 —— 这时显示空状态，**不伪造数字**（任务书总原则 7）。
 *
 * 柱状图是自绘 SVG：柱子圆角、自下而上生长只用 transform，时长走动效令牌，
 * 所以「动效：关」与 prefers-reduced-motion 下会自动退化。
 */

import type { DailyReading, State } from '../core/types';
import { el, icon, type ViewDeps } from './app';
import { renderTabBar } from './tabbar';

/** 把毫秒格式化成「X 分钟 / X 小时 Y 分」。 */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes <= 0) return '0 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
}

/** 星期几（中文单字），用于柱状图底下的小标签。 */
function weekday(day: string): string {
  const date = new Date(`${day}T00:00:00`);
  return ['日', '一', '二', '三', '四', '五', '六'][date.getDay()] ?? '';
}

/**
 * 七日柱状图。宽度用 viewBox 自适应，高度按最长一天归一。
 * 没数据的日子画一条 2px 的底纹柱，保持「这七天都在」的连续感。
 */
function weeklyChart(week: readonly DailyReading[]): SVGSVGElement {
  const W = 300;
  const H = 120;
  const gap = 10;
  const slot = (W - gap * (week.length - 1)) / Math.max(1, week.length);
  const max = Math.max(1, ...week.map((d) => d.ms));
  const lastIndex = week.length - 1;

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'stats-chart');
  svg.setAttribute('viewBox', `0 0 ${W} ${H + 22}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '近七天阅读时长柱状图');
  svg.setAttribute('data-testid', 'stats-chart');

  week.forEach((day, index) => {
    const ratio = day.ms / max;
    // 最小 2px，保证「这天读过但很短」与「这天没读」在视觉上仍然有区分
    const barH = Math.max(2, Math.round(ratio * (H - 8)));
    const x = index * (slot + gap);
    const bar = document.createElementNS(ns, 'rect');
    bar.setAttribute('class', index === lastIndex ? 'stats-bar stats-bar--today' : 'stats-bar');
    bar.setAttribute('x', String(x + slot * 0.18));
    bar.setAttribute('y', String(H - barH));
    bar.setAttribute('width', String(slot * 0.64));
    bar.setAttribute('height', String(barH));
    bar.setAttribute('rx', '4');
    // 生长动画：从底边往上（只动 transform）
    bar.style.setProperty('--grow-delay', `${index * 40}ms`);
    svg.append(bar);

    const label = document.createElementNS(ns, 'text');
    label.setAttribute('class', index === lastIndex ? 'stats-day stats-day--today' : 'stats-day');
    label.setAttribute('x', String(x + slot / 2));
    label.setAttribute('y', String(H + 16));
    label.setAttribute('text-anchor', 'middle');
    label.textContent = index === lastIndex ? '今天' : weekday(day.day);
    svg.append(label);
  });

  return svg;
}

/** 三个数字卡。 */
function statCards(todayMs: number, streakDays: number, docCount: number): HTMLElement {
  const card = (label: string, value: string, testId: string): HTMLElement =>
    el(
      'div',
      { class: 'stats-card', 'data-testid': testId },
      el('span', { class: 'stats-card__value', text: value }),
      el('span', { class: 'stats-card__label', text: label }),
    );
  return el(
    'div',
    { class: 'stats-cards' },
    card('今日阅读', formatDuration(todayMs), 'stats-today'),
    card('连续阅读', `${streakDays} 天`, 'stats-streak'),
    card('累计文档', `${docCount} 篇`, 'stats-docs'),
  );
}

/** 最近读过的文档列表。 */
function recentList(state: State, deps: ViewDeps): HTMLElement {
  const stats = state.stats;
  const list = el('div', { class: 'stats-list', 'data-testid': 'stats-recent' });
  if (stats === null || stats.recent.length === 0) {
    list.append(el('p', { class: 'stats-list__empty', text: '还没有读完的文档记录。' }));
    return list;
  }
  for (const item of stats.recent) {
    list.append(
      el(
        'button',
        {
          class: 'stats-list__row',
          type: 'button',
          'data-testid': 'stats-recent-item',
          'data-doc-id': item.docId,
          onclick: () => deps.dispatch({ type: 'doc/opened', docId: item.docId }),
        },
        el('span', { class: 'stats-list__title', text: item.title }),
        el('span', { class: 'stats-list__meta', text: new Date(item.lastReadAt).toLocaleDateString('zh-CN') }),
      ),
    );
  }
  return list;
}

export function renderStats(state: State, deps: ViewDeps): HTMLElement {
  const stats = state.stats;
  const body =
    stats === null
      ? el(
          'div',
          { class: 'stats-empty', 'data-testid': 'stats-empty' },
          el('div', { class: 'stats-empty__mark' }, icon('chart')),
          el('h2', { class: 'stats-empty__title', text: '还没有阅读记录' }),
          el('p', {
            class: 'stats-empty__hint',
            text: '读过的时长会记在本机。开始阅读后，这里会出现今日时长、连续天数与最近读过的文档。',
          }),
        )
      : el(
          'div',
          { class: 'stats', 'data-testid': 'stats' },
          statCards(stats.todayMs, stats.streakDays, stats.docCount),
          el(
            'section',
            { class: 'stats-section' },
            el('h2', { class: 'section-title', text: '近 7 天' }),
            weeklyChart(stats.week),
          ),
          el(
            'section',
            { class: 'stats-section' },
            el('h2', { class: 'section-title', text: '最近读过' }),
            recentList(state, deps),
          ),
        );

  return el(
    'div',
    { class: 'shell', 'data-testid': 'shell' },
    el(
      'header',
      { class: 'appbar appbar--plain' },
      el('span', { class: 'appbar__spacer', 'aria-hidden': 'true' }),
      el('h1', { class: 'appbar__title', 'data-testid': 'app-title', text: '统计' }),
      el('span', { class: 'appbar__spacer', 'aria-hidden': 'true' }),
    ),
    el('main', { class: 'main main--tabbed' }, body),
    renderTabBar('stats', deps),
  );
}
