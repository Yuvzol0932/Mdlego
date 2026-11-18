#!/usr/bin/env node
/**
 * 真实 Chrome 冒烟测试 —— 完整链路（M2 基线 + 阶段 C 新外壳）。
 *
 * 用 Chrome DevTools Protocol 在真实浏览器里跑真应用，
 * 以小米 14 Pro 的逻辑尺寸 + DPR 3 + 触摸模拟渲染，并截图留档。
 *
 * 链路：
 *   空书架 → 底部导航（五项、中间＋）→ 通过真实 <input type=file> 导入 .md
 *   → 书卡片出现 → 打开 → 正文渲染 → 目录 → 搜索 → 返回书架 → 设置页
 *
 * 阶段 C 起额外断言：每屏无横向溢出、玻璃层数 ≤ 3、底部导航只在 tab 页出现。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { serveStatic } from './serve.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const ARTIFACTS = join(ROOT, 'artifacts', 'screenshots');
const DIST_INDEX = join(ROOT, 'www', 'index.html');

/** Chrome 可执行文件候选。 */
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
];

/** 小米 14 Pro 逻辑参数。 */
const VIEWPORT = { width: 393, height: 873, deviceScaleFactor: 3, mobile: true };
const CDP_PORT = 9333;

/** 导入用的临时 Markdown 文件。 */
const SAMPLE_MD = join(ROOT, 'artifacts', '.smoke-sample.md');
const SAMPLE_CONTENT = `# 词根 -spect-（看）

来自拉丁语 *specere*，表示「看」。同源词根还有 -spic-。

| 单词 | 词性 | 释义 |
| --- | --- | --- |
| inspect | v. | 检查，仔细看 |
| retrospect | n. | 回顾，回想 |
| prospect | n. | 前景，展望 |

## 长难句拆解

> It is the interaction between the two that gives rise to the phenomenon.

主干是 \`It is ... that ...\` 强调句。

- [x] 拆分主干与修饰成分
- [ ] 标记三个并列的介词短语

## 代码示例

\`\`\`ts
const roots = ['spect', 'spic'];
\`\`\`

这里有 ==需要重点记忆== 的内容，也有 ~~已经排除~~ 的旧结论。
`;

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (p && existsSync(p)) return p;
  return null;
}

/** 极简 CDP 客户端。 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else res(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, reject) => {
      this.pending.set(id, { resolve: res, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 30000);
    });
  }
}

async function connect(port) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch { /* 尚未就绪 */ }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`页面脚本出错：${detail}`);
  }
  return result.result.value;
}

async function capture(cdp, sessionId, name) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  const file = join(ARTIFACTS, `${name}.png`);
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return file;
}

/** 点击带 data-testid 的元素，带重试。 */
async function click(cdp, sid, testId) {
  for (let i = 0; i < 15; i++) {
    const ok = await evaluate(cdp, sid, `(() => {
      const e = document.querySelector('[data-testid="${testId}"]');
      if (!e) return false;
      e.click();
      return true;
    })()`);
    if (ok === true) { await sleep(250); return true; }
    await sleep(120);
  }
  return false;
}

/** 同屏 backdrop-filter 层数（材质=glass 时才是真实成本）。 */
async function glassCount(cdp, sid) {
  return evaluate(cdp, sid, `(() => {
    let n = 0;
    for (const e of document.querySelectorAll('*')) {
      const v = getComputedStyle(e).backdropFilter;
      if (v && v !== 'none') n++;
    }
    return n;
  })()`);
}

/**
 * 每屏的通用布局断言：不允许横向溢出；玻璃层 ≤ 3（设计硬约束）。
 * 溢出会表现为 `scrollWidth > innerWidth`，通常是某个 fixed 悬浮件或长单词把页面撑宽。
 */
async function checkLayout(cdp, sid, label) {
  const info = await evaluate(cdp, sid, `(() => ({
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth,
    bodyW: document.body.scrollWidth,
  }))()`);
  check(`${label}：无横向溢出`, info !== null && info.scrollW <= info.innerW + 1 && info.bodyW <= info.innerW + 1,
    info === null ? '(取不到尺寸)' : `${info.scrollW}/${info.innerW}`);
  const glass = await glassCount(cdp, sid);
  check(`${label}：同屏玻璃层 ≤ 3`, glass <= 3, `${glass} 层`);
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  if (!existsSync(DIST_INDEX)) {
    console.error('✗ 未找到 www/index.html，请先运行 npm run build');
    process.exit(1);
  }
  const chrome = findChrome();
  if (chrome === null) {
    console.error('✗ 未找到 Chrome');
    process.exit(1);
  }

  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(SAMPLE_MD, SAMPLE_CONTENT, 'utf8');

  // ES module 在 file:// 下会被 CORS 静默拦截，必须走 HTTP
  const server = await serveStatic(join(ROOT, 'www'));
  console.log(`静态服务：${server.url}`);
  console.log(`启动 Chrome：${chrome}`);

  const proc = spawn(chrome, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    '--user-data-dir=' + join(ROOT, 'artifacts', '.chrome-profile'),
    'about:blank',
  ], { stdio: 'ignore' });

  let cdp;
  try {
    const wsUrl = await connect(CDP_PORT);
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });
    cdp = new Cdp(ws);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    // 阶段 E3：备份导出后要读回剪贴板做往返验证，headless 需要显式授权
    try {
      await cdp.send('Browser.grantPermissions', {
        origin: new URL(server.url).origin,
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
      });
    } catch {
      /* 权限授予失败不致命：下面的断言会显示为「剪贴板不可用」 */
    }
    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Runtime.enable', {}, sid);
    await cdp.send('DOM.enable', {}, sid);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { ...VIEWPORT, screenWidth: VIEWPORT.width, screenHeight: VIEWPORT.height }, sid,
    );
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sid);

    // 干净起点：清掉 IndexedDB 与 localStorage，保证每次可重复
    await cdp.send('Page.navigate', { url: server.url }, sid);
    await sleep(800);
    await evaluate(cdp, sid, `(() => {
      localStorage.clear();
      return new Promise((res) => {
        const r = indexedDB.deleteDatabase('mdlego');
        r.onsuccess = r.onerror = r.onblocked = () => res(true);
      });
    })()`);
    await cdp.send('Page.reload', {}, sid);
    await sleep(1600);

    console.log('\n【空书架】');

    const mounted = await evaluate(cdp, sid, `!!document.querySelector('[data-testid="shell"]')`);
    check('应用挂载', mounted === true);

    const empty = await evaluate(cdp, sid, `!!document.querySelector('[data-testid="shelf-empty"]')`);
    check('首次启动显示空书架', empty === true);

    const title = await evaluate(cdp, sid, `document.querySelector('[data-testid="app-title"]')?.textContent ?? ''`);
    check('顶栏标题为「墨读」', title === '墨读', title);

    const brand = await evaluate(cdp, sid, `(() => {
      const bar = document.querySelector('.appbar');
      const title = bar?.querySelector('[data-testid="app-title"]')?.textContent?.trim() ?? '';
      const buttons = bar ? [...bar.querySelectorAll('a, button')] : [];
      return {
        title,
        count: buttons.length,
        iconOnly: buttons.every((n) => (n.textContent ?? '').trim().length === 0 && !!n.querySelector('svg.icon')),
        labelled: buttons.every((n) => n.hasAttribute('aria-label')),
      };
    })()`);
    check('顶栏显示应用名', brand.title === '墨读', brand.title);
    check('顶栏按钮都是带无障碍标签的图标按钮', brand.iconOnly && brand.labelled, `入口 ${brand.count} 个`);

    const tabbar = await evaluate(cdp, sid, `(() => {
      const nav = document.querySelector('[data-testid="tabbar"]');
      if (!nav) return null;
      const items = [...nav.querySelectorAll('.tabbar__item')];
      const r = nav.getBoundingClientRect();
      return {
        items: items.length,
        active: items.filter((n) => n.getAttribute('aria-current') === 'page').map((n) => n.getAttribute('data-testid')),
        plus: !!nav.querySelector('[data-testid="import-file"]'),
        top: r.top, bottom: r.bottom, vh: window.innerHeight,
      };
    })()`);
    check('底部导航五项（4 个 tab + 中间＋）', tabbar !== null && tabbar.items === 4 && tabbar.plus === true,
      tabbar === null ? '(未找到 tabbar)' : `tab ${tabbar.items} + plus ${tabbar.plus}`);
    check('底部导航当前项高亮为书架', tabbar !== null && tabbar.active.length === 1 && tabbar.active[0] === 'tab-shelf',
      tabbar?.active.join(','));
    check('底部导航在视口内（安全区占用正确）',
      tabbar !== null && tabbar.bottom <= tabbar.vh + 2 && tabbar.top > tabbar.vh - 160,
      tabbar === null ? '' : `top ${Math.round(tabbar.top)} / bottom ${Math.round(tabbar.bottom)} / vh ${tabbar.vh}`);

    await checkLayout(cdp, sid, '书架');
    await capture(cdp, sid, 'm2-01-empty-shelf');

    // ── 真实文件导入（通过 <input type=file> + CDP setFileInputFiles） ──
    console.log('\n【导入真实 .md 文件】');

    // 真实链路：点底部导航中间的「＋」→ 应用创建 <input type=file> 并 click()
    // → 用 CDP 给那个 input 设文件 → change 事件自然触发导入流程。
    // 这样测的是产品自己的代码路径，不是测试专用的捷径。
    await click(cdp, sid, 'import-file');
    await sleep(300);

    const { root: domRoot } = await cdp.send('DOM.getDocument', {}, sid);
    const { nodeId } = await cdp.send(
      'DOM.querySelector',
      { nodeId: domRoot.nodeId, selector: 'input[type=file]' },
      sid,
    );
    if (!nodeId) throw new Error('应用未创建文件输入框');
    await cdp.send('DOM.setFileInputFiles', { files: [SAMPLE_MD], nodeId }, sid);
    await sleep(1400);

    const toastText = await evaluate(cdp, sid,
      `document.querySelector('[data-testid="toast"]')?.textContent ?? ''`);
    check('导入后有反馈提示', toastText.includes('导入'), toastText || '(无 toast)');

    // 重载，让真实的启动流程从 IndexedDB 读出来（验证持久化）
    await cdp.send('Page.reload', {}, sid);
    await sleep(1600);

    const cardCount = await evaluate(cdp, sid, `document.querySelectorAll('[data-testid="doc-item"]').length`);
    check('书架上出现 1 张卡片', cardCount === 1, `${cardCount} 张`);
    check('空状态消失', await evaluate(cdp, sid, `!document.querySelector('[data-testid="shelf-empty"]')`) === true);

    const cardTitle = await evaluate(cdp, sid,
      `document.querySelector('.book-card__title, .book-row__title, .doc-item__title')?.textContent ?? ''`);
    check('卡片标题从 Markdown 推断', cardTitle.includes('spect'), cardTitle);

    check('底部导航仍在书架页', await evaluate(cdp, sid, `!!document.querySelector('[data-testid="tabbar"]')`) === true);
    await checkLayout(cdp, sid, '书架（有文档）');

    await capture(cdp, sid, 'm2-02-shelf');

    // ── 书架更多菜单：排序 / 视图切换（阶段 C2） ──
    console.log('\n【书架菜单】');
    await click(cdp, sid, 'shelf-more');
    check('书架菜单打开', await evaluate(cdp, sid, `!!document.querySelector('[data-testid="menu-panel"]')`) === true);
    check('菜单里有排序与视图项', await evaluate(cdp, sid,
      `!!document.querySelector('[data-testid="menu-shelf-sort-name"]') && !!document.querySelector('[data-testid="menu-shelf-view-list"]')`) === true);
    await checkLayout(cdp, sid, '书架菜单');
    await capture(cdp, sid, 'c-03-shelf-menu');

    await click(cdp, sid, 'menu-shelf-view-list');
    await sleep(300);
    check('切到列表视图', await evaluate(cdp, sid,
      `!!document.querySelector('.shelf-list') && !!document.querySelector('.book-row')`) === true);
    await checkLayout(cdp, sid, '书架列表视图');
    await capture(cdp, sid, 'c-04-shelf-list');
    await click(cdp, sid, 'shelf-more');
    await click(cdp, sid, 'menu-shelf-view-grid');
    await sleep(300);

    // ── 阶段 E1：长按多选 → 加标签 → 按标签筛选 ──
    console.log('\n【书架筛选与标签】');
    await evaluate(cdp, sid, `(() => {
      const card = document.querySelector('[data-testid="doc-item"]');
      if (!card) return false;
      const rect = card.getBoundingClientRect();
      card.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, clientX: rect.left + 12, clientY: rect.top + 12,
      }));
      return true;
    })()`);
    await sleep(700);
    check('长按进入多选', await evaluate(cdp, sid,
      `!document.querySelector('[data-testid="shelf-selectbar"]')?.hasAttribute('hidden')`) === true);
    const tagSheetOpened = await click(cdp, sid, 'shelf-select-tag');
    await sleep(450);
    check('标签面板打开', tagSheetOpened === true
      && await evaluate(cdp, sid, `!!document.querySelector('[data-testid="collection-sheet"]')`) === true);
    await evaluate(cdp, sid, `(() => {
      const input = document.querySelector('[data-testid="collection-input"]');
      if (!input) return false;
      input.value = '考研';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await click(cdp, sid, 'collection-submit');
    await sleep(450);
    check('标签写入并出现在面板', await evaluate(cdp, sid,
      `!!document.querySelector('[data-testid="collection-tag-chip"][data-tag="考研"]')`) === true);
    await click(cdp, sid, 'collection-close');
    await sleep(500);
    await click(cdp, sid, 'shelf-select-cancel');
    await sleep(500);
    check('筛选条出现标签 chip', await evaluate(cdp, sid,
      `!!document.querySelector('[data-testid="shelf-filter-tag-0"]')`) === true);
    await click(cdp, sid, 'shelf-filter-tag-0');
    await sleep(450);
    check('按标签筛选生效（计数文案）', await evaluate(cdp, sid,
      `document.querySelector('[data-testid="shelf-count"]')?.textContent?.includes('筛选出')`) === true);
    await click(cdp, sid, 'shelf-filter-tag-0');
    await sleep(350);
    check('再点一次回到全部', await evaluate(cdp, sid,
      `document.querySelector('[data-testid="shelf-count"]')?.textContent?.includes('共 ')`) === true);
    await checkLayout(cdp, sid, '书架筛选');

    // ── 打开文档 ──
    console.log('\n【阅读器】');
    await click(cdp, sid, 'doc-item');
    await sleep(900);

    const blockCount = await evaluate(cdp, sid, `document.querySelectorAll('[data-bid]').length`);
    check('可标注块已生成', blockCount > 10, `${blockCount} 个`);

    const uniqueBids = await evaluate(cdp, sid,
      `new Set([...document.querySelectorAll('[data-bid]')].map(e => e.getAttribute('data-bid'))).size`);
    check('块锚点唯一', uniqueBids === blockCount, `${uniqueBids} vs ${blockCount}`);
    check('==高亮== 扩展生效',
      await evaluate(cdp, sid, `document.querySelectorAll('.article mark').length`) > 0);
    const taskCount = await evaluate(cdp, sid, `document.querySelectorAll('.task-box').length`);
    check('任务清单复选框', taskCount === 2, `${taskCount} 个`);

    // ── 阶段 E2：划词批注（程序化选区走原生 selectionchange 兼容路径）──
    console.log('\n【划词批注】');
    const selectRange = async (maxLen) => evaluate(cdp, sid, `(() => {
      const art = document.querySelector('[data-testid="article"]');
      const p = art.querySelector('p[data-bid]');
      if (!p) return 0;
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
      const t = walker.nextNode();
      if (!t || t.data.trim().length === 0) return 0;
      const len = Math.min(${maxLen}, t.data.length);
      const range = document.createRange();
      range.setStart(t, 0);
      range.setEnd(t, len);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return len;
    })()`);
    const selectedLength = await selectRange(10);
    await sleep(400);
    check('选中文字后出现标注工具条', await evaluate(cdp, sid, `!!document.querySelector('[data-testid="mark-toolbar"]')`) === true, `${selectedLength} 字`);
    check('系统支持 CSS Highlight API',
      await evaluate(cdp, sid, `!!(CSS.highlights && window.Highlight)`) === true);
    await click(cdp, sid, 'mark-color-yellow');
    await sleep(350);
    const yellowRanges = await evaluate(cdp, sid, `CSS.highlights?.get('mdlego-hl-yellow')?.size ?? 0`);
    check('黄色高亮已绘制到正文', yellowRanges >= 1, `${yellowRanges} 段`);
    await selectRange(12);
    await sleep(350);
    await click(cdp, sid, 'mark-underline');
    await sleep(350);
    check('下划线已绘制',
      (await evaluate(cdp, sid, `CSS.highlights?.get('mdlego-underline')?.size ?? 0`)) >= 1);
    await selectRange(8);
    await sleep(350);
    await click(cdp, sid, 'mark-note');
    await sleep(500);
    check('批注备注面板打开', await evaluate(cdp, sid, `!!document.querySelector('[data-testid="note-sheet"]')`) === true);
    await evaluate(cdp, sid, `(() => {
      const area = document.querySelector('[data-testid="note-input"]');
      if (!area) return false;
      area.value = '这是一条 smoke 批注';
      area.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await click(cdp, sid, 'note-save');
    await sleep(500);
    await click(cdp, sid, 'reader-more');
    await sleep(400);
    await click(cdp, sid, 'open-marks');
    await sleep(600);
    check('批注列表打开', await evaluate(cdp, sid, `!!document.querySelector('[data-testid="marks-sheet"]')`) === true);
    const markItems = await evaluate(cdp, sid, `document.querySelectorAll('[data-testid="mark-item"]').length`);
    check('批注列表列出 3 条', markItems === 3, `${markItems} 条`);
    check('列表显示备注文本', await evaluate(cdp, sid,
      `[...document.querySelectorAll('[data-testid="mark-item"]')].some((e) => e.textContent.includes('smoke 批注'))`) === true);
    await checkLayout(cdp, sid, '批注列表');
    await capture(cdp, sid, 'e2-01-marks-list');
    await click(cdp, sid, 'marks-export');
    await sleep(450);
    // headless 下 Clipboard 权限可能被拒：成功/失败提示都算「导出动作可达」，内容正确性由单测保证
    const exportToast = await evaluate(cdp, sid,
      `document.querySelector('[data-testid="toast"]')?.textContent ?? ''`);
    check('导出触发剪贴板提示', exportToast.includes('批注') || exportToast.includes('复制'), exportToast || '(无提示)');
    await click(cdp, sid, 'marks-close');
    await sleep(500);

    // 刷新后标注仍在（持久化 + 重新打开时重定位）
    await cdp.send('Page.navigate', { url: server.url }, sid);
    await sleep(1000);
    await click(cdp, sid, 'doc-item');
    await sleep(1400);
    const afterReload = await evaluate(cdp, sid, `CSS.highlights?.get('mdlego-hl-yellow')?.size ?? 0`);
    check('刷新后标注仍在（已持久化 + 重定位）', afterReload >= 1, `${afterReload} 段`);

    const tableWrap = await evaluate(cdp, sid,
      `!!document.querySelector('.article .table-wrap table')`);
    check('表格由滚动容器包裹', tableWrap === true);
    check('代码块可横向滚动',
      await evaluate(cdp, sid, `getComputedStyle(document.querySelector('.article pre')).overflowX`) === 'auto');
    check('原文 HTML 未执行',
      await evaluate(cdp, sid, `document.querySelectorAll('.article script, .article iframe').length`) === 0);
    check('阅读工具栏存在', await evaluate(cdp, sid, `!!document.querySelector('[data-testid="reader-bar"]')`) === true);
    check('阅读页隐藏底部导航', await evaluate(cdp, sid, `!document.querySelector('[data-testid="tabbar"]')`) === true);
    check('阅读底栏有进度条与百分比', await evaluate(cdp, sid, `(() => {
      const bar = document.querySelector('[data-testid="reader-progress"]');
      const text = document.querySelector('[data-testid="reader-progress-text"]')?.textContent ?? '';
      return !!bar && /已读 \\d+%/.test(text);
    })()`) === true);
    await checkLayout(cdp, sid, '阅读页');

    await capture(cdp, sid, 'm2-03-reader');

    // ── 顶栏收放（随滚动方向）与沉浸模式 ──
    console.log('\n【顶栏收放 / 收藏】');
    await evaluate(cdp, sid, `window.scrollTo(0, 600); true`);
    await sleep(350);
    const barsAfterDown = await evaluate(cdp, sid, `document.querySelector('.reader-page')?.getAttribute('data-bars')`);
    check('向下滚动后顶栏收起', barsAfterDown === 'hidden', String(barsAfterDown));
    await evaluate(cdp, sid, `window.scrollTo(0, 200); true`);
    await sleep(350);
    const barsAfterUp = await evaluate(cdp, sid, `document.querySelector('.reader-page')?.getAttribute('data-bars')`);
    check('向上滚动后顶栏回来', barsAfterUp === 'shown', String(barsAfterUp));
    await evaluate(cdp, sid, `window.scrollTo(0, 0); true`);
    await sleep(300);

    const bookmarkBefore = await evaluate(cdp, sid,
      `document.querySelector('[data-testid="bookmark-toggle"]')?.getAttribute('aria-pressed')`);
    await click(cdp, sid, 'bookmark-toggle');
    const bookmarkAfter = await evaluate(cdp, sid,
      `document.querySelector('[data-testid="bookmark-toggle"]')?.getAttribute('aria-pressed')`);
    check('收藏按钮切换 aria-pressed', bookmarkBefore === 'false' && bookmarkAfter === 'true',
      `${bookmarkBefore} → ${bookmarkAfter}`);
    await click(cdp, sid, 'bookmark-toggle');

    // ── Aa 排版面板 ──
    console.log('\n【Aa 排版面板】');
    const typesetOpened = await click(cdp, sid, 'open-typeset');
    check('排版面板能打开', typesetOpened === true
      && await evaluate(cdp, sid, `!!document.querySelector('[data-testid="typeset-sheet"]')`) === true);
    await checkLayout(cdp, sid, '排版面板');
    await capture(cdp, sid, 'c-05-typeset');
    const scaleBefore = await evaluate(cdp, sid, `document.documentElement.getAttribute('data-type-scale')`);
    await evaluate(cdp, sid, `(() => {
      const s = document.querySelector('[data-testid="typeset-type-scale"]');
      if (!s) return false;
      s.value = String(Number(s.value) + 1);
      s.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    const scaleAfter = await evaluate(cdp, sid, `document.documentElement.getAttribute('data-type-scale')`);
    check('Aa 面板改字号即时生效', scaleBefore !== scaleAfter, `${scaleBefore} → ${scaleAfter}`);
    await click(cdp, sid, 'typeset-close');
    check('排版面板能关闭',
      await evaluate(cdp, sid, `!document.querySelector('[data-testid="typeset-sheet"]')`) === true);

    // ── 目录（在「更多」菜单里） ──
    console.log('\n【目录】');
    await click(cdp, sid, 'reader-more');
    check('阅读更多菜单打开', await evaluate(cdp, sid, `!!document.querySelector('[data-testid="menu-panel"]')`) === true);
    const tocOpened = await click(cdp, sid, 'open-toc');
    check('目录抽屉能打开', tocOpened === true);
    const tocCount = await evaluate(cdp, sid, `document.querySelectorAll('[data-testid="toc-item"]').length`);
    check('目录列出标题', tocCount >= 3, `${tocCount} 项`);
    await checkLayout(cdp, sid, '目录抽屉');
    await capture(cdp, sid, 'm2-04-toc');
    await click(cdp, sid, 'toc-drawer-close');

    // ── 搜索 ──
    console.log('\n【单篇搜索】');
    const searchOpened = await click(cdp, sid, 'open-search');
    check('搜索浮层能打开', searchOpened === true);
    await evaluate(cdp, sid, `(() => {
      const i = document.querySelector('[data-testid="search-input"]');
      if (i) { i.value = 'spect'; i.dispatchEvent(new Event('input', { bubbles: true })); }
      return true;
    })()`);
    await sleep(700);
    const hits = await evaluate(cdp, sid, `document.querySelectorAll('[data-testid="search-hit"]').length`);
    check('搜索到命中结果', hits > 0, `${hits} 处`);
    await checkLayout(cdp, sid, '搜索浮层');
    await capture(cdp, sid, 'm2-05-search');
    await click(cdp, sid, 'search-close');

    // ── 阶段 C 新 tab：搜索 / 统计 ──
    console.log('\n【搜索 tab（全库搜索）】');
    await evaluate(cdp, sid, `location.hash = '#/search'; true`);
    await sleep(600);
    check('搜索 tab 挂载', await evaluate(cdp, sid, `!!document.querySelector('[data-testid="search-page"]')`) === true);
    check('搜索 tab 高亮的是搜索', await evaluate(cdp, sid, `(() => {
      const nav = document.querySelector('[data-testid="tabbar"]');
      return nav?.querySelector('[aria-current="page"]')?.getAttribute('data-testid') === 'tab-search';
    })()`) === true);
    const libraryHits = await evaluate(cdp, sid, `(async () => {
      const input = document.querySelector('[data-testid="library-search-input"]');
      if (!input) return -1;
      input.value = 'spect';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 600));
      return document.querySelectorAll('[data-testid="library-search-hit"]').length;
    })()`);
    check('全库搜索有命中', libraryHits > 0, `${libraryHits} 条`);
    check('搜索结果按文档分组', await evaluate(cdp, sid,
      `document.querySelectorAll('[data-testid="library-search-group"]').length > 0`) === true);
    check('搜索范围 chip 存在', await evaluate(cdp, sid,
      `!!document.querySelector('[data-testid="search-scope-all"]') && !!document.querySelector('[data-testid="search-scope-favorites"]')`) === true);
    await click(cdp, sid, 'search-scope-favorites');
    await sleep(500);
    check('仅收藏范围有明确文案', await evaluate(cdp, sid,
      `document.querySelector('[data-testid="library-search-hint"]')?.textContent?.includes('收藏')`) === true);
    await click(cdp, sid, 'search-scope-all');
    await sleep(400);
    await checkLayout(cdp, sid, '搜索 tab');
    await capture(cdp, sid, 'c-01-search-tab');

    console.log('\n【统计 tab】');
    await evaluate(cdp, sid, `location.hash = '#/stats'; true`);
    await sleep(600);
    check('统计 tab 挂载', await evaluate(cdp, sid,
      `!!document.querySelector('[data-testid="stats"]') || !!document.querySelector('[data-testid="stats-empty"]')`) === true);
    await checkLayout(cdp, sid, '统计 tab');
    await capture(cdp, sid, 'c-02-stats-tab');

    // 端到端：刚才真的读过一篇（≥3 秒），会话应已落库并算出统计
    let statsToday = '';
    for (let i = 0; i < 20 && statsToday === ''; i++) {
      statsToday = await evaluate(cdp, sid,
        `document.querySelector('[data-testid="stats-today"]')?.textContent ?? ''`);
      if (statsToday === '') await sleep(150);
    }
    check('统计页出现阅读时长（会话已落库）', statsToday.length > 0, statsToday || '(空状态)');
    check('统计页有 7 日柱状图', await evaluate(cdp, sid, `!!document.querySelector('[data-testid="stats-chart"]')`) === true);

    // ── 阶段 E4：查词卡片 / 生词本 / 查词历史 ──
    console.log('\n【查词与生词本】');
    // 上一段停在统计 tab，先回到书架再打开文档（查词需要正文）
    await evaluate(cdp, sid, `location.hash = '#/'; true`);
    await sleep(600);
    await click(cdp, sid, 'doc-item');
    await sleep(1100);
    const selectNeedle = async (needle) => evaluate(cdp, sid, `(() => {
      const art = document.querySelector('[data-testid="article"]');
      const walker = document.createTreeWalker(art, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const at = node.data.indexOf(${JSON.stringify(needle)});
        if (at >= 0) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + ${needle.length});
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          document.dispatchEvent(new Event('selectionchange'));
          return true;
        }
      }
      return false;
    })()`);
    check('选中单词 inspect', (await selectNeedle('inspect')) === true);
    await sleep(450);
    await click(cdp, sid, 'mark-lookup');
    await sleep(1200);
    check('查词卡片打开', await evaluate(cdp, sid,
      `!!document.querySelector('[data-testid="lookup-card"]')`) === true);
    check('卡片显示单词与释义', await evaluate(cdp, sid, `(() => {
      const word = document.querySelector('[data-testid="lookup-word"]')?.textContent ?? '';
      const translation = document.querySelector('[data-testid="lookup-translation"]')?.textContent ?? '';
      return word.toLowerCase() === 'inspect' && translation.length > 0;
    })()`) === true);
    check('查词卡片是玻璃底面板', await evaluate(cdp, sid,
      `!!document.querySelector('[data-testid="lookup-card"] .lookup-panel.glass')`) === true);
    await capture(cdp, sid, 'e4-01-lookup-card');
    await click(cdp, sid, 'lookup-save-word');
    await sleep(500);
    check('加入生词本有提示', await evaluate(cdp, sid,
      `(document.querySelector('[data-testid="toast"]')?.textContent ?? '').includes('生词本')`) === true);
    await click(cdp, sid, 'lookup-close');
    await sleep(500);

    await evaluate(cdp, sid, `location.hash = '#/settings'; true`);
    await sleep(900);
    check('设置页显示生词本数量', await evaluate(cdp, sid,
      `document.querySelector('[data-testid="settings-wordbook-open"]')?.textContent?.includes('1')`) === true);
    check('设置页显示查词历史数量', await evaluate(cdp, sid,
      `document.querySelector('[data-testid="settings-history-open"]')?.textContent?.includes('1')`) === true);
    await click(cdp, sid, 'settings-wordbook-open');
    await sleep(800);
    check('生词本面板打开', await evaluate(cdp, sid,
      `!!document.querySelector('[data-testid="wordbook-sheet"]')`) === true);
    check('生词本含 inspect', await evaluate(cdp, sid,
      `[...document.querySelectorAll('[data-testid="wordbook-item"]')].some((e) => e.getAttribute('data-word') === 'inspect')`) === true);
    await checkLayout(cdp, sid, '生词本');
    await capture(cdp, sid, 'e4-02-wordbook');
    await click(cdp, sid, 'wordbook-tab-history');
    await sleep(500);
    check('查词历史含 inspect', await evaluate(cdp, sid,
      `[...document.querySelectorAll('[data-testid="history-item"]')].some((e) => e.getAttribute('data-word') === 'inspect')`) === true);
    await click(cdp, sid, 'wordbook-close');
    await sleep(500);

    // ── 返回书架 & 设置 ──
    console.log('\n【返回与设置】');
    await evaluate(cdp, sid, `location.hash = '#/'; true`);
    await sleep(400);
    await click(cdp, sid, 'doc-item');
    await sleep(900);
    await click(cdp, sid, 'back-to-shelf');
    await sleep(400);
    check('返回书架', await evaluate(cdp, sid, `!!document.querySelector('[data-testid="shelf"]')`) === true);

    await evaluate(cdp, sid, `location.hash = '#/settings'; true`);
    await sleep(700);
    const version = await evaluate(cdp, sid, `document.querySelector('[data-testid="build-version"]')?.textContent ?? ''`);
    // 允许语义化预发布段：1.0.0-rc.2（此前只认 x.y.z，rc 版本会被误报）
    check('设置页显示版本号', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version), version);
    const buildId = await evaluate(cdp, sid, `document.querySelector('[data-testid="build-id"]')?.textContent ?? ''`);
    check('设置页显示构建指纹', buildId.length > 5, buildId);
    await checkLayout(cdp, sid, '设置页');
    await capture(cdp, sid, 'm2-06-settings');

    // ── 阶段 E3：备份与恢复 ──
    console.log('\n【备份与恢复】');
    check('设置页有备份入口', await evaluate(cdp, sid,
      `!!document.querySelector('[data-testid="settings-backup-export"]') && !!document.querySelector('[data-testid="settings-backup-import"]')`) === true);
    await checkLayout(cdp, sid, '设置页·备份');
    await capture(cdp, sid, 'e3-01-backup-section');
    await click(cdp, sid, 'backup-export');
    await sleep(800);
    const backupExportToast = await evaluate(cdp, sid,
      `document.querySelector('[data-testid="toast"]')?.textContent ?? ''`);
    check('导出备份有明确提示', backupExportToast.includes('备份'), backupExportToast || '(无提示)');
    const backupText = await evaluate(cdp, sid, `(async () => {
      try { return await navigator.clipboard.readText(); } catch (error) { return 'ERR:' + String(error); }
    })()`);
    check('备份可从剪贴板读回', typeof backupText === 'string' && backupText.includes('"format": "mdlego-backup"'),
      typeof backupText === 'string' ? backupText.slice(0, 26) : '(非字符串)');
    check('备份含文档/批注/设置字段',
      backupText.includes('"docs"') && backupText.includes('"marks"') && backupText.includes('"settings"') === true);
    check('备份为 schemaVersion 2 且含生词本字段',
      backupText.includes('"schemaVersion": 2') && backupText.includes('"vocabulary"') === true);
    await click(cdp, sid, 'backup-import-clipboard');
    await sleep(700);
    check('恢复前弹确认层', await evaluate(cdp, sid,
      `!!document.querySelector('[data-testid="restore-confirm"]')`) === true);
    await capture(cdp, sid, 'e3-02-restore-confirm');
    await click(cdp, sid, 'restore-confirm');
    await sleep(1200);
    const restoredToast = await evaluate(cdp, sid,
      `document.querySelector('[data-testid="toast"]')?.textContent ?? ''`);
    check('恢复后有明确提示', restoredToast.includes('已恢复'), restoredToast || '(无提示)');
    await evaluate(cdp, sid, `location.hash = '#/'; true`);
    await sleep(800);
    const restoredDocs = await evaluate(cdp, sid,
      `document.querySelectorAll('[data-testid="doc-item"]').length`);
    check('恢复后文档仍在（往返一致）', restoredDocs === 1, `${restoredDocs} 篇`);

    // 损坏备份必须被拒绝，而不是写坏本机
    await evaluate(cdp, sid, `(async () => {
      try { await navigator.clipboard.writeText('not a json'); } catch {}
      return true;
    })()`);
    await evaluate(cdp, sid, `location.hash = '#/settings'; true`);
    await sleep(700);
    await click(cdp, sid, 'backup-import-clipboard');
    await sleep(700);
    const invalidToast = await evaluate(cdp, sid,
      `document.querySelector('[data-testid="toast"]')?.textContent ?? ''`);
    check('损坏备份被拒绝并说明原因', invalidToast.includes('JSON'), invalidToast || '(无提示)');
    check('拒绝后没有出现恢复确认层', await evaluate(cdp, sid,
      `!document.querySelector('[data-testid="restore-confirm"]')`) === true);

    // ── 阶段 E5：编辑原文 ──
    console.log('\n【编辑原文】');
    await evaluate(cdp, sid, `location.hash = '#/'; true`);
    await sleep(600);
    await click(cdp, sid, 'doc-item');
    await sleep(1100);
    await click(cdp, sid, 'reader-more');
    await sleep(400);
    await click(cdp, sid, 'open-editor');
    await sleep(900);
    check('编辑器打开', await evaluate(cdp, sid,
      `!!document.querySelector('[data-testid="editor-page"]')`) === true);
    const originalLength = await evaluate(cdp, sid,
      `document.querySelector('[data-testid="editor-input"]')?.value.length ?? 0`);
    check('编辑器载入原文', originalLength > 100, `${originalLength} 字`);
    await evaluate(cdp, sid, `(() => {
      const input = document.querySelector('[data-testid="editor-input"]');
      if (!input) return false;
      input.value += '\\n\\n## smoke 追加标题\\n\\n编辑保存验证。';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    check('输入后出现未保存标记', await evaluate(cdp, sid,
      `document.querySelector('[data-testid="editor-dirty"]')?.textContent?.includes('未保存')`) === true);
    await click(cdp, sid, 'editor-tab-preview');
    await sleep(600);
    check('实时预览显示新内容', await evaluate(cdp, sid,
      `(document.querySelector('[data-testid="editor-preview"]')?.textContent ?? '').includes('smoke 追加标题')`) === true);
    await capture(cdp, sid, 'e56-01-editor');
    await click(cdp, sid, 'editor-save');
    await sleep(900);
    // 浏览器里拿不到原文件 → 弹「没有可写回的原文件」，选择存为应用内副本
    check('无原文件时弹保存方式选择', await evaluate(cdp, sid,
      `!!document.querySelector('[data-testid="editor-save-copy"]')`) === true);
    await capture(cdp, sid, 'e56-02-save-dialog');
    await click(cdp, sid, 'editor-save-copy');
    await sleep(900);
    check('已存为应用内副本', await evaluate(cdp, sid,
      `(document.querySelector('[data-testid="toast"]')?.textContent ?? '').includes('副本')`) === true);
    // 保存副本后回到阅读页；再返回书架确认新文档已落库
    if (await evaluate(cdp, sid, `!!document.querySelector('[data-testid="back-to-shelf"]')`)) {
      await click(cdp, sid, 'back-to-shelf');
      await sleep(700);
    }
    if (!(await evaluate(cdp, sid, `!!document.querySelector('[data-testid="shelf"]')`))) {
      await evaluate(cdp, sid, `location.hash = '#/'; true`);
      await sleep(700);
    }
    const docCountAfterCopy = await evaluate(cdp, sid,
      `document.querySelectorAll('[data-testid="doc-item"]').length`);
    check('副本出现在书架', docCountAfterCopy >= 2, `${docCountAfterCopy} 篇`);

    // ── 阶段 E6：朗读 / 护眼 / 导出 HTML ──
    console.log('\n【阅读增强】');
    await evaluate(cdp, sid, `location.hash = '#/settings'; true`);
    await sleep(900);
    await click(cdp, sid, 'eye-care-switch');
    await sleep(500);
    check('护眼模式写入 html 属性', await evaluate(cdp, sid,
      `document.documentElement.getAttribute('data-eyecare') === '1'`) === true);
    await capture(cdp, sid, 'e56-03-eyecare');
    await click(cdp, sid, 'eye-care-switch');
    await sleep(400);
    check('护眼模式可关闭', await evaluate(cdp, sid,
      `!document.documentElement.hasAttribute('data-eyecare')`) === true);

    await evaluate(cdp, sid, `location.hash = '#/'; true`);
    await sleep(700);
    await click(cdp, sid, 'doc-item');
    await sleep(1100);
    await click(cdp, sid, 'reader-more');
    await sleep(400);
    await click(cdp, sid, 'reader-tts');
    await sleep(1200);
    const ttsState = await evaluate(cdp, sid, `(() => ({
      bar: !!document.querySelector('[data-testid="tts-bar"]'),
      toast: document.querySelector('[data-testid="toast"]')?.textContent ?? '',
    }))()`);
    check('朗读播放条出现或明确提示不支持',
      ttsState.bar === true || ttsState.toast.includes('不支持') || ttsState.toast.includes('朗读'), JSON.stringify(ttsState));
    await capture(cdp, sid, 'e56-04-tts');
    await evaluate(cdp, sid, `(() => {
      const stop = document.querySelector('[data-testid="tts-stop"]');
      if (stop) stop.click();
      return true;
    })()`);
    await sleep(400);

    await click(cdp, sid, 'reader-more');
    await sleep(400);
    await click(cdp, sid, 'reader-export-html');
    await sleep(900);
    check('导出 HTML 有明确提示', await evaluate(cdp, sid,
      `(document.querySelector('[data-testid="toast"]')?.textContent ?? '').includes('HTML')`) === true);
    await click(cdp, sid, 'reader-more');
    await sleep(400);
    check('打印/PDF 入口存在', await evaluate(cdp, sid,
      `!!document.querySelector('[data-testid="reader-print"]')`) === true);
    await evaluate(cdp, sid, `document.querySelector('[data-testid="menu-panel"]')?.remove(); true`);

    const noErrors = await evaluate(cdp, sid, `window.__smokeErrors ? window.__smokeErrors.length : 0`);
    check('页面无未捕获错误', noErrors === 0);
  } finally {
    try { proc.kill(); } catch { /* ignore */ }
    await server.close();
    try { unlinkSync(SAMPLE_MD); } catch { /* ignore */ }
  }

  const failed = checks.filter((c) => !c.ok);
  console.log('');
  if (failed.length > 0) {
    console.error(`✗ 冒烟测试失败：${failed.length}/${checks.length} 项未通过`);
    for (const f of failed) console.error(`  - ${f.name}${f.detail ? `：${f.detail}` : ''}`);
    process.exit(1);
  }
  console.log(`✓ 冒烟测试通过：${checks.length}/${checks.length} 项`);
}

main().catch((error) => {
  console.error('✗ 冒烟测试异常：', error.message);
  process.exit(1);
});
