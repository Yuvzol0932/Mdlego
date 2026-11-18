#!/usr/bin/env node
/**
 * F4 性能验收：1.9MB / ~9.6k 块超长文档（BUG-002/003）。
 *
 * 断言（打包产物）：
 *   1. 点击 → 遮罩首帧 < 300ms（BUG-002 目标）；
 *   2. 打开过程无 >100ms 长任务；
 *   3. 正文全部挂载后的 DOM 节点数 ≤ 预算（避免 30k+ 节点拖垮滚动）；
 *   4. 脚本滚动 60 步：帧间隔 p95 < 25ms、max < 80ms；
 *   5. 滚动停止后的进度落库（persistProgress）单次长任务 ≤ 50ms。
 *
 * 用法：node tools/repro-perf-f4.mjs --out=before|after
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = (process.argv.find((a) => a.startsWith('--out=')) ?? '--out=after').slice(6);
const SHOTS = join(ROOT, 'docs', 'screenshots', 'perf-f4', OUT);
const PREVIEW_PORT = 4177;
const CDP_PORT = 9456;
const VIEWPORT = { width: 393, height: 873, deviceScaleFactor: 3, mobile: true };
const SAMPLE = join(ROOT, 'artifacts', '.f4-stress.md');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => p && existsSync(p));

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: ok === true });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** 构造 ~1.9MB / ≈9600 块（段落 5000 + 列表项 3000 + 小标题/代码/引用若干）。 */
function writeStressSample() {
  const parts = ['# F4 压测长文 1.9MB\n'];
  for (let i = 1; i <= 5000; i += 1) {
    parts.push(
      `第 ${i} 段：这是一段用于压测滚动性能的正文，包含中文、English mixed text，以及标点、`
      + '数字 12345 和较长的句子，用来让每个块都有真实排版成本，而不是空标签。'
      + '滚动与进度记录都不应该被 9600 个块拖慢。\n',
    );
    if (i % 2 === 1) parts.push(`- 列表项 A${i}\n- 列表项 B${i}\n`);
    if (i % 250 === 0) parts.push(`## 分组 ${i}\n`);
    if (i % 500 === 0) parts.push('```ts\nconst x = 1;\n```\n');
  }
  writeFileSync(SAMPLE, parts.join('\n'), 'utf8');
}

async function waitUrl(url, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try { if ((await fetch(url)).ok) return true; } catch { /* 未就绪 */ }
    await sleep(250);
  }
  return false;
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
      else p.resolve(m.result);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej, method });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`CDP 超时 ${method}`)); } }, 60000);
    });
  }
}

let cdp;
let sid;
const evalJs = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
};
const tap = async (x, y) => {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }] }, sid);
  await sleep(16);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sid);
};
const centerOf = async (selector) => evalJs(`(() => {
  const e = document.querySelector(${JSON.stringify(selector)});
  if (!e) return null;
  e.scrollIntoView({ block: 'center' });
  const r = e.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
const shotAt = async (name) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
};

async function importSample() {
  await tap(...Object.values(await centerOf('[data-testid="import-file"]')));
  await sleep(400);
  if ((await evalJs(`!!document.querySelector('input[type=file]')`)) !== true) {
    await evalJs(`document.querySelector('[data-testid="import-file"]').click()`);
    await sleep(400);
  }
  const { root } = await cdp.send('DOM.getDocument', {}, sid);
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' }, sid);
  if (!nodeId) throw new Error('应用未创建文件输入框');
  await cdp.send('DOM.setFileInputFiles', { files: [SAMPLE], nodeId }, sid);
  await sleep(6000);
}

/** 脚本滚动 60 步并记录 rAF 帧间隔。 */
const SCROLL_PROBE = (async () => {
  window.__scrollFrames = [];
  window.__scrollLong = [];
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__scrollLong.push(Math.round(e.duration)); })
      .observe({ type: 'longtask', buffered: false });
  } catch { /* ignore */ }
  const step = Math.round(innerHeight * 0.4);
  let last = performance.now();
  for (let i = 0; i < 60; i += 1) {
    scrollBy(0, step);
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now();
    window.__scrollFrames.push(Math.round((now - last) * 10) / 10);
    last = now;
  }
  // 等进度落库的 debounce（400ms）跑完
  await new Promise((r) => setTimeout(r, 700));
  window.__scrollFrames.sort((a, b) => a - b);
  return {
    frames: window.__scrollFrames.length,
    p50: window.__scrollFrames[Math.floor(window.__scrollFrames.length * 0.5)],
    p95: window.__scrollFrames[Math.floor(window.__scrollFrames.length * 0.95)],
    max: window.__scrollFrames[window.__scrollFrames.length - 1],
    long: window.__scrollLong,
    y: Math.round(scrollY),
  };
});

async function main() {
  if (CHROME === undefined) throw new Error('找不到 Chrome');
  writeStressSample();
  const preview = spawn(process.execPath, [
    join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview',
    '--port', String(PREVIEW_PORT), '--strictPort', '--host', '127.0.0.1',
  ], { cwd: ROOT, stdio: 'ignore' });
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${CDP_PORT}`, '--headless=new', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--overscroll-history-navigation=0',
    `--user-data-dir=${join(ROOT, 'artifacts', '.chrome-f4-profile')}`, 'about:blank',
  ], { stdio: 'ignore' });

  try {
    check('vite preview 就绪', await waitUrl(`http://127.0.0.1:${PREVIEW_PORT}/`) === true);
    await waitUrl(`http://127.0.0.1:${CDP_PORT}/json/version`);
    const wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl;
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });
    cdp = new Cdp(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Runtime.enable', {}, sid);
    await cdp.send('DOM.enable', {}, sid);
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, screenWidth: VIEWPORT.width, screenHeight: VIEWPORT.height }, sid);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sid);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PREVIEW_PORT}/` }, sid);
    await sleep(1800);
    await evalJs(`(() => { localStorage.clear(); return new Promise((res) => { const r = indexedDB.deleteDatabase('mdlego'); r.onsuccess = r.onerror = r.onblocked = () => res(true); }); })()`);
    await cdp.send('Page.reload', {}, sid);
    await sleep(1800);
    await importSample();
    await cdp.send('Page.reload', {}, sid);
    await sleep(2500);

    const card = await centerOf('[data-testid="shelf-grid"] [data-doc-id] .book-card__title');
    check('找到 1.9MB 压测文档', card !== null);

    await evalJs(`(() => {
      window.__tapAt = 0;
      window.__firstMaskAt = null;
      window.__openLong = [];
      try { new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__openLong.push({ d: Math.round(e.duration), t: Math.round(e.startTime - (window.__tapAt || e.startTime)) }); }).observe({ type: 'longtask', buffered: false }); } catch { /* ignore */ }
      document.addEventListener('pointerdown', () => {
        if (window.__tapAt !== 0) return;
        window.__tapAt = performance.now();
        window.__openLong = [];
        const watch = () => {
          if (document.querySelector('[data-testid="page-mask"]') !== null) {
            window.__firstMaskAt = Math.round(performance.now() - window.__tapAt);
            return;
          }
          requestAnimationFrame(watch);
        };
        requestAnimationFrame(watch);
      }, { capture: true, once: true });
      return true;
    })()`);

    await tap(card.x, card.y);
    await sleep(700);
    const openStats = await evalJs(`({ firstMaskAt: window.__firstMaskAt, long: window.__openLong, article: !!document.querySelector('[data-testid="article"]') })`);
    await shotAt('01-open-700ms');
    await sleep(6000);
    const settled = await evalJs(`(() => ({
      blocks: document.querySelectorAll('[data-testid="article"] [data-bid]').length,
      nodes: document.querySelectorAll('[data-testid="article"] *').length,
      totalNodes: document.getElementsByTagName('*').length,
      height: document.documentElement.scrollHeight,
    }))()`);
    check('大文档打开后正文挂载', settled.blocks > 5000, `${settled.blocks} 块 / ${settled.nodes} 节点`);
    check('点击→遮罩首帧 < 300ms（BUG-002）', typeof openStats.firstMaskAt === 'number' && openStats.firstMaskAt < 300, `${openStats.firstMaskAt}ms`);
    check('打开过程无 >100ms 长任务', Array.isArray(openStats.long) && openStats.long.every((e) => e.d <= 100), JSON.stringify(openStats.long));
    check('正文 DOM 节点 ≤ 35000', settled.nodes <= 35000, `${settled.nodes}`);
    await shotAt('02-settled');

    // 滚动性能
    await evalJs(`scrollTo(0, 0)`);
    await sleep(600);
    const scroll = await evalJs(`(${SCROLL_PROBE.toString()})()`);
    check('滚动帧 p95 < 25ms（BUG-003）', typeof scroll.p95 === 'number' && scroll.p95 < 25, `p50=${scroll.p50} p95=${scroll.p95} max=${scroll.max}`);
    check('滚动帧 max < 80ms', typeof scroll.max === 'number' && scroll.max < 80, `max=${scroll.max}`);
    check('滚动期间无 >50ms 长任务', Array.isArray(scroll.long) && scroll.long.every((d) => d <= 50), JSON.stringify(scroll.long));
    await shotAt('03-scroll');

    // 进度落库：再滚一次触发 persistProgress，量长任务
    await evalJs(`(() => { window.__persistLong = []; try { new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__persistLong.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: false }); } catch { /* ignore */ } scrollBy(0, 800); return true; })()`);
    await sleep(1000);
    const persist = await evalJs(`({ long: window.__persistLong, y: Math.round(scrollY) })`);
    check('进度落库无 >50ms 长任务', Array.isArray(persist.long) && persist.long.every((d) => d <= 50), JSON.stringify(persist.long));

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n结果：${checks.length - failed.length}/${checks.length}`);
    console.log(`截图：${SHOTS}`);
    if (failed.length > 0) {
      console.log('失败：\n' + failed.map((f) => `  ✗ ${f.name}`).join('\n'));
      process.exitCode = 1;
    }
  } finally {
    try { cdp?.ws.close(); } catch { /* ignore */ }
    try { preview.kill(); } catch { /* ignore */ }
    try { chrome.kill(); } catch { /* ignore */ }
  }
}

main().catch((error) => {
  check('脚本执行', false, String(error.message).slice(0, 200));
  console.error(error.stack);
  process.exitCode = 1;
});
