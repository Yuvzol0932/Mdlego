import { APP_VERSION, BUILD_ID } from './core/build-info';
import { renderMarkdown } from './core/markdown';
import { typeAttributes, type TypePrefs } from './core/typography';
import type { Settings } from './core/types';
import { loadSettings, saveSettings } from './data/settings-store';
import { createInitialState, createStore, selectCurrentDoc, type Store } from './state/store';
import { renderApp } from './views/app';

/**
 * 应用入口。
 *
 * 职责边界（刻意保持很薄）：
 *   1. 读取已存设置
 *   2. 创建 store
 *   3. 把设置的视觉部分同步到 DOM 根节点（这是唯一的"写 DOM"职责）
 *   4. 把设置变更持久化
 *   5. 交给 views 渲染
 *
 * 业务逻辑一律不写在这里 —— 避免重演上一代 app.js 单文件膨胀的结局。
 */

/** 把排版设置写进根节点属性。CSS 据此选择档位，JS 不碰具体像素值。 */
function applyTypePrefs(prefs: TypePrefs): void {
  const attrs = typeAttributes(prefs);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(attrs)) {
    root.setAttribute(name, value);
  }
}

/** 把主题写进根节点。 */
function applyTheme(theme: Settings['theme']): void {
  document.documentElement.setAttribute('data-theme', theme);
}

/** 视觉同步：状态中的设置 → DOM 根节点属性。 */
function syncVisualSettings(settings: Settings): void {
  applyTheme(settings.theme);
  applyTypePrefs({
    typeScale: settings.typeScale,
    lineScale: settings.lineScale,
    paraScale: settings.paraScale,
    fontFamily: settings.fontFamily,
  });
}

/** 示例文档：M2 之前用于验证渲染与排版。 */
const SAMPLE = `# 词根 -spect-（看）

来自拉丁语 *specere*，表示「看」。同源词根还有 -spic-。掌握它，可以一次记住几十个考研高频词。

| 单词 | 词性 | 释义 |
| --- | --- | --- |
| inspect | v. | 检查，仔细看 |
| retrospect | n. | 回顾，回想 |
| prospect | n. | 前景，展望 |
| conspicuous | adj. | 显眼的，引人注目的 |

## 长难句拆解

> It is the interaction between the two that gives rise to the phenomenon.

主干是 \`It is ... that ...\` 强调句，被强调的部分是 the interaction between the two。注意 rise 在这里是名词。

### 复习清单

- [x] 拆分主干与修饰成分
- [ ] 标记三个并列的介词短语
- [ ] 用自己的话复述一遍

## 代码示例

\`\`\`ts
const roots = ['spect', 'spic'];
const words = roots.map((r) => \`-\${r}-\`);
\`\`\`

## 高频词

**conspicuous** /kənˈspɪkjuəs/ — 显眼的、引人注目的。

这里有 ==需要重点记忆== 的内容，也有 ~~已经排除~~ 的旧结论。
`;

/**
 * 启动应用。
 */
function bootstrap(): void {
  const initialSettings = loadSettings();

  const store: Store = createStore(
    createInitialState(initialSettings),
    (state) => {
      // 设置变化时：同步视觉 + 持久化。这两件事都属于副作用，只在 data/DOM 边界做。
      syncVisualSettings(state.settings);
      saveSettings(state.settings);
    },
  );

  // 首次同步：让设置立刻生效，而不是等第一次变更
  syncVisualSettings(initialSettings);

  const rootEl = document.querySelector<HTMLElement>('[data-testid="app-root"]');
  if (rootEl === null) return;

  const renderNow = (): void => {
    renderApp(rootEl, store.getState(), {
      dispatch: (action) => store.dispatch(action),
      appVersion: APP_VERSION,
      buildId: BUILD_ID,
      sample: SAMPLE,
      renderMarkdown,
    });
  };

  store.subscribe(renderNow);
  // hash 变化（比如点到 #/settings）也要重渲染，否则页面停在旧视图
  window.addEventListener('hashchange', renderNow);
  renderNow();

  // 首次把示例文档渲染进状态，让阅读区有内容
  const current = store.getState();
  if (current.docs.length === 0) {
    const doc = {
      id: 'sample-1',
      title: '词根 -spect-（看）',
      text: SAMPLE,
      encoding: 'utf-8' as const,
      source: { kind: 'inline' as const },
      fingerprint: null,
      importedAt: Date.now(),
      lastReadAt: null,
      progress: null,
    };
    store.dispatch({ type: 'doc/imported', doc });
    store.dispatch({ type: 'doc/opened', docId: doc.id });
    store.dispatch({ type: 'reader/ready', render: renderMarkdown(SAMPLE) });
  }

  void selectCurrentDoc;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
