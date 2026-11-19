#!/usr/bin/env node
/**
 * #C 定位：首帧 43ms 到底花在哪。
 *
 * 用 CDP `Performance.getMetrics` + 页面内 performance.mark/measure
 * 把「点击 → 遮罩出现」切成若干段：
 *   - click handler 同步耗时（渲染 + 挂载 + 锚定）
 *   - 下一帧的样式/布局耗时
 *
 * 用法：node tools/perf-profile-firstframe.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const OUT_DIR = join(ROOT, 'docs', 'perf', '1.2.1');
const SERIAL = process.env.MDLEGO_SERIAL ?? '518d68b2';
const PKG = 'cn.mdlego.reader';
const PORT = 9245;

const ADB = [
  'D:\\Workbuddyspace\\.android-sdk\\platform-tools\\adb.exe',
  process.env.LOCALAPPDATA + '\\Android\\Sdk\\platform-tools\\adb.exe',
  'adb',
].find((p) => p === 'adb' || (p && existsSync(p)));
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout ' + method)); } }, 30000);
    });
  }
}

let cdp;
const ev = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
};

async function main() {
  adb('shell', 'svc', 'power', 'stayon', 'true');
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  adb('shell', 'am', 'force-stop', PKG);
  await sleep(800);
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
  await sleep(3000);
  const pid = adb('shell', 'pidof', PKG).trim();
  adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
  await sleep(700);
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws')), { once: true }); });
  cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Performance.enable');

  const result = {};
  try {
    await ev(`location.hash='#/'`);
    await sleep(700);
    if (!(await ev(`!!document.querySelector('[data-testid="article"]')`))) {
      await ev(`(() => { const c = document.querySelector('[data-testid="shelf-grid"] [data-doc-id]'); if (c) c.click(); return true; })()`);
      await sleep(2500);
    }
    await ev(`scrollTo(0, Math.round(document.documentElement.scrollHeight * 0.5))`);
    await sleep(900);
    await ev(`(document.querySelector('[data-testid="back-to-shelf"]') ?? {click(){}}).click()`);
    await sleep(1500);

    // 量「点击 handler 内同步耗时」：包一层 click，记录调用前后的 performance.now()
    const probe = await ev(`(() => {
      const card = document.querySelector('[data-testid="shelf-grid"] [data-doc-id]');
      if (!card) return null;
      // 直接同步调用 click 并计时 —— 这段就是「点击后主线程被占用的时间」
      const t0 = performance.now();
      card.click();
      const t1 = performance.now();
      return { syncMs: Math.round((t1 - t0) * 10) / 10 };
    })()`);
    result.syncClick = probe;

    // 等转场结束
    await sleep(1500);

    // 量「强制布局 + 读矩形」这类开销：对整篇做一次 getBoundingClientRect
    const layoutCost = await ev(`(() => {
      const art = document.querySelector('[data-testid="article"]');
      if (!art) return null;
      const blocks = art.querySelectorAll('[data-bid]');
      const t0 = performance.now();
      for (const b of blocks) b.getBoundingClientRect();
      return { blocks: blocks.length, readAllRectsMs: Math.round((performance.now() - t0) * 10) / 10 };
    })()`);
    result.layoutCost = layoutCost;

    // 量「写 scrollTop + 强制布局」的开销
    const scrollCost = await ev(`(() => {
      const t0 = performance.now();
      scrollTo(0, scrollY);
      void document.body.offsetHeight;
      return { forceLayoutMs: Math.round((performance.now() - t0) * 10) / 10 };
    })()`);
    result.scrollCost = scrollCost;

    // Performance 指标
    const m = await cdp.send('Performance.getMetrics');
    result.metrics = Object.fromEntries(
      m.metrics.filter((x) => ['LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration'].includes(x.name))
        .map((x) => [x.name, Math.round(x.value * 1000) / 1000]),
    );

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, 'profile-firstframe.json'), JSON.stringify(result, null, 1), 'utf8');
    console.log('\n=== 首帧成本拆解 ===');
    console.log('  点击 handler 同步耗时 :', result.syncClick?.syncMs, 'ms');
    console.log('  读全部块矩形          :', result.layoutCost?.readAllRectsMs, 'ms /', result.layoutCost?.blocks, '块');
    console.log('  写 scrollTop + 强制布局:', result.scrollCost?.forceLayoutMs, 'ms');
    console.log('  累计指标(ms)          :', JSON.stringify(result.metrics));
    console.log('数据：', join(OUT_DIR, 'profile-firstframe.json'));
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    try { adb('forward', '--remove', `tcp:${PORT}`); } catch { /* ignore */ }
  }
}

await main();
