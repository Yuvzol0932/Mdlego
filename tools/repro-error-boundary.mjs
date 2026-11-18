#!/usr/bin/env node
/**
 * F3 错误边界验收（失败先行）。
 *
 * 跑 vite build 产物，断言：
 *   1. window error / unhandledrejection 被记录并持久化（不打断应用）；
 *   2. 页面渲染抛异常时显示兜底错误页（data-testid="fatal-error"），
 *      可「重试」恢复，且错误写入诊断日志；
 *   3. 设置页能导出诊断日志（JSON 含版本/构建号/错误列表/状态摘要）。
 *
 * 用法：
 *   npm run build
 *   node tools/repro-error-boundary.mjs --out=before   # 修前：应失败
 *   node tools/repro-error-boundary.mjs --out=after    # 修后：应全过
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = (process.argv.find((a) => a.startsWith('--out=')) ?? '--out=after').slice(6);
const SHOTS = join(ROOT, 'docs', 'screenshots', 'error-boundary', OUT);
const PREVIEW_PORT = 4176;
const CDP_PORT = 9455;
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`CDP 超时 ${method}`)); } }, 30000);
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
const click = async (testid) => {
  const c = await evalJs(`(() => {
    const el = document.querySelector('[data-testid="${testid}"]');
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, visible: r.bottom > 0 && r.top < innerHeight };
  })()`);
  if (c === null) throw new Error(`找不到 ${testid}`);
  await sleep(180);
  // 滚动后坐标会变，重新量一次
  const again = await evalJs(`(() => {
    const el = document.querySelector('[data-testid="${testid}"]');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await tap(again.x, again.y);
};
const exists = async (testid) => evalJs(`!!document.querySelector('[data-testid="${testid}"]')`);
const shotAt = async (name) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
};

async function main() {
  if (CHROME === undefined) throw new Error('找不到 Chrome');
  const preview = spawn(process.execPath, [
    join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview',
    '--port', String(PREVIEW_PORT), '--strictPort', '--host', '127.0.0.1',
  ], { cwd: ROOT, stdio: 'ignore' });
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${CDP_PORT}`, '--headless=new', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--overscroll-history-navigation=0',
    `--user-data-dir=${join(ROOT, 'artifacts', '.chrome-error-profile')}`, 'about:blank',
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, screenWidth: VIEWPORT.width, screenHeight: VIEWPORT.height }, sid);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sid);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PREVIEW_PORT}/` }, sid);
    await sleep(1800);
    await evalJs(`(() => { localStorage.clear(); return new Promise((res) => { const r = indexedDB.deleteDatabase('mdlego'); r.onsuccess = r.onerror = r.onblocked = () => res(true); }); })()`);
    await cdp.send('Page.reload', {}, sid);
    await sleep(2000);

    const version = await evalJs(`document.querySelector('[data-testid="build-version"]')?.textContent ?? null`);
    check('应用已启动', (await exists('tabbar')) === true, `版本 ${version}`);

    // ── 1. 全局错误采集（不打断应用） ──
    await evalJs(`(() => {
      window.dispatchEvent(new ErrorEvent('error', {
        message: '注入的 window 错误', filename: 'inject.js', lineno: 7, colno: 3,
        error: new Error('注入的 window 错误'),
      }));
      window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', {
        promise: Promise.resolve(),
        reason: new Error('注入的未处理 rejection'),
      }));
      return true;
    })()`);
    await sleep(500);
    const logAfterGlobal = await evalJs(`(() => {
      try { return JSON.parse(localStorage.getItem('mdlego.diagnostics.v1') ?? '[]'); } catch { return null; }
    })()`);
    check('全局错误写入诊断日志（localStorage 持久化）', Array.isArray(logAfterGlobal) && logAfterGlobal.length >= 2,
      Array.isArray(logAfterGlobal) ? `${logAfterGlobal.length} 条` : String(logAfterGlobal));
    const globalText = JSON.stringify(logAfterGlobal ?? []);
    check('日志记录了 error 与 unhandledrejection', globalText.includes('注入的 window 错误') && globalText.includes('注入的未处理 rejection'));
    check('全局错误不打断应用（仍停留在书架）', (await exists('tabbar')) === true && (await exists('fatal-error')) === false);
    await shotAt('01-global-error-logged');

    // ── 2. 渲染异常 → 兜底错误页 + 重试恢复 ──
    await click('tab-settings');
    await sleep(600);
    check('进入设置页', (await exists('settings-panel')) === true);
    // 注入：书架视图重绘时抛异常（模拟渲染期异常）
    await evalJs(`(() => {
      window.__origReplaceChildren = Element.prototype.replaceChildren;
      Element.prototype.replaceChildren = function (...args) {
        if (this.getAttribute && this.getAttribute('data-testid') === 'shelf') {
          throw new Error('注入的渲染异常');
        }
        return window.__origReplaceChildren.apply(this, args);
      };
      return true;
    })()`);
    await click('tab-shelf');
    await sleep(700);
    const fatal = await evalJs(`(() => {
      const el = document.querySelector('[data-testid="fatal-error"]');
      return el ? { text: el.textContent.slice(0, 80), retry: !!el.querySelector('[data-testid="fatal-retry"]'), home: !!el.querySelector('[data-testid="fatal-home"]') } : null;
    })()`);
    check('渲染异常显示兜底错误页', fatal !== null, fatal ? fatal.text : '没有 fatal-error');
    check('错误页提供重试与回书架', fatal !== null && fatal.retry === true && fatal.home === true);
    const logAfterRender = await evalJs(`(() => {
      try { return JSON.parse(localStorage.getItem('mdlego.diagnostics.v1') ?? '[]'); } catch { return null; }
    })()`);
    check('渲染异常写入诊断日志', Array.isArray(logAfterRender) && JSON.stringify(logAfterRender).includes('注入的渲染异常'),
      Array.isArray(logAfterRender) ? `${logAfterRender.length} 条` : String(logAfterRender));
    await shotAt('02-fatal-fallback');

    // 恢复注入 → 点重试
    await evalJs(`(() => { Element.prototype.replaceChildren = window.__origReplaceChildren; return true; })()`);
    await click('fatal-retry');
    await sleep(900);
    const recovered = await evalJs(`(() => {
      const page = document.querySelector('[data-testid="shell"]');
      const body = document.querySelector('[data-testid="shelf"]');
      return {
        fatal: !!document.querySelector('[data-testid="fatal-error"]'),
        shelfPage: !!page && (page.className ?? '').includes('shelf-page'),
        shelfContent: body ? body.children.length : -1,
        emptyText: (body?.textContent ?? '').includes('书架空着') || (body?.textContent ?? '').includes('导入文档'),
      };
    })()`);
    check('点重试后恢复正常页面', recovered.fatal === false && recovered.shelfPage === true && recovered.shelfContent > 0,
      JSON.stringify(recovered));
    console.log('    重试后 DOM：' + JSON.stringify(await evalJs(`(() => {
      const app = document.querySelector('#app');
      const body = document.querySelector('[data-testid="shelf"]');
      return {
        appKids: app ? [...app.children].map((e) => String(e.className || e.tagName)) : null,
        shelfKids: body ? body.children.length : -1,
        bodyText: document.body.innerText.slice(0, 60),
      };
    })()`)));
    await shotAt('03-recovered');

    // ── 3. 诊断日志导出 ──
    await click('tab-settings');
    await sleep(600);
    check('设置页有诊断导出入口', (await exists('diagnostics-export')) === true);
    await evalJs(`(() => {
      window.__clip = null;
      const write = (text) => { window.__clip = text; return Promise.resolve(); };
      try {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write, readText: () => Promise.resolve('') } });
      } catch {
        navigator.clipboard.writeText = write;
      }
      // 浏览器下载在 headless 里拿不到文件，这里同时拦截 Blob 链接点击
      window.__downloads = [];
      const createUrl = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { window.__downloads.push(blob); return createUrl(blob); };
      return true;
    })()`);
    await click('diagnostics-export');
    await sleep(900);
    console.log('    导出后：' + JSON.stringify(await evalJs(`({
      clip: window.__clip ?? null,
      downloads: (window.__downloads ?? []).length,
      toast: document.querySelector('.toast, [data-testid="toast"]')?.textContent ?? null,
      lastDiag: (() => { try { const a = JSON.parse(localStorage.getItem('mdlego.diagnostics.v1') ?? '[]'); return a.slice(-2).map((e) => e.message.slice(0, 60)); } catch { return null; } })(),
      settings: !!document.querySelector('[data-testid="settings-panel"]'),
    })`)));
    const exported = await evalJs(`(() => {
      const text = window.__clip;
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      return { hasText: typeof text === 'string', parsed };
    })()`);
    const report = exported.parsed;
    check('诊断导出生成 JSON', exported.hasText === true && report !== null, exported.hasText ? '已生成' : '没有输出');
    check('导出内容含版本与构建号', report !== null && typeof report.appVersion === 'string' && typeof report.buildId === 'string',
      report ? `${report.appVersion} / ${report.buildId}` : '');
    check('导出内容含错误列表', report !== null && Array.isArray(report.errors) && report.errors.length >= 3 && JSON.stringify(report.errors).includes('注入的渲染异常'),
      report ? `${report.errors?.length} 条` : '');
    check('导出内容含状态摘要', report !== null && report.state !== null && typeof report.state === 'object', report ? Object.keys(report.state ?? {}).join(',') : '');
    await shotAt('04-diagnostics-export');
    if (report !== null) writeFileSync(join(SHOTS, 'diagnostics-sample.json'), JSON.stringify(report, null, 2));

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
