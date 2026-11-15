#!/usr/bin/env node
/**
 * 真实 Chrome 冒烟测试 —— M2 完整链路。
 *
 * 用 Chrome DevTools Protocol 在真实浏览器里跑真应用，
 * 以小米 14 Pro 的逻辑尺寸 + DPR 3 + 触摸模拟渲染，并截图留档。
 *
 * 不用 Playwright（零额外依赖）：Node 24 原生 WebSocket 直连 CDP。
 *
 * M2 的链路：
 *   空书架 → 通过真实 <input type=file> 导入 .md → 书卡片出现
 *   → 打开 → 正文渲染 → 目录 → 搜索 → 返回书架 → 设置页
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
  if (result.exceptionDetails) throw new Error(`页面脚本出错：${result.exceptionDetails.text}`);
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

    const topbar = await evaluate(cdp, sid, `(() => {
      const bar = document.querySelector('.appbar');
      if (!bar) return null;
      const links = bar.querySelectorAll('a, button');
      return { count: links.length, hasText: [...links].some(n => (n.textContent ?? '').trim().length > 0),
               hasSvg: !!bar.querySelector('svg.icon'), hasAria: !!bar.querySelector('[aria-label]') };
    })()`);
    check('顶栏只有一个操作入口', topbar !== null && topbar.count === 1, `入口数 ${topbar?.count}`);
    check('入口是图标而非文字', topbar !== null && topbar.hasSvg && !topbar.hasText);
    check('图标按钮有无障碍标签', topbar !== null && topbar.hasAria);
    check('导入 FAB 存在', await evaluate(cdp, sid, `!!document.querySelector('[data-testid="import-file"]')`) === true);

    await capture(cdp, sid, 'm2-01-empty-shelf');

    // ── 真实文件导入（通过 <input type=file> + CDP setFileInputFiles） ──
    console.log('\n【导入真实 .md 文件】');

    // 真实链路：点 FAB → 应用创建 <input type=file> 并 click()
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

    const cardTitle = await evaluate(cdp, sid, `document.querySelector('.doc-item__title')?.textContent ?? ''`);
    check('卡片标题从 Markdown 推断', cardTitle.includes('spect'), cardTitle);

    await capture(cdp, sid, 'm2-02-shelf');

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

    const tableWrap = await evaluate(cdp, sid,
      `!!document.querySelector('.article .table-wrap table')`);
    check('表格由滚动容器包裹', tableWrap === true);
    check('代码块可横向滚动',
      await evaluate(cdp, sid, `getComputedStyle(document.querySelector('.article pre')).overflowX`) === 'auto');
    check('原文 HTML 未执行',
      await evaluate(cdp, sid, `document.querySelectorAll('.article script, .article iframe').length`) === 0);
    check('阅读工具栏存在', await evaluate(cdp, sid, `!!document.querySelector('[data-testid="reader-bar"]')`) === true);

    await capture(cdp, sid, 'm2-03-reader');

    // ── 目录 ──
    console.log('\n【目录】');
    const tocOpened = await click(cdp, sid, 'open-toc');
    check('目录抽屉能打开', tocOpened === true);
    const tocCount = await evaluate(cdp, sid, `document.querySelectorAll('[data-testid="toc-item"]').length`);
    check('目录列出标题', tocCount >= 3, `${tocCount} 项`);
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
    await capture(cdp, sid, 'm2-05-search');
    await click(cdp, sid, 'search-close');

    // ── 返回书架 & 设置 ──
    console.log('\n【返回与设置】');
    await click(cdp, sid, 'back-to-shelf');
    await sleep(400);
    check('返回书架', await evaluate(cdp, sid, `!!document.querySelector('[data-testid="shelf"]')`) === true);

    await evaluate(cdp, sid, `location.hash = '#/settings'; true`);
    await sleep(700);
    const version = await evaluate(cdp, sid, `document.querySelector('[data-testid="build-version"]')?.textContent ?? ''`);
    check('设置页显示版本号', /^\d+\.\d+\.\d+$/.test(version), version);
    const buildId = await evaluate(cdp, sid, `document.querySelector('[data-testid="build-id"]')?.textContent ?? ''`);
    check('设置页显示构建指纹', buildId.length > 5, buildId);
    await capture(cdp, sid, 'm2-06-settings');

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
