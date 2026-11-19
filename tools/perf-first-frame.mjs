#!/usr/bin/env node
/**
 * #C 专项：打开动画的**首帧**长任务与首帧耗时。
 *
 * 为什么单独测首帧：gfxinfo 覆盖整轮操作（打开+返回），会把问题摊薄
 * （实测 janky 0.6%、p95 18.7ms，看起来完全达标）。但任务书说的是
 * 「明显掉帧、卡一帧」—— 那通常是**点击后到动画开始之间**的一次长任务：
 * 首屏同步挂载 64 块 + 同一栈内锚定定位（强制布局读矩形写 scrollTop）。
 *
 * 用法：node tools/perf-first-frame.mjs --label=before
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const OUT_DIR = join(ROOT, 'docs', 'perf', '1.2.1');
const LABEL = (process.argv.find((a) => a.startsWith('--label=')) ?? '--label=before').slice(8);
const SERIAL = process.env.MDLEGO_SERIAL ?? '518d68b2';
const PKG = 'cn.mdlego.reader';
const PORT = 9243;

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

  const report = { label: LABEL, runs: [] };
  try {
    await ev(`location.hash='#/'`);
    await sleep(700);
    // 先打开一次建立进度，之后每轮都是「有进度地重新打开」（最坏情况）
    if (!(await ev(`!!document.querySelector('[data-testid="article"]')`))) {
      await ev(`(() => { const c = document.querySelector('[data-testid="shelf-grid"] [data-doc-id]'); if (c) c.click(); return true; })()`);
      await sleep(2500);
    }
    await ev(`scrollTo(0, Math.round(document.documentElement.scrollHeight * 0.5))`);
    await sleep(900);
    await ev(`(document.querySelector('[data-testid="back-to-shelf"]') ?? {click(){}}).click()`);
    await sleep(1500);

    // 装首帧探针：监听 longtask + 记录「点击 → 遮罩出现」的耗时
    await ev(`(() => {
      window.__ff = { runs: [], longTasks: [] };
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) window.__ff.longTasks.push({ d: Math.round(e.duration), t: Math.round(e.startTime) });
        }).observe({ type: 'longtask', buffered: false });
      } catch {}
      return true;
    })()`);

    const RUNS = Number((process.argv.find((a) => a.startsWith('--runs=')) ?? '--runs=8').slice(7));
    for (let i = 0; i < RUNS; i += 1) {
      // 注意：用 element.click() 触发时**不会**产生 pointerdown，
      // 所以探针不能挂在 pointerdown 上（第一版就踩了这个坑，firstMask 恒为 null）。
      // 这里直接记「调用 click 的时刻」，再从那一帧起逐帧找遮罩。
      await ev(`(() => {
        window.__ff.longTasks = [];
        window.__ff.mark = performance.now();
        window.__ff.firstMask = null;
        const watch = () => {
          if (document.querySelector('[data-testid="page-mask"]') !== null) {
            window.__ff.firstMask = performance.now() - window.__ff.mark;
            window.__ff.blocksAtMask = document.querySelectorAll('[data-testid="article"] [data-bid]').length;
            // 再等正文挂上（同一同步栈内随后发生）：连续两帧里记录第一次非零的块数
            let n = 0;
            const watchBlocks = () => {
              const c = document.querySelectorAll('[data-testid="article"] [data-bid]').length;
              if (c > 0) {
                if (window.__ff.blocksFirstMount === undefined) {
                  window.__ff.blocksFirstMount = c;
                  window.__ff.firstMountAt = Math.round((performance.now() - window.__ff.mark) * 10) / 10;
                }
                return;
              }
              n += 1;
              if (n < 30) requestAnimationFrame(watchBlocks);
            };
            requestAnimationFrame(watchBlocks);
            return;
          }
          if (performance.now() - window.__ff.mark < 2000) requestAnimationFrame(watch);
        };
        requestAnimationFrame(watch);
        return true;
      })()`);
      await ev(`(() => { const c = document.querySelector('[data-testid="shelf-grid"] [data-doc-id]'); if (c) c.click(); return true; })()`);
      await sleep(1400);
      // 关键：要分别量「遮罩出现那一刻的块数」（首屏真实成本）
      // 与「一轮之后的块数」（空闲补齐后的稳态）。
      // 只看后者会把首屏成本掩盖掉 —— 实测首屏 481 块这个数字其实是补齐后的。
      const run = await ev(`({
        firstMask: window.__ff.firstMask === null ? null : Math.round(window.__ff.firstMask * 10) / 10,
        blocksAtMask: window.__ff.blocksAtMask ?? null,
        blocksFirstMount: window.__ff.blocksFirstMount ?? null,
        firstMountAt: window.__ff.firstMountAt ?? null,
        longTasks: window.__ff.longTasks.slice(),
        blocks: document.querySelectorAll('[data-testid="article"] [data-bid]').length,
      })`);
      report.runs.push(run);
      await ev(`(document.querySelector('[data-testid="back-to-shelf"]') ?? {click(){}}).click()`);
      await sleep(1200);
    }

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, `first-frame-${LABEL}.json`), JSON.stringify(report, null, 1), 'utf8');

    // ── 摘要 ──
    const firsts = report.runs.map((r) => r.firstMask).filter((v) => typeof v === 'number');
    const allLong = report.runs.flatMap((r) => r.longTasks.map((t) => t.d));
    firsts.sort((a, b) => a - b);
    console.log(`\n=== #C 首帧（${LABEL}，${report.runs.length} 轮）===`);
    if (firsts.length > 0) {
      console.log(`  首帧（点击→遮罩出现）中位 ${firsts[Math.floor(firsts.length / 2)].toFixed(1)}ms`
        + ` 最慢 ${firsts[firsts.length - 1].toFixed(1)}ms  （红线 <30ms）`);
    }
    console.log(`  长任务（>50ms）：${allLong.length} 个`
      + (allLong.length > 0 ? `  最长 ${Math.max(...allLong)}ms` : ''));
    const blocks = report.runs.map((r) => r.blocks);
    const atMask = report.runs.map((r) => r.blocksAtMask).filter((v) => typeof v === 'number');
    if (atMask.length > 0) {
      console.log(`  遮罩出现时块数：${Math.min(...atMask)} ~ ${Math.max(...atMask)}`);
    }
    const fm = report.runs.map((r) => r.blocksFirstMount).filter((v) => typeof v === 'number');
    if (fm.length > 0) {
      console.log(`  正文首次挂载块数：${Math.min(...fm)} ~ ${Math.max(...fm)}  （首屏真实成本）`);
    }
    const fmAt = report.runs.map((r) => r.firstMountAt).filter((v) => typeof v === 'number');
    if (fmAt.length > 0) {
      fmAt.sort((a, b) => a - b);
      console.log(`  正文首挂时刻：中位 ${fmAt[Math.floor(fmAt.length / 2)].toFixed(1)}ms 最慢 ${fmAt[fmAt.length - 1].toFixed(1)}ms`);
    }
    console.log(`  稳态块数（补齐后）：${blocks[0]} ~ ${Math.max(...blocks)}`);
    console.log('数据：', join(OUT_DIR, `first-frame-${LABEL}.json`));
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    try { adb('forward', '--remove', `tcp:${PORT}`); } catch { /* ignore */ }
  }
}

await main();
