#!/usr/bin/env node
/**
 * 打包产物布局断言（rc.3 B 项）。
 *
 * 只用 `vite build` 的 www 产物 + `vite preview` 服务，不碰开发服务器：
 * 有些 CSS 声明会被打包压缩器丢弃/改写（实测 Lightning CSS 会丢掉独立 translate），
 * 开发模式看不出问题，必须对产物断言。
 *
 * 断言：中间「＋」中心 x 与底部导航条中心 x 相差 < 1px，按压期间同样成立。
 * 用法：npm run build && node tools/verify-built-layout.mjs [--out=before|after]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const WWW = join(ROOT, 'www');
const OUT = (process.argv.find((a) => a.startsWith('--out=')) ?? '--out=after').slice(6);
const SHOTS = join(ROOT, 'docs', 'screenshots', 'transition-rc3', OUT);
const PREVIEW_PORT = 4173;
const CDP_PORT = 9452;
const VIEWPORT = { width: 393, height: 873, deviceScaleFactor: 3, mobile: true };

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

async function waitUrl(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* 未就绪 */ }
    await sleep(250);
  }
  return false;
}

/** 最小 CDP 客户端。 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }
      }, 20000);
    });
  }
}

const cssFiles = readdirSync(join(WWW, 'assets')).filter((f) => f.endsWith('.css'));
if (cssFiles.length === 0) {
  console.error('✗ 未找到 www/assets/*.css，请先 npm run build');
  process.exit(1);
}

const preview = spawn(process.execPath, [
  join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview',
  '--port', String(PREVIEW_PORT), '--strictPort', '--host', '127.0.0.1',
], { cwd: ROOT, stdio: 'ignore' });

const profile = join(ROOT, 'artifacts', '.chrome-built-profile');
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP_PORT}`, '--headless=new', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

let ws;
try {
  const up = await waitUrl(`http://127.0.0.1:${PREVIEW_PORT}/`);
  check('vite preview 提供打包产物', up === true, `www/assets/${cssFiles[0]}`);

  const wsUrl = await waitUrl(`http://127.0.0.1:${CDP_PORT}/json/version`) && (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl;
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
  });
  const cdp = new Cdp(ws);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Runtime.enable', {}, sid);
  await cdp.send('DOM.enable', {}, sid);
  await cdp.send('CSS.enable', {}, sid);
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, screenWidth: VIEWPORT.width, screenHeight: VIEWPORT.height }, sid);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sid);
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PREVIEW_PORT}/` }, sid);
  await sleep(2200);

  const evalJs = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  mkdirSync(SHOTS, { recursive: true });

  const mounted = await evalJs(`!!document.querySelector('[data-testid="tabbar"]')`);
  check('打包产物能挂载应用', mounted === true);

  const idle = await evalJs(`(() => {
    const bar = document.querySelector('[data-testid="tabbar"]');
    const plus = document.querySelector('[data-testid="import-file"]');
    if (!bar || !plus) return null;
    const b = bar.getBoundingClientRect();
    const p = plus.getBoundingClientRect();
    const cs = getComputedStyle(plus);
    return {
      barCx: b.left + b.width / 2,
      plusCx: p.left + p.width / 2,
      plusW: p.width,
      plusH: p.height,
      translate: cs.translate,
      transform: cs.transform,
      plusLeft: p.left,
      barLeft: b.left,
    };
  })()`);
  check('静止时「＋」中心与导航条中心对齐（<1px）',
    idle !== null && Math.abs(idle.plusCx - idle.barCx) < 1,
    idle === null ? '(找不到 tabbar/加号)' : `加号 ${idle.plusCx.toFixed(1)} vs 导航条 ${idle.barCx.toFixed(1)}（Δ${(idle.plusCx - idle.barCx).toFixed(1)}px）`);

  const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  writeFileSync(join(SHOTS, '00-built-plus-idle.png'), Buffer.from(shot1.data, 'base64'));

  const { root } = await cdp.send('DOM.getDocument', {}, sid);
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid="import-file"]' }, sid);
  await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['active'] }, sid);
  await sleep(250);
  const pressed = await evalJs(`(() => {
    const bar = document.querySelector('[data-testid="tabbar"]');
    const plus = document.querySelector('[data-testid="import-file"]');
    const b = bar.getBoundingClientRect();
    const p = plus.getBoundingClientRect();
    return { barCx: b.left + b.width / 2, plusCx: p.left + p.width / 2, plusW: p.width, transform: getComputedStyle(plus).transform };
  })()`);
  await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }, sid);
  check('按压时「＋」中心仍对齐（<1px）',
    Math.abs(pressed.plusCx - pressed.barCx) < 1,
    `加号 ${pressed.plusCx.toFixed(1)} vs 导航条 ${pressed.barCx.toFixed(1)}（Δ${(pressed.plusCx - pressed.barCx).toFixed(1)}px），transform=${pressed.transform}`);
  check('按压缩小到 94%', idle !== null && Math.abs(pressed.plusW / idle.plusW - 0.94) < 0.03,
    `${idle?.plusW.toFixed(1)} → ${pressed.plusW.toFixed(1)}`);

  const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  writeFileSync(join(SHOTS, '00-built-plus-pressed.png'), Buffer.from(shot2.data, 'base64'));

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n产物布局断言：${checks.length - failed.length}/${checks.length}`);
  if (failed.length > 0) process.exitCode = 1;
} catch (error) {
  check('产物布局断言执行', false, String(error.message).slice(0, 200));
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { preview.kill(); } catch { /* ignore */ }
  try { chrome.kill(); } catch { /* ignore */ }
}

