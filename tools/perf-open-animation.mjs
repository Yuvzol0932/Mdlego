#!/usr/bin/env node
/**
 * #C 真机性能基线：打开动画的帧耗时分布。
 *
 * 数据来源（两条独立通道，互相校验）：
 *   1. `adb shell dumpsys gfxinfo <pkg> reset` → 做一次打开 → `framestats`
 *      解析 janky 帧比例与 90/95/99 分位帧耗时；
 *   2. CDP `Tracing.start`（devtools.timeline + timeline.frame）记录主线程
 *      长任务与每帧耗时。
 *
 * 用法：
 *   node tools/perf-open-animation.mjs --label=before
 *   node tools/perf-open-animation.mjs --label=after
 *
 * 结果写入 docs/perf/1.2.1/<label>.json 并在终端打印摘要。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const OUT_DIR = join(ROOT, 'docs', 'perf', '1.2.1');
const LABEL = (process.argv.find((a) => a.startsWith('--label=')) ?? '--label=before').slice(8);
const ROUNDS = Number((process.argv.find((a) => a.startsWith('--rounds=')) ?? '--rounds=10').slice(9));
const SERIAL = process.env.MDLEGO_SERIAL ?? '518d68b2';
const PKG = 'cn.mdlego.reader';
const PORT = 9241;

const ADB = [
  'D:\\Workbuddyspace\\.android-sdk\\platform-tools\\adb.exe',
  process.env.LOCALAPPDATA + '\\Android\\Sdk\\platform-tools\\adb.exe',
  'adb',
].find((p) => p === 'adb' || (p && existsSync(p)));
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method) { this.events.push(m); return; }
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

/** 解析 `dumpsys gfxinfo framestats` 的 CSV 区段。 */
function parseFramestats(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('---PROFILEDATA---'));
  if (start < 0) return null;
  // 表头在下一行，数据从再下一行开始；遇到第二个 ---PROFILEDATA--- 结束
  let header = null;
  const rows = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.startsWith('---PROFILEDATA---')) break;
    if (line.length === 0) continue;
    if (header === null) { header = line.split(','); continue; }
    const vals = line.split(',').map(Number);
    if (vals.length === header.length) rows.push(vals);
  }
  if (header === null || rows.length === 0) return null;
  const idx = (name) => header.indexOf(name);
  const iFrame = idx('Flags') >= 0 ? idx('Flags') : idx('FrameCompleted');
  const iIntended = idx('IntendedVsync');
  const iCompleted = idx('FrameCompleted');
  const iFlags = idx('Flags');
  if (iIntended < 0 || iCompleted < 0) return null;

  const durations = [];
  let janky = 0;
  for (const r of rows) {
    const ms = (r[iCompleted] - r[iIntended]) / 1e6;
    if (!Number.isFinite(ms) || ms <= 0 || ms > 5000) continue;
    durations.push(ms);
    // bit 0 = FLAGS_FRAME_COMPLETED? 官方建议用 flags & 0x1 判 janky 不可靠，
    // 这里直接用「耗时超过 1.5 个 60Hz 帧预算」作为 janky 判据（保守）
    if (ms > 25) janky += 1;
  }
  void iFrame; void iFlags;
  if (durations.length === 0) return null;
  durations.sort((a, b) => a - b);
  const pct = (p) => durations[Math.min(durations.length - 1, Math.floor(durations.length * p))];
  return {
    frames: durations.length,
    janky,
    jankyRatio: janky / durations.length,
    p50: pct(0.5), p90: pct(0.9), p95: pct(0.95), p99: pct(0.99),
    max: durations[durations.length - 1],
  };
}

/** 从 trace 事件里算主线程长任务与每帧耗时。 */
function analyzeTrace(events) {
  const longTasks = [];
  const frames = [];
  for (const e of events) {
    if (e.method !== 'Tracing.dataCollected') continue;
    for (const v of e.params?.value ?? []) {
      const name = v.name ?? '';
      if (name === 'ThreadControllerImpl::RunTask' || name === 'RunTask') {
        const dur = (v.dur ?? 0) / 1000; // us → ms
        if (dur > 50) longTasks.push({ dur: Math.round(dur), ts: v.ts });
      }
      if (name === 'DrawFrame' || name === 'Graphics.Pipeline' || name === 'PipelineReporter') {
        if (v.ph === 'X' && v.dur) frames.push(v.dur / 1000);
      }
    }
  }
  frames.sort((a, b) => a - b);
  const pct = (p) => (frames.length === 0 ? null : frames[Math.min(frames.length - 1, Math.floor(frames.length * p))]);
  return {
    longTasks: longTasks.slice(0, 20),
    longTaskCount: longTasks.length,
    frameSamples: frames.length,
    frameP50: pct(0.5), frameP95: pct(0.95),
  };
}

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

  const report = { label: LABEL, rounds: ROUNDS, gfxinfo: [], trace: null, inPage: null };
  try {
    await ev(`location.hash='#/'`);
    await sleep(700);
    // 确保有一次打开过的记录（否则「打开动画」不成立）
    if (!(await ev(`!!document.querySelector('[data-testid="article"]')`))) {
      await ev(`(() => { const c = document.querySelector('[data-testid="shelf-grid"] [data-doc-id]'); if (c) c.click(); return true; })()`);
      await sleep(2500);
      await ev(`(document.querySelector('[data-testid="back-to-shelf"]') ?? {click(){}}).click()`);
      await sleep(1200);
    }

    // ── 页面内探针：每次打开记录首帧与长任务 ──
    await ev(`(() => {
      window.__perf = { opens: [], longTasks: [] };
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__perf.longTasks.push({ d: Math.round(e.duration), name: e.name });
        }).observe({ type: 'longtask', buffered: false });
      } catch {}
      return true;
    })()`);

    // ── gfxinfo + trace 逐轮 ──
    const ROUND_MS = 120;
    for (let r = 0; r < ROUNDS; r += 1) {
      adb('shell', 'dumpsys', 'gfxinfo', PKG, 'reset');
      await cdp.send('Tracing.start', {
        categories: 'devtools.timeline,disabled-by-default-devtools.timeline.frame',
        transferMode: 'ReportEvents',
      });
      // 打开
      await ev(`(() => { const c = document.querySelector('[data-testid="shelf-grid"] [data-doc-id]'); if (c) c.click(); return true; })()`);
      await sleep(ROUND_MS * 9);
      // 关闭（回到书架，为下一轮准备）
      await ev(`(document.querySelector('[data-testid="back-to-shelf"]') ?? {click(){}}).click()`);
      await sleep(ROUND_MS * 7);
      const dump = adb('shell', 'dumpsys', 'gfxinfo', PKG, 'framestats');
      const stats = parseFramestats(dump);
      if (stats !== null) report.gfxinfo.push(stats);
      const traceRes = await new Promise((res) => {
        const handler = (e) => {
          const m = JSON.parse(e.data);
          if (m.method === 'Tracing.tracingComplete') { cdp.ws.removeEventListener('message', handler); res(true); }
        };
        cdp.ws.addEventListener('message', handler);
        cdp.send('Tracing.end').catch(() => res(false));
        setTimeout(() => res(false), 8000);
      });
      void traceRes;
    }

    // 收尾：把整段 trace 事件交给分析
    report.trace = analyzeTrace(cdp.events);
    report.inPage = await ev(`({
      opens: window.__perf.opens.length,
      longTasks: window.__perf.longTasks,
    })`);

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, `${LABEL}.json`), JSON.stringify(report, null, 1), 'utf8');

    // ── 摘要 ──
    console.log(`\n=== #C 基线（${LABEL}） ===`);
    if (report.gfxinfo.length > 0) {
      const avg = (k) => report.gfxinfo.reduce((a, g) => a + g[k], 0) / report.gfxinfo.length;
      console.log(`gfxinfo 轮数：${report.gfxinfo.length}`);
      console.log(`  janky 帧比例 : ${(avg('jankyRatio') * 100).toFixed(1)}%   （红线 <5%）`);
      console.log(`  90 分位      : ${avg('p90').toFixed(2)}ms   （红线 <20ms@60Hz）`);
      console.log(`  95 分位      : ${avg('p95').toFixed(2)}ms   （红线 <20ms@60Hz）`);
      console.log(`  99 分位      : ${avg('p99').toFixed(2)}ms`);
      console.log(`  最大帧       : ${Math.max(...report.gfxinfo.map((g) => g.max)).toFixed(2)}ms`);
    } else {
      console.log('gfxinfo：没解析到 framestats（设备可能不支持或输出格式不同）');
    }
    if (report.trace) {
      console.log(`trace：长任务 ${report.trace.longTaskCount} 个，帧样本 ${report.trace.frameSamples}`);
      if (report.trace.frameP95 !== null) console.log(`  帧耗时 95 分位 ${report.trace.frameP95.toFixed(2)}ms`);
    }
    console.log('数据：', join(OUT_DIR, `${LABEL}.json`));
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    try { adb('forward', '--remove', `tcp:${PORT}`); } catch { /* ignore */ }
  }
}

await main();
