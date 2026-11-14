import { APP_VERSION, BUILD_ID } from './core/build-info';
import { renderMarkdown } from './core/markdown';
import type { RenderResult } from './core/types';

/**
 * 应用入口 —— M0 阶段的空壳。
 *
 * 这一版只做一件事：证明整条流水线是通的。
 *   构建期常量能注入 → 渲染器能跑 → 样式能生效 → 打包后版本号可反读。
 *
 * 业务功能从 M2 开始接入，届时本文件会被 state/ 与 views/ 替代。
 */

const SAMPLE = `# 考研英语核心词根笔记

长按选中任意一句话，是之后要做的能力。现在这一步只验证渲染链路。

## 词根 -spect-（看）

来自拉丁语 *specere*，表示「看」。同源词根还有 -spic-。

| 单词 | 词性 | 释义 |
| --- | --- | --- |
| inspect | v. | 检查，仔细看 |
| retrospect | n. | 回顾，回想 |
| prospect | n. | 前景，展望 |
| conspicuous | adj. | 显眼的，引人注目的 |

## 长难句拆解

> It is the interaction between the two that gives rise to the phenomenon.

主干是 \`It is ... that ...\` 强调句，被强调的部分是 the interaction between the two。

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

type Route = 'home' | 'settings';

function readRoute(): Route {
  return location.hash === '#/settings' ? 'settings' : 'home';
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function renderHome(): HTMLElement {
  let render: RenderResult;
  try {
    render = renderMarkdown(SAMPLE);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return el('div', { class: 'shell', 'data-testid': 'shell' },
      el('header', { class: 'appbar' },
        el('h1', { class: 'appbar__title', 'data-testid': 'app-title', text: '墨读' }),
        el('a', { class: 'btn', href: '#/settings', 'data-testid': 'open-settings', text: '设置' }),
      ),
      el('main', { class: 'main' },
        el('div', { class: 'shelf__empty', 'data-testid': 'render-error', text: `渲染失败：${message}` }),
      ),
    );
  }

  const article = el('article', { class: 'article', 'data-testid': 'article' });
  article.innerHTML = render.html;

  return el('div', { class: 'shell', 'data-testid': 'shell' },
    el('header', { class: 'appbar' },
      el('h1', { class: 'appbar__title', 'data-testid': 'app-title', text: '墨读' }),
      el('a', { class: 'btn', href: '#/settings', 'data-testid': 'open-settings', text: '设置' }),
    ),
    el('main', { class: 'main main--reader' }, article),
  );
}

function renderSettings(): HTMLElement {
  const info = el('dl', { class: 'build-info', 'data-testid': 'build-info' },
    el('dt', { text: '版本 versionName' }),
    el('dd', { 'data-testid': 'build-version', text: APP_VERSION }),
    el('dt', { text: '构建指纹 buildId' }),
    el('dd', { 'data-testid': 'build-id', text: BUILD_ID }),
  );

  return el('div', { class: 'shell', 'data-testid': 'shell' },
    el('header', { class: 'appbar' },
      el('a', { class: 'btn', href: '#/', 'data-testid': 'back-home', text: '返回' }),
      el('h1', { class: 'appbar__title', 'data-testid': 'app-title', text: '设置' }),
    ),
    el('main', { class: 'main' },
      el('div', { class: 'panel' },
        el('div', { class: 'panel__row' },
          el('div', {},
            el('div', { class: 'panel__label', text: '完全离线' }),
            el('div', { class: 'panel__hint', text: '本应用不申请网络权限，笔记与标注只存在本机。' }),
          ),
        ),
        info,
      ),
    ),
  );
}

function mount(): void {
  const root = document.querySelector('[data-testid="app-root"]');
  if (root === null) return;
  const route = readRoute();
  root.replaceChildren(route === 'settings' ? renderSettings() : renderHome());
  document.documentElement.setAttribute('data-route', route);
}

window.addEventListener('hashchange', mount);

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
