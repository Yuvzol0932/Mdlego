/**
 * 底部导航（阶段 C1）—— 五个入口：
 *   书架 / 搜索 / ＋（导入） / 统计 / 设置
 *
 * 设计（对应任务书 §2.3、参考图左机底栏）：
 *   - 玻璃悬浮条：左右各留 12px，圆角 --r-xl，贴底并让出安全区
 *   - 中间「＋」是凸起的强调色圆形按钮，点击走真实的导入链路（requestImport）
 *   - 选中项图标变强调色并上浮放大（只动画 transform，时长走令牌）
 *
 * 它是**页面的一部分**：每个一级 tab 页自己渲染一份（页面被宿主缓存后节点常驻），
 * 阅读页不渲染它，改用阅读底栏。
 */

import type { Tab } from '../core/types';
import { el, icon, type ViewDeps } from './app';
import type { IconName } from './icons';

interface TabEntry {
  readonly tab: Exclude<Tab, 'kit'>;
  readonly icon: IconName;
  readonly label: string;
  readonly testId: string;
}

const LEFT: readonly TabEntry[] = [
  { tab: 'shelf', icon: 'shelf', label: '书架', testId: 'tab-shelf' },
  { tab: 'search', icon: 'search', label: '搜索', testId: 'tab-search' },
];

const RIGHT: readonly TabEntry[] = [
  { tab: 'stats', icon: 'chart', label: '统计', testId: 'tab-stats' },
  { tab: 'settings', icon: 'settings', label: '设置', testId: 'tab-settings' },
];

/** 单个 tab 按钮。选中态用 aria-current 表达，样式与脚本都读它。 */
function tabItem(entry: TabEntry, active: Tab, deps: ViewDeps): HTMLElement {
  const btn = el(
    'button',
    {
      class: 'tabbar__item ui-press',
      type: 'button',
      'data-testid': entry.testId,
      'aria-label': entry.label,
      onclick: () => {
        // 已在当前 tab 上就什么都不做：避免重复 dispatch 造成无谓的状态变化
        if (entry.tab === active) return;
        deps.dispatch({ type: 'nav/tab', tab: entry.tab });
      },
    },
    el('span', { class: 'tabbar__icon' }, icon(entry.icon)),
    el('span', { class: 'tabbar__label', text: entry.label }),
  );
  if (entry.tab === active) btn.setAttribute('aria-current', 'page');
  return btn;
}

/**
 * 渲染底部导航。`active` 是当前一级 tab（来自页面栈栈底）。
 * 阅读页不调用它。
 */
export function renderTabBar(active: Tab, deps: ViewDeps): HTMLElement {
  const plus = el(
    'button',
    {
      class: 'tabbar__plus ui-press',
      type: 'button',
      'data-testid': 'import-file',
      'aria-label': '导入文档',
      title: '导入文档',
      onclick: () => deps.requestImport(),
    },
    icon('plus'),
  );

  return el(
    'nav',
    { class: 'tabbar glass', 'data-testid': 'tabbar', 'aria-label': '主导航' },
    // 指示点：位置由 <html> 的 --tab-index 决定（motion.css 里注册为可插值属性），
    // 切 tab 时只变这个变量，指示条靠 transform 平移，不做 left 动画。
    el('span', { class: 'tabbar__indicator', 'aria-hidden': 'true' }),
    ...LEFT.map((entry) => tabItem(entry, active, deps)),
    // 中间留出凸起按钮的位置；plus 绝对定位在导航条正中
    el('span', { class: 'tabbar__slot', 'aria-hidden': 'true' }),
    ...RIGHT.map((entry) => tabItem(entry, active, deps)),
    plus,
  );
}

/** 当前页面栈栈底（一级 tab）是哪一个。页面用它决定高亮项。 */
export function activeTabOf(tabs: readonly Tab[]): Tab {
  return tabs[0] ?? 'shelf';
}
