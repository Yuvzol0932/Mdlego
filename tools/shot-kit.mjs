#!/usr/bin/env node
/**
 * 阶段 B 验收截图：构建 kit 版（--mode kit，带 #/kit 展示页）→ 真实 Chrome 逐主题截图，
 * 并断言材质档位与玻璃层数：
 *   · 玻璃档：有 backdrop-filter，且 ≤ 3 层
 *   · 柔和半透明 / 纯色档：页面上没有任何 backdrop-filter
 *
 * 截图写到 docs/screenshots/B/。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { serveStatic } from './serve.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT_DIR = join(ROOT, 'www-kit');
const SHOTS = join(ROOT, 'docs', 'screenshots', 'B');
const CDP_PORT = 9334;
const VIEWPORT = { width: 393, height: 873, deviceScaleFactor: 2, mobile: true };

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
];

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

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const chrome = CHROME_CANDIDATES.find((p) => p && existsSync(p));
  if (chrome === undefined) {
    console.error('✗ 未找到 Chrome');
    process.exit(1);
  }

  console.log('构建 kit 版…');
  execFileSync('npx', ['vite', 'build', '--mode', 'kit', '--outDir', OUT_DIR, '--emptyOutDir'], {
    cwd: ROOT, stdio: 'ignore', shell: true,
  });
  mkdirSync(SHOTS, { recursive: true });

  const server = await serveStatic(OUT_DIR);
  const proc = spawn(chrome, [
    `--remote-debugging-port=${CDP_PORT}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--user-data-dir=' + join(ROOT, 'artifacts', '.chrome-kit'), 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let wsUrl = null;
    for (let i = 0; i < 60 && wsUrl === null; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
        if (res.ok) wsUrl = (await res.json()).webSocketDebuggerUrl;
      } catch { /* 未就绪 */ }
      if (wsUrl === null) await sleep(250);
    }
    if (wsUrl === null) throw new Error('Chrome 调试端口未就绪');
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });
    const cdp = new Cdp(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Runtime.enable', {}, sid);
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, screenWidth: VIEWPORT.width, screenHeight: VIEWPORT.height }, sid);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sid);

    const pageErrors = [];
    cdp.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description ?? ''));
    });

    const ev = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
      if (r.exceptionDetails) throw new Error(`页面脚本出错：${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description ?? '')}`);
      return r.result.value;
    };
    const click = async (testId) => {
      const ok = await ev(`(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.click(); return true; })()`);
      if (!ok) throw new Error(`找不到 ${testId}`);
      await sleep(350);
    };
    const shot = async (name, full = true) => {
      let clip;
      if (full) {
        const m = await cdp.send('Page.getLayoutMetrics', {}, sid);
        clip = { x: 0, y: 0, width: VIEWPORT.width, height: Math.ceil(m.cssContentSize?.height ?? m.contentSize.height), scale: 1 };
      }
      const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, ...(clip ? { clip } : {}) }, sid);
      writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
    };
    const attr = (name) => ev(`document.documentElement.getAttribute('${name}')`);
    const glassCount = () => ev(`(() => { let n = 0; for (const e of document.querySelectorAll('*')) { const v = getComputedStyle(e).backdropFilter; if (v && v !== 'none') n++; } return n; })()`);

    // 干净起点，直接用 #/kit 深链进入
    await cdp.send('Page.navigate', { url: server.url + '#/kit' }, sid);
    await sleep(900);
    await ev(`localStorage.clear(); true`);
    await cdp.send('Page.navigate', { url: server.url + '#/kit' }, sid);
    await sleep(1200);

    console.log('\n【kit 页可见】');
    check('#/kit 深链进入展示页', (await ev(`!!document.querySelector('[data-testid="kit"]')`)) === true);

    console.log('\n【各主题截图】');
    const themes = ['warm-night', 'warm-paper', 'forest', 'slate', 'magazine', 'night', 'paper'];
    for (const t of themes) {
      await click(`kit-theme-${t}`);
      await sleep(250);
      check(`${t}：data-theme 生效`, (await attr('data-theme')) === t);
      await shot(`kit-${t}`);
    }

    console.log('\n【强调色】');
    await click('kit-theme-warm-night');
    const accentBefore = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
    await click('accent-jade');
    const accentAfter = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
    check('选青玉后 --accent 变了', accentBefore !== accentAfter, `${accentBefore} → ${accentAfter}`);
    check('data-accent=jade', (await attr('data-accent')) === 'jade');
    await shot('kit-warm-night-jade');
    await click('accent-theme');
    check('选「跟随主题」后移除 data-accent', (await attr('data-accent')) === null);

    console.log('\n【材质档位 · 玻璃层数】');
    await click('kit-theme-warm-night');
    await click('kit-material-glass');
    await sleep(300);
    const nGlass = await glassCount();
    check('玻璃档：有 backdrop-filter', nGlass > 0, `${nGlass} 层`);
    check('玻璃档：同屏 ≤ 3 层', nGlass <= 3, `${nGlass} 层`);
    await shot('kit-warm-night-material-glass');

    await click('kit-material-soft');
    await sleep(300);
    check('柔和半透明档：无 backdrop-filter', (await glassCount()) === 0);
    await shot('kit-warm-night-material-soft');

    await click('kit-material-solid');
    await sleep(300);
    check('纯色档：无 backdrop-filter', (await glassCount()) === 0);
    const solidBg = await ev(`getComputedStyle(document.querySelector('[data-testid="kit-glass-nav"]')).backgroundColor`);
    check('纯色档：悬浮件背景不透明', !/rgba\(.*,\s*0?\.\d+\)$/.test(solidBg) && !solidBg.includes('/'), solidBg);
    await shot('kit-warm-night-material-solid');

    console.log('\n【动效档】');
    await click('kit-motion-off');
    const motionAttr = await attr('data-motion');
    const durPage = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--dur-page').trim()`);
    check('动效关：data-motion=off 且 --dur-page 为 0ms', motionAttr === 'off' && (durPage === '0ms' || durPage === '0s'), `attr=${motionAttr} dur=${durPage}`);
    await click('kit-motion-full');

    console.log('\n【设置页外观区（即时预览）】');
    for (const t of ['warm-night', 'warm-paper']) {
      await cdp.send('Page.navigate', { url: server.url + '#/settings' }, sid);
      await sleep(500);
      await cdp.send('Page.reload', {}, sid);
      await sleep(1000);
      await click(`theme-${t}`);
      check(`设置页点「${t}」立刻生效`, (await attr('data-theme')) === t);
      await shot(`settings-${t}`, false);
    }
    check('页面无未捕获错误', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  } finally {
    proc.kill();
    await server.close();
  }

  if (failed > 0) {
    console.error(`\n✗ ${failed} 项失败`);
    process.exit(1);
  }
  console.log('\n✓ 阶段 B 截图与断言通过');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
