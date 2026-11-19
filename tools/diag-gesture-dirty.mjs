#!/usr/bin/env node
/**
 * #A 修前取证：预测式返回 start→move→cancel 后，真实页面是否被写脏。
 *
 * 断言（期望在 v1.2.0 上**失败**）：
 *   1. 阅读页根节点的 style 属性在手势前后完全一致
 *   2. 阅读页内 .appbar 的 rect.top 与手势前相差 < 0.5px
 *   3. 手势结束后没有残留 .page-mask*
 *
 * 用法：node tools/diag-gesture-dirty.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'perf', '1.2.1', 'evidence');
const SERIAL = process.env.MDLEGO_SERIAL ?? '518d68b2';
const PKG = 'cn.mdlego.reader';
const PORT = 9231;

const ADB = [
  'D:\\Workbuddyspace\\.android-sdk\\platform-tools\\adb.exe',
  process.env.LOCALAPPDATA + '\\Android\\Sdk\\platform-tools\\adb.exe',
  'adb',
].find((p) => p === 'adb' || (p && existsSync(p)));

const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 }).trim();

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout ' + method)); } }, 20000);
    });
  }
}

let cdp;
const ev = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
};

/** 采样：真实页面是否被写脏。 */
const sample = () => ev(`(() => {
  const shell = document.querySelector('[data-testid="shell"]');
  const reader = document.querySelector('.reader-page');
  const appbar = document.querySelector('[data-testid="app-title"]')?.closest('header') ?? null;
  const article = document.querySelector('[data-testid="article"]');
  return {
    shellStyle: shell ? shell.getAttribute('style') : null,
    readerStyle: reader ? reader.getAttribute('style') : null,
    readerHasTransformStyle: reader ? (reader.getAttribute('style') || '').includes('transform') : false,
    appbarTop: appbar ? Math.round(appbar.getBoundingClientRect().top * 100) / 100 : null,
    articleStyle: article ? article.getAttribute('style') : null,
    masks: document.querySelectorAll('.page-mask').length,
    scrims: document.querySelectorAll('.page-mask-scrim').length,
    hidden: document.querySelectorAll('.is-morph-slot-hidden').length,
    appChildren: document.querySelector('[data-testid="app-root"]')?.children.length ?? -1,
    scrollY: Math.round(scrollY),
  };
})()`);

async function main() {
  adb('shell', 'svc', 'power', 'stayon', 'true');
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
  await sleep(2500);
  const pid = adb('shell', 'pidof', PKG);
  adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
  await sleep(700);
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws')), { once: true }); });
  cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');

  const report = {};
  try {
    // 确保在阅读页
    await ev(`location.hash='#/'`);
    await sleep(600);
    const inReader = await ev(`!!document.querySelector('[data-testid="article"]')`);
    if (!inReader) {
      const ok = await ev(`(() => { const c = document.querySelector('[data-testid="shelf-grid"] [data-doc-id]'); if (!c) return false; c.click(); return true; })()`);
      if (!ok) { console.log('✗ 书架上没有文档，无法进阅读页'); process.exitCode = 1; return; }
      await sleep(2500);
    }
    await sleep(600);

    const before = await sample();
    report.before = before;
    console.log('[手势前] ', JSON.stringify(before));

    // 完整手势序列：start → move ×N → cancel
    await ev(`window.__mdlegoBackGesture('start', 0, 0, 400, 0)`);
    await sleep(150);
    for (const p of [0.2, 0.45, 0.7, 0.9]) {
      await ev(`window.__mdlegoBackGesture('move', ${p}, 0, ${400 + p * 200}, 0)`);
      await sleep(90);
    }
    const during = await sample();
    report.during = during;
    console.log('[手势中] ', JSON.stringify(during));

    await ev(`window.__mdlegoBackGesture('cancel', 0, 0, 400, 0)`);
    await sleep(900);
    const after = await sample();
    report.after = after;
    console.log('[cancel 后]', JSON.stringify(after));

    console.log('\n=== 判定 ===');
    const styleClean = after.readerStyle === before.readerStyle;
    const barClean = after.appbarTop !== null && before.appbarTop !== null
      ? Math.abs(after.appbarTop - before.appbarTop) < 0.5 : null;
    const noMask = after.masks === 0 && after.scrims === 0;
    console.log(`${styleClean ? '✓' : '✗'} 阅读页 style 未被改动  (前 ${JSON.stringify(before.readerStyle)} → 后 ${JSON.stringify(after.readerStyle)})`);
    console.log(`${barClean === null ? '?' : barClean ? '✓' : '✗'} .appbar top 一致  (前 ${before.appbarTop} → 后 ${after.appbarTop}，Δ=${before.appbarTop === null || after.appbarTop === null ? '?' : (after.appbarTop - before.appbarTop).toFixed(2)}px)`);
    console.log(`${noMask ? '✓' : '✗'} 无残留 .page-mask*  (masks=${after.masks} scrims=${after.scrims})`);

    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'A-gesture-dirty.json'), JSON.stringify(report, null, 1), 'utf8');
    console.log('\n证据：', join(OUT, 'A-gesture-dirty.json'));
    if (!styleClean || barClean === false || !noMask) process.exitCode = 1;
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    try { adb('forward', '--remove', `tcp:${PORT}`); } catch { /* ignore */ }
  }
}

await main();
