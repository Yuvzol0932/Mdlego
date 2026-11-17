/**
 * 设置页（阶段 C5）—— 对照任务书 §2.6 的五个分区：
 *   外观 / 阅读 / 数据 / 查词 / 关于
 *
 * 关键设计不变：这里只派发 action，不直接改 CSS、不直接改存储。
 * 状态变化 → main.ts 订阅者 → 写根节点属性 → CSS 立即生效，
 * 所以「外观项即时预览」不需要任何额外刷新逻辑。
 *
 * 每一行都是「图标 + 标题 + 一行说明 + 控件」，控件统一来自 views/components.ts。
 * 字号/行距/段距仍用档位调节器，并**保留** type-scale-* 等 testid：
 * tools/verify-typography.mjs 靠它们检查档位边界与禁用态。
 */

import { normalizeQuotes } from '../core/quotes';
import {
  LINE_SCALE_LABELS,
  LINE_SCALE_MAX,
  LINE_SCALE_MIN,
  PARA_SCALE_LABELS,
  PARA_SCALE_MAX,
  PARA_SCALE_MIN,
  TYPE_SCALE_LABELS,
  TYPE_SCALE_MAX,
  TYPE_SCALE_MIN,
} from '../core/typography';
import { ACCENTS, GLASS_LEVEL_MAX, GLASS_LEVEL_MIN, THEME_SCHEME, resolveTheme } from '../core/theme';
import type { MaterialName, MotionLevel, Settings, State, ThemeChoice, ThemeName } from '../core/types';
import { el, icon, systemPrefersDark, type ViewDeps } from './app';
import { accentPalette, segmentedControl, slider, stepperControl, switchControl, themeChoice } from './components';
import type { IconName } from './icons';
import { renderTabBar } from './tabbar';

/** 一行设置：图标 + 标题（+ 说明）+ 右侧控件。 */
function settingRow(o: {
  icon: IconName;
  label: string;
  desc?: string;
  control: Node;
  testId?: string;
}): HTMLElement {
  const text = el('span', { class: 'settings-row__text' }, el('span', { class: 'settings-row__label', text: o.label }));
  if (o.desc !== undefined) text.append(el('span', { class: 'settings-row__desc', text: o.desc }));
  return el(
    'div',
    { class: 'settings-row', ...(o.testId !== undefined ? { 'data-testid': o.testId } : {}) },
    el('span', { class: 'settings-row__icon', 'aria-hidden': 'true' }, icon(o.icon)),
    text,
    el('span', { class: 'settings-row__control' }, o.control),
  );
}

/** 分区容器：标题 + 若干行。 */
function section(title: string, iconName: IconName, ...rows: Node[]): HTMLElement {
  return el(
    'section',
    { class: 'settings-section' },
    el(
      'h2',
      { class: 'settings-section__title' },
      el('span', { class: 'settings-section__icon', 'aria-hidden': 'true' }, icon(iconName)),
      el('span', { text: title }),
    ),
    ...rows,
  );
}

export function renderSettings(state: State, deps: ViewDeps): HTMLElement {
  const { settings } = state;
  const patch = (p: Partial<Settings>): void => {
    deps.dispatch({ type: 'settings/changed', patch: p });
  };

  // ── 外观 ─────────────────────────────────────
  const themes = el('div', { class: 'settings-themes', 'data-testid': 'theme' });
  const themeChoices: ThemeChoice[] = ['system', 'warm-night', 'warm-paper', 'forest', 'slate', 'magazine', 'night', 'paper'];
  for (const t of themeChoices) {
    themes.append(
      themeChoice({
        theme: t,
        pressed: settings.theme === t,
        testId: `theme-${t}`,
        onSelect: () => patch({ theme: t as ThemeName | 'system' }),
      }),
    );
  }
  const scheme = THEME_SCHEME[resolveTheme(settings.theme, systemPrefersDark())];

  const bannerPreview =
    settings.bannerImage === null
      ? el('span', { class: 'settings-banner__empty', text: '默认渐变' })
      : el('img', { class: 'settings-banner__img', src: settings.bannerImage, alt: '' });
  const bannerPick = el('button', {
    class: 'ui-btn ui-press settings-banner__btn',
    type: 'button',
    'data-testid': 'banner-pick',
    text: '选图片',
  });
  bannerPick.addEventListener('click', () => deps.pickBanner());
  const bannerClear = el('button', {
    class: 'ui-btn ui-btn--ghost ui-press settings-banner__btn',
    type: 'button',
    'data-testid': 'banner-clear',
    text: '恢复默认',
  });
  if (settings.bannerImage === null) bannerClear.setAttribute('disabled', '');
  else bannerClear.addEventListener('click', () => deps.clearBanner());

  const quotesInput = el('textarea', {
    class: 'settings-quotes',
    'data-testid': 'quotes-input',
    rows: '3',
    placeholder: '每行一句，留空则使用内置语录',
    'aria-label': '今日一句语录',
  });
  quotesInput.value = settings.quotes.join('\n');
  quotesInput.addEventListener('change', () => {
    patch({ quotes: normalizeQuotes(quotesInput.value.split(/\r?\n/)) });
  });

  const appearance = section(
    '外观',
    'palette',
    settingRow({ icon: 'palette', label: '主题', desc: '暖黑 / 米纸 / 墨绿 / 冷灰，或跟随系统', control: themes }),
    settingRow({
      icon: 'sparkle',
      label: '强调色',
      desc: '影响图标、选中态与进度条的强调色',
      control: accentPalette({ value: settings.accent, scheme, accents: ACCENTS, onSelect: (accent) => patch({ accent }) }),
    }),
    settingRow({
      icon: 'image',
      label: '材质',
      desc: '玻璃有模糊质感，柔和半透明更省电',
      control: segmentedControl<MaterialName>({
        value: settings.material,
        testId: 'material',
        items: [
          { value: 'glass', label: '玻璃', testId: 'material-glass' },
          { value: 'soft', label: '柔和半透明', testId: 'material-soft' },
          { value: 'solid', label: '纯色', testId: 'material-solid' },
        ],
        onSelect: (material) => patch({ material }),
      }),
    }),
    settingRow({
      icon: 'sliders',
      label: '玻璃强度',
      desc: '弱 / 标准 / 强',
      control: slider({
        value: settings.glassLevel,
        min: GLASS_LEVEL_MIN,
        max: GLASS_LEVEL_MAX,
        testId: 'glass-level',
        ariaLabel: '玻璃强度（弱/标准/强）',
        onInput: (glassLevel) => patch({ glassLevel }),
      }),
    }),
    settingRow({
      icon: 'sparkle',
      label: '动效',
      desc: '关：不播放过渡；完整：保留全部动效',
      control: segmentedControl<MotionLevel>({
        value: settings.motion,
        testId: 'motion',
        items: [
          { value: 'off', label: '关', testId: 'motion-off' },
          { value: 'simple', label: '简约', testId: 'motion-simple' },
          { value: 'full', label: '完整', testId: 'motion-full' },
        ],
        onSelect: (motion) => patch({ motion }),
      }),
    }),
    settingRow({
      icon: 'image',
      label: '横幅背景',
      desc: '默认用主题色渐变 + 噪点，也可以选一张本地图片',
      control: el(
        'span',
        { class: 'settings-banner' },
        bannerPreview,
        bannerPick,
        bannerClear,
      ),
    }),
    settingRow({
      icon: 'note',
      label: '今日一句',
      desc: '横幅第一张显示；每行一句，最多 20 句',
      control: quotesInput,
    }),
  );

  // ── 阅读 ─────────────────────────────────────
  // 实时预览：改档位时这里立刻变化，用户看到的是效果而不是数字。
  const preview = el(
    'div',
    { class: 'preview', 'data-testid': 'type-preview' },
    el('p', { text: '词根 -spect- 表示「看」。掌握它，可以一次记住几十个考研高频词。' }),
    el('p', { text: 'inspect 检查 · retrospect 回顾 · prospect 前景 · conspicuous 显眼的。' }),
  );

  const reading = section(
    '阅读',
    'type',
    settingRow({
      icon: 'type',
      label: '字号',
      control: stepperControl({
        value: settings.typeScale,
        min: TYPE_SCALE_MIN,
        max: TYPE_SCALE_MAX,
        labels: TYPE_SCALE_LABELS,
        testId: 'type-scale',
        ariaLabel: '字号',
        onChange: (typeScale) => patch({ typeScale }),
      }),
    }),
    settingRow({
      icon: 'sliders',
      label: '行距',
      control: stepperControl({
        value: settings.lineScale,
        min: LINE_SCALE_MIN,
        max: LINE_SCALE_MAX,
        labels: LINE_SCALE_LABELS,
        testId: 'line-scale',
        ariaLabel: '行距',
        onChange: (lineScale) => patch({ lineScale }),
      }),
    }),
    settingRow({
      icon: 'sliders',
      label: '段距',
      control: stepperControl({
        value: settings.paraScale,
        min: PARA_SCALE_MIN,
        max: PARA_SCALE_MAX,
        labels: PARA_SCALE_LABELS,
        testId: 'para-scale',
        ariaLabel: '段间距',
        onChange: (paraScale) => patch({ paraScale }),
      }),
    }),
    settingRow({
      icon: 'type',
      label: '字体',
      desc: '宋体更书卷，黑体更清晰',
      control: segmentedControl<'sans' | 'serif'>({
        value: settings.fontFamily,
        testId: 'font-family',
        items: [
          { value: 'serif', label: '宋体', testId: 'font-serif' },
          { value: 'sans', label: '黑体', testId: 'font-sans' },
        ],
        onSelect: (value) => patch({ fontFamily: value === 'sans' ? 'sans' : 'serif' }),
      }),
    }),
    settingRow({
      icon: 'sun',
      label: '屏幕常亮',
      desc: '阅读时不自动锁屏（不支持的环境不生效）',
      control: switchControl({
        checked: settings.keepAwake,
        testId: 'keep-awake',
        ariaLabel: '阅读时保持屏幕常亮',
        onChange: (keepAwake) => patch({ keepAwake }),
      }),
    }),
    preview,
  );

  // ── 数据 ─────────────────────────────────────
  const importBtn = el('button', {
    class: 'ui-btn ui-press',
    type: 'button',
    'data-testid': 'settings-import',
    text: '导入',
  });
  importBtn.addEventListener('click', () => deps.requestImport());

  const clearStatsBtn = el('button', {
    class: 'ui-btn ui-btn--ghost ui-press settings-danger',
    type: 'button',
    'data-testid': 'clear-stats',
    text: '清空',
  });
  clearStatsBtn.addEventListener('click', () => {
    deps.openMenu({
      variant: 'dialog',
      title: '清空阅读统计？',
      items: [
        {
          id: 'confirm-clear-stats',
          label: '清空统计',
          danger: true,
          onSelect: () => deps.clearStats(),
        },
        { id: 'cancel-clear-stats', label: '取消', onSelect: () => undefined },
      ],
    });
  });

  const data = section(
    '数据',
    'database',
    settingRow({ icon: 'download', label: '导入文档', desc: '选择 .md / .txt 文件', control: importBtn }),
    settingRow({
      icon: 'chart',
      label: '阅读统计',
      desc: '只清空时长与会话记录，文档和批注不受影响',
      control: clearStatsBtn,
    }),
    settingRow({
      icon: 'database',
      label: '存储',
      desc: '文档、进度、收藏都只保存在本机，不上传',
      control: el('span', { class: 'settings-row__static', text: '本机' }),
    }),
  );

  // ── 备份与恢复（阶段 E3）──────────────────────
  const backupFile = el('input', {
    type: 'file',
    accept: '.json,application/json',
    'data-testid': 'backup-file',
    'aria-hidden': 'true',
    tabindex: '-1',
  });
  backupFile.hidden = true;
  backupFile.addEventListener('change', () => {
    const file = backupFile.files?.[0];
    if (file !== undefined) deps.importBackupFile(file);
    backupFile.value = '';
  });

  const exportBackupBtn = el('button', {
    class: 'ui-btn ui-press',
    type: 'button',
    'data-testid': 'backup-export',
    text: '导出',
  });
  exportBackupBtn.addEventListener('click', () => deps.exportBackup());

  const importBackupBtn = el('button', {
    class: 'ui-btn ui-btn--ghost ui-press',
    type: 'button',
    'data-testid': 'backup-import',
    text: '选择文件',
  });
  importBackupBtn.addEventListener('click', () => backupFile.click());

  const importClipboardBtn = el('button', {
    class: 'ui-btn ui-btn--ghost ui-press',
    type: 'button',
    'data-testid': 'backup-import-clipboard',
    text: '从剪贴板',
  });
  importClipboardBtn.addEventListener('click', () => deps.importBackupClipboard());

  const backup = section(
    '备份与恢复',
    'download',
    settingRow({
      icon: 'download',
      label: '导出备份',
      desc: 'JSON：文档/批注/进度/任务/设置/收藏；不会上传',
      testId: 'settings-backup-export',
      control: exportBackupBtn,
    }),
    settingRow({
      icon: 'database',
      label: '从文件恢复',
      desc: '选择墨读备份 .json；会覆盖本机数据，恢复前会确认',
      testId: 'settings-backup-import',
      control: importBackupBtn,
    }),
    settingRow({
      icon: 'copy',
      label: '从剪贴板恢复',
      desc: '把导出的 JSON 复制到剪贴板后从这里恢复',
      testId: 'settings-backup-clipboard',
      control: importClipboardBtn,
    }),
    backupFile,
    settingRow({
      icon: 'info',
      label: 'WebDAV 备份',
      desc: '未提供：本应用不申请 INTERNET 权限（离线优先），要加需先改安全模型',
      testId: 'settings-backup-webdav',
      control: el('span', { class: 'settings-row__static', text: '未启用' }),
    }),
  );

  // ── 查词 ─────────────────────────────────────
  const lookup = section(
    '查词',
    'book',
    settingRow({
      icon: 'search',
      label: '长按查词',
      desc: '关闭后长按正文不再弹出查词卡片',
      control: switchControl({
        checked: settings.lookupEnabled,
        testId: 'lookup-enabled-switch',
        ariaLabel: '长按查词',
        onChange: (lookupEnabled) => patch({ lookupEnabled }),
      }),
    }),
    settingRow({
      icon: 'book',
      label: '词库',
      desc: '内置离线词库，查词不需要联网',
      control: el('span', { class: 'settings-row__static', text: '已内置' }),
    }),
    (() => {
      const wordbookBtn = el('button', {
        class: 'ui-btn ui-btn--ghost ui-press',
        type: 'button',
        'data-testid': 'settings-wordbook-open',
        text: `${state.words.length} 个`,
      });
      wordbookBtn.addEventListener('click', () => deps.openWordbook('words'));
      return settingRow({
        icon: 'bookmark',
        label: '生词本',
        desc: '查词时收藏的生词，按收藏时间排序',
        testId: 'settings-wordbook',
        control: wordbookBtn,
      });
    })(),
    (() => {
      const historyBtn = el('button', {
        class: 'ui-btn ui-btn--ghost ui-press',
        type: 'button',
        'data-testid': 'settings-history-open',
        text: `${state.lookupHistory.length} 条`,
      });
      historyBtn.addEventListener('click', () => deps.openWordbook('history'));
      return settingRow({
        icon: 'clock',
        label: '查词历史',
        desc: '最近查过的词，最多保留 100 条',
        testId: 'settings-history',
        control: historyBtn,
      });
    })(),
  );

  // ── 关于 ─────────────────────────────────────
  const buildInfo = el(
    'dl',
    { class: 'build-info', 'data-testid': 'build-info' },
    el('dt', { text: '版本 versionName' }),
    el('dd', { 'data-testid': 'build-version', text: deps.appVersion }),
    el('dt', { text: '构建指纹 buildId' }),
    el('dd', { 'data-testid': 'build-id', text: deps.buildId }),
    el('dt', { text: '网络权限' }),
    el('dd', { text: '未申请（完全离线）' }),
  );
  const about = section('关于', 'info', buildInfo);

  // 作为二级页被压入（例如从阅读页进设置）时给返回键；作为一级 tab 时它在栈底，没有可返回的地方。
  const pushed = state.nav.pages.length > 1;
  const actions: Node[] = pushed
    ? [
        el('button', {
          class: 'icon-btn',
          type: 'button',
          'data-testid': 'back-home',
          'aria-label': '返回',
          title: '返回',
          onclick: () => deps.dispatch({ type: 'nav/back' }),
        }, icon('back')),
      ]
    : [el('span', { class: 'appbar__spacer', 'aria-hidden': 'true' })];

  const page = el(
    'div',
    { class: 'shell', 'data-testid': 'shell' },
    el(
      'header',
      { class: 'appbar appbar--center' },
      ...actions,
      el('h1', { class: 'appbar__title', 'data-testid': 'app-title', text: '设置' }),
      el('span', { class: 'appbar__spacer', 'aria-hidden': 'true' }),
    ),
    el(
      'main',
      { class: pushed ? 'main' : 'main main--tabbed' },
      el(
        'div',
        { class: 'settings', 'data-testid': 'settings-panel' },
        appearance,
        reading,
        data,
        backup,
        lookup,
        about,
      ),
    ),
  );

  if (pushed) return page;
  page.append(renderTabBar('settings', deps));
  return page;
}
