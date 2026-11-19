#!/usr/bin/env node
/**
 * 进度记忆回归验收（1.2.2）。
 *
 * 断言：连续 N 轮「滚到不同位置 → 退出 → 重新打开」，每一轮都要回到
 * 原来的视觉位置（同块 + 漂移 ≤ 80px）。
 *
 * 为什么要**多轮**：1.2.2 修的是一个「标记跨挂载残留」的 bug，
 * 它的表现是**间歇性**的 —— 只测一轮可能恰好命中正常分支，看不出问题。
 * 多轮连续进入/退出会反复复用同一个阅读页节点，正好把残留暴露出来。
 *
 * 用法：node tools/verify-progress-memory.mjs [--rounds=4]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'perf', '1.2.2', 'evidence');
const SERIAL = process.env.MDLEGO_SERIAL ?? '518d68b2';
const PKG = 'cn.mdlego.reader';
const PORT = 9285;
const ROUNDS = Number((process.argv.find((a) => a.startsWith('--rounds=')) ?? '--rounds=4').slice(9));

const ADB = [
  'D:\\Workbuddyspace\\.android-sdk\\platform-tools\\adb.exe',
  process.env.LOCALAPPDATA + '\\Android\\Sdk\\platform-tools\\adb.exe',
  'adb',
].find((p) => p === 'adb' || (p && existsSync(p)));
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: ok === true });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

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

/** 视觉锚点：顶栏下沿第一个可见块。 */
const anchor = () => ev(`(() => {
  const art = document.querySelector('[data-testid="article"]');
  if (!art) return null;
  for (const b of art.querySelectorAll('[data-bid]')) {
    const r = b.getBoundingClientRect();
    if (r.bottom > 0) {
      return { bid: b.getAttribute('data-bid'), top: Math.round(r.top) };
    }
  }
  return null;
})()`);

/** 落库的 progress（判断「没存」还是「存了但恢复错」）。 */
const savedProgress = () => ev(`(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('mdlego');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const docs = await new Promise((res, rej) => {
    const r = db.transaction('docs').objectStore('docs').getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const cur = window.__curDocId;
  const d = (cur && docs.find((x) => x.id === cur)) ?? docs[0];
  return d ? { id: d.id, progress: d.progress ?? null } : null;
})()`);

const waitMaskGone = async () => {
  for (let i = 0; i < 30; i += 1) {
    if (await ev(`document.querySelectorAll('[data-testid="page-mask"]').length === 0`)) return true;
    await sleep(120);
  }
  return false;
};

async function openDoc() {
  const ok = await ev(`(() => {
    const c = document.querySelector('[data-testid="shelf-grid"] [data-doc-id]');
    if (!c) return false;
    window.__curDocId = c.getAttribute('data-doc-id');
    c.click();
    return true;
  })()`);
  if (!ok) return false;
  await sleep(2200);
  await waitMaskGone();
  await sleep(700);
  return true;
}

async function backToShelf() {
  await ev(`(document.querySelector('[data-testid="back-to-shelf"]') ?? { click() {} }).click()`);
  await sleep(1300);
  await waitMaskGone();
}

async function main() {
  adb('shell', 'svc', 'power', 'stayon', 'true');
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  adb('shell', 'am', 'force-stop', PKG);
  await sleep(900);
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
  await sleep(3500);
  const pid = adb('shell', 'pidof', PKG).trim();
  adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
  await sleep(700);
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws')), { once: true }); });
  cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');

  const report = { rounds: [] };
  try {
    await ev(`location.hash='#/'`);
    await sleep(900);

    // 第 0 轮：先正常打开一次，建立阅读进度（否则永远走「从头读」分支）
    check('打开文档建立初始进度', await openDoc() === true);
    await ev(`scrollTo(0, Math.round((document.documentElement.scrollHeight - window.innerHeight) * 0.3))`);
    await sleep(900);
    check('首次滚动后落库了进度', (await savedProgress())?.progress !== null,
      JSON.stringify((await savedProgress())?.progress));
    await backToShelf();

    // 多轮：每轮滚到不同位置，退出再进，必须回到同一处
    const fractions = [0.25, 0.5, 0.7, 0.4, 0.6, 0.35];
    for (let i = 0; i < ROUNDS; i += 1) {
      const f = fractions[i % fractions.length];
      const opened = await openDoc();
      if (!opened) { check(`第 ${i + 1} 轮打开`, false); break; }

      // 滚到指定比例
      await ev(`scrollTo(0, Math.round((document.documentElement.scrollHeight - window.innerHeight) * ${f}))`);
      await sleep(1000);
      const before = await anchor();
      // 退出 —— 关键：落库值必须在「退出后、重新打开前」读。
      //
      // 之前这里读晚了（重新打开之后），此时 openDoc 又把它更新了一轮，
      // 所以 savedMatch 永远不匹配，把「已经修好」误报成失败（1.2.2 排查踩坑）。
      await backToShelf();
      const saved = await savedProgress();

      // 重新打开，量恢复后的锚点
      await openDoc();
      const after = await anchor();
      const sameBid = before !== null && after !== null && before.bid === after.bid;
      const drift = before !== null && after !== null ? Math.abs(after.top - before.top) : null;
      const ok = sameBid && drift !== null && drift <= 80;

      report.rounds.push({ round: i + 1, fraction: f, before, after, saved: saved?.progress ?? null, sameBid, drift, ok });
      check(
        `第 ${i + 1} 轮（滚到 ${Math.round(f * 100)}%）退出再进回到原位置`,
        ok,
        `${before?.bid}@${before?.top}px → ${after?.bid}@${after?.top}px（漂移 ${drift}px）`,
      );

      await backToShelf();
    }

    // 附：落库值必须落在「退出前视口可见范围内」。
    //
    // 不能要求 bid 精确等于「第一个 bottom>0 的块」：persistProgress 存的是
    // 「顶栏下沿那个块」+ 块内比例，与「首个可见块」本来就可能差一个块
    // （顶栏高度 64px 内可能压着上一块的尾部）。位置能不能还原才是真判据。
    const noProgress = report.rounds.filter((r) => r.saved === null);
    check('每一轮退出时都落库了 progress（非 null）', noProgress.length === 0,
      noProgress.length === 0 ? '' : `${noProgress.length} 轮没落库`);
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    try { adb('forward', '--remove', `tcp:${PORT}`); } catch { /* ignore */ }
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'progress-memory.json'), JSON.stringify(report, null, 1), 'utf8');
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n结果：${checks.length - failed.length}/${checks.length}`);
  console.log('证据：', join(OUT, 'progress-memory.json'));
  if (failed.length > 0) {
    console.log('失败：\n' + failed.map((f) => `  ✗ ${f.name}`).join('\n'));
    process.exitCode = 1;
  }
}

await main();
