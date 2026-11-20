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
  if (minutes <= 0) return ms > 0 ? '不足 1 分钟' : '0 分钟';
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

/** 详情胶囊可读日期：「今天（周二） / 昨天（周一） / 11月15日（周日）」。 */
function dayLabel(day: string, index: number, total: number): string {
  const wd = weekday(day);
  if (index === total - 1) return `今天（周${wd}）`;
  if (index === total - 2) return `昨天（周${wd}）`;
  const date = new Date(`${day}T00:00:00`);
  return `${date.getMonth() + 1}月${date.getDate()}日（周${wd}）`;
}

/** 选中柱子顶部小字：12m / <1m / 1.5h，未阅读不显示。 */
function shortDuration(ms: number): string {
  if (ms <= 0) return '';
  const minutes = Math.round(ms / 60_000);
  if (minutes <= 0) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${(ms / 3_600_000).toFixed(1).replace(/\.0$/, '')}h`;
}

/**
 * 七日可交互柱状图。宽度用 viewBox 自适应，高度按最长一天归一。
 * 点击/回车任意一天高亮该柱并在顶部汇报当天阅读时长。
 */
function weeklyChart(
  week: readonly DailyReading[],
  onSelect: (index: number) => void,
): { svg: SVGSVGElement; select: (index: number) => void } {
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
  svg.setAttribute('role', 'group');
  svg.setAttribute('aria-label', '近七天阅读时长柱状图，点按查看每日时长');
  svg.setAttribute('data-testid', 'stats-chart');

  const cols: SVGGElement[] = [];

  const select = (targetIndex: number): void => {
    cols.forEach((col, i) => {
      const active = i === targetIndex;
      col.classList.toggle('is-selected', active);
      col.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    onSelect(targetIndex);
  };

  week.forEach((day, index) => {
    const ratio = day.ms / max;
    // 最小 2px，保证「这天读过但很短」与「这天没读」在视觉上仍然有区分
    const barH = Math.max(2, Math.round(ratio * (H - 18)));
    const x = index * (slot + gap);
    const col = document.createElementNS(ns, 'g');
    col.setAttribute('class', index === lastIndex ? 'stats-col is-selected' : 'stats-col');
    col.setAttribute('role', 'button');
    col.setAttribute('tabindex', '0');
    col.setAttribute('data-testid', 'stats-bar-col');
    col.setAttribute('data-day', day.day);
    col.setAttribute('aria-pressed', index === lastIndex ? 'true' : 'false');
    const summary = day.ms > 0 ? formatDuration(day.ms) : '未阅读';
    col.setAttribute('aria-label', `${dayLabel(day.day, index, week.length)} ${summary}`);

    // 全高隐形热区，0 分钟的 2px 矮柱也能轻松点击
    const hit = document.createElementNS(ns, 'rect');
    hit.setAttribute('class', 'stats-col__hit');
    hit.setAttribute('x', String(x));
    hit.setAttribute('y', '0');
    hit.setAttribute('width', String(slot));
    hit.setAttribute('height', String(H + 22));
    col.append(hit);

    const bar = document.createElementNS(ns, 'rect');
    bar.setAttribute('class', index === lastIndex ? 'stats-bar stats-bar--today' : 'stats-bar');
    bar.setAttribute('x', String(x + slot * 0.18));
    bar.setAttribute('y', String(H - barH));
    bar.setAttribute('width', String(slot * 0.64));
    bar.setAttribute('height', String(barH));
    bar.setAttribute('rx', '4');
    // 生长动画：从底边往上（只动 transform）
    bar.style.setProperty('--stagger-i', String(index));
    col.append(bar);

    const val = document.createElementNS(ns, 'text');
    val.setAttribute('class', 'stats-val');
    val.setAttribute('x', String(x + slot / 2));
    val.setAttribute('y', String(Math.max(10, H - barH - 5)));
    val.setAttribute('text-anchor', 'middle');
    val.textContent = shortDuration(day.ms);
    col.append(val);

    const label = document.createElementNS(ns, 'text');
    label.setAttribute('class', index === lastIndex ? 'stats-day stats-day--today' : 'stats-day');
    label.setAttribute('x', String(x + slot / 2));
    label.setAttribute('y', String(H + 16));
    label.setAttribute('text-anchor', 'middle');
    label.textContent = index === lastIndex ? '今天' : weekday(day.day);
    col.append(label);

    col.addEventListener('click', () => select(index));
    col.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      select(index);
    });

    cols.push(col);
    svg.append(col);
  });

  return { svg, select };
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
          el('button', {
            class: 'ui-btn ui-btn--ghost ui-press',
            type: 'button',
            text: '去书架开始阅读',
            onclick: () => deps.dispatch({ type: 'nav/tab', tab: 'shelf' }),
          }),
        )
      : (() => {
          const detail = el('span', { class: 'stats-chart__detail', 'data-testid': 'stats-day-detail' });
          const updateDetail = (index: number): void => {
            const d = stats.week[index];
            if (d === undefined) {
              detail.textContent = '';
              return;
            }
            const durationText = d.ms > 0 ? formatDuration(d.ms) : '未阅读';
            detail.textContent = `${dayLabel(d.day, index, stats.week.length)} · ${durationText}`;
          };
          const { svg } = weeklyChart(stats.week, updateDetail);
          if (stats.week.length > 0) updateDetail(stats.week.length - 1);
          return el(
            'div',
            { class: 'stats', 'data-testid': 'stats' },
            statCards(stats.todayMs, stats.streakDays, stats.docCount),
            el(
              'section',
              { class: 'stats-section stats-chart-card' },
              el(
                'div',
                { class: 'stats-chart__head' },
                el('h2', { class: 'section-title', text: '近 7 天' }),
                detail,
              ),
              svg,
            ),
            el(
              'section',
              { class: 'stats-section' },
              el('h2', { class: 'section-title', text: '最近读过' }),
              recentList(state, deps),
            ),
          );
        })();

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
