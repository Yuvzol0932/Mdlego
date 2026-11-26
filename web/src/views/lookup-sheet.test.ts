// @vitest-environment jsdom
/**
 * 查词弹层：底部弹层不许继承顶部安全区（lookup #2 的防退化）。
 *
 * 背景：`.drawer`（library.css）为了侧滑目录让开状态栏，写了
 * `padding-top: var(--safe-top)`；`.drawer--bottom`（dict.css）只想把它清零。
 * 单类选择器与基类**同权**，谁生效完全取决于样式表加载顺序 ——
 * index.html 里 library.css 在 dict.css 之前，所以今天是对的，
 * 但任何人调整 <link> 顺序或把 dict.css 挪进别的入口，弹层顶部就会凭空多出
 * 一条状态栏高度的空白。
 *
 * 因此这里断言两件事：
 *   1. 底部弹层规则用双类选择器 `.drawer.drawer--bottom`（特异性压住，与顺序无关）
 *   2. 把两份 CSS 按 index.html 的真实顺序注入 jsdom，计算值仍为 0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 直接读源码文本。
 *
 * 为什么不用 `import css from '...css?raw'`：当前 vitest 配置下 `?raw` 拿到的是空串，
 * 会让断言静默变成「永远为真」的假绿。
 *
 * 为什么不用 `new URL(..., import.meta.url)`：jsdom 环境把全局 URL 换成了自己的实现，
 * fileURLToPath 会抛 ERR_INVALID_URL_SCHEME。测试进程的 cwd 是仓库根
 * （npm scripts 都在根目录跑），所以按仓库相对路径读。
 */
function readCss(file: 'dict' | 'library'): string {
  return readFileSync(`web/src/styles/${file}.css`, 'utf8');
}

const dictCss = readCss('dict');
const libraryCss = readCss('library');

/** 取某条规则的选择器块内容（只看第一条匹配）。 */
function ruleBody(css: string, selectorPattern: RegExp): string | null {
  const match = selectorPattern.exec(css);
  return match?.[1] ?? null;
}

function inject(cssText: string): void {
  const style = document.createElement('style');
  style.textContent = cssText;
  document.head.append(style);
}

function mountPanel(): HTMLElement {
  document.body.innerHTML = `
    <div class="drawer-root lookup-root" data-testid="lookup-card">
      <div class="drawer drawer--bottom glass lookup-panel" role="dialog" aria-label="释义">
        <span class="sheet-panel__handle lookup__handle" data-testid="lookup-handle" aria-hidden="true"></span>
        <header class="drawer__head">
          <span class="lookup__accent" data-testid="lookup-accent" aria-hidden="true"></span>
          <h2 class="drawer__title" data-testid="lookup-word">prospect</h2>
          <button class="lookup__save" type="button">生词本</button>
          <button class="icon-btn" type="button" aria-label="关闭">×</button>
        </header>
        <div class="lookup__body" data-testid="lookup-body">n. 景色, 展望</div>
      </div>
    </div>`;
  const panel = document.querySelector<HTMLElement>('[data-testid="lookup-card"] .lookup-panel');
  if (panel === null) throw new Error('弹层没有挂上');
  return panel;
}

describe('底部弹层不继承顶部安全区（lookup #2）', () => {
  it('底部弹层规则写成双类 .drawer.drawer--bottom，与加载顺序无关', () => {
    expect(ruleBody(dictCss, /\.drawer\.drawer--bottom\s*\{([\s\S]*?)\}/)).not.toBeNull();
    // 单类写法与 .drawer 同权 → 顺序一换就退化，禁止出现
    expect(/(^|\})\s*\.drawer--bottom\s*\{/.test(dictCss)).toBe(false);
  });

  it('底部弹层规则把 padding-top 清零，且不再引用 --safe-top', () => {
    const body = ruleBody(dictCss, /\.drawer\.drawer--bottom\s*\{([\s\S]*?)\}/) ?? '';
    expect(body).toContain('padding-top: 0');
    expect(body).not.toContain('--safe-top');
  });

  it('侧滑目录的基类仍然保留顶部安全区（别为了修底修坏顶）', () => {
    const body = ruleBody(libraryCss, /\.drawer\s*\{([\s\S]*?)\}/) ?? '';
    expect(body).toContain('padding-top: var(--safe-top)');
  });

  it('按 index.html 的真实顺序注入时，弹层 padding-top 为 0', () => {
    document.head.innerHTML = '';
    inject(libraryCss);
    inject(dictCss);
    const panel = mountPanel();
    const top = getComputedStyle(panel).paddingTop;
    expect(top === '0px' || top === '0').toBe(true);
  });

  it('顺序反过来也仍然为 0（证明靠特异性而不是靠顺序）', () => {
    document.head.innerHTML = '';
    inject(dictCss);
    inject(libraryCss);
    const panel = mountPanel();
    const top = getComputedStyle(panel).paddingTop;
    expect(top === '0px' || top === '0').toBe(true);
  });

  it('标题单词不允许设置省略号截断，允许自然折行显示完整单词', () => {
    const body = ruleBody(dictCss, /\.lookup-panel\s+\.drawer__title\s*\{[\s\S]*?\}\s*[\s\S]*?\.lookup-panel\s+\.drawer__title\s*\{([\s\S]*?)\}/)
      ?? dictCss;
    expect(body).not.toContain('text-overflow: ellipsis');
    expect(dictCss).toContain('overflow-wrap: anywhere');
  });
});
