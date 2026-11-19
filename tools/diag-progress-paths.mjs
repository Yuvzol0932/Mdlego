#!/usr/bin/env node
/**
 * 进度记忆失效排查：覆盖**所有**退出阅读页的路径。
 *
 * 用户报：「退出书籍再返回，不会同步回观看时停留的状态」。
 * 程序化验收（tools/repro-lazy-firstscreen.mjs）显示主路径能精准恢复，
 * 所以必须逐条路径验证，找出哪一条漏了 persistProgress。
 *
 * 每条路径测三步：
 *   1. 滚到某处 → 读「视觉锚点」（顶栏下沿第一块的 bid + 相对偏移）
 *   2. 用该路径退出
 *   3. 重新打开 → 读锚点，比对
 * 同时从 IndexedDB 读出实际落库的 progress，判断是「没存」还是「存了但恢复错」。
 *
 * 用法：node tools/diag-progress-paths.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'perf', '1.2.1', 'evidence');
const SERIAL = process.env.MDLEGO_SERIAL ?? '518d68b2';
const PKG = 'cn.mdlego.reader';
const PORT = 9281;

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

/** 读「视觉锚点」：顶栏下沿第一个可见块。 */
const anchor = () => ev(`(() => {
  const art = document.querySelector('[data-testid="article"]');
  if (!art) return null;
  const shell = document.querySelector('[data-testid="shell"]');
  for (const b of art.querySelectorAll('[data-bid]')) {
    const r = b.getBoundingClientRect();
    if (r.bottom > 0) {
      return {
        bid: b.getAttribute('data-bid'),
        top: Math.round(r.top),
        bars: shell?.getAttribute('data-bars'),
        scrollY: Math.round(scrollY),
        blocks: art.querySelectorAll('[data-bid]').length,
        complete: shell?.getAttribute('data-article') ?? null,
      };
    }
  }
  return null;
})()`);

/** 从 IndexedDB 读落库的 progress。 */
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
  return d ? { id: d.id, title: d.title, progress: d.progress ?? null } : null;
})()`);

const isOnShelf = () => ev(`!!document.querySelector('[data-testid="shelf-grid"]')`);
const inReader = () => ev(`!!document.querySelector('[data-testid="article"]')`);

/** 滚到文档某个比例处并等稳定。 */
async function scrollToFraction(f) {
  await ev(`scrollTo(0, Math.round((document.documentElement.scrollHeight - window.innerHeight) * ${f}))`);
  await sleep(900);
}

/** 从书架打开当前文档（第一张卡）。 */
async function openDoc() {
  const ok = await ev(`(() => {
    const c = document.querySelector('[data-testid="shelf-grid"] [data-doc-id]');
    if (!c) return false;
    window.__curDocId = c.getAttribute('data-doc-id');
    c.click();
    return true;
  })()`);
  if (!ok) return false;
  await sleep(2600);
  // 等转场结束
  for (let i = 0; i < 20; i += 1) {
    if (await ev(`document.querySelectorAll('[data-testid="page-mask"]').length === 0`)) break;
    await sleep(150);
  }
  await sleep(400);
  return true;
}

/**
 * 一条退出路径的完整验证。
 * @param label 路径名
 * @param exitFn 执行退出的 JS 表达式
 */
async function testPath(label, exitFn, report) {
  console.log(`\n=== ${label} ===`);
  // 确保在书架
  if (!(await isOnShelf())) {
    await ev(`location.hash='#/'`);
    await sleep(1200);
  }
  if (!(await openDoc())) {
    console.log('  跳过：书架无文档');
    return;
  }
  await scrollToFraction(0.45);
  const before = await anchor();
  const beforeSaved = await savedProgress();
  console.log(`  滚到中段：锚点 ${before?.bid}@${before?.top}px  scrollY=${before?.scrollY} blocks=${before?.blocks}`);
  console.log(`  退出前落库：${JSON.stringify(beforeSaved?.progress)}`);

  // 执行退出
  await ev(exitFn);
  await sleep(1500);
  const afterExit = {
    onShelf: await isOnShelf(),
    inReader: await inReader(),
    saved: await savedProgress(),
  };
  console.log(`  退出后：onShelf=${afterExit.onShelf} inReader=${afterExit.inReader}`);
  console.log(`  退出后落库：${JSON.stringify(afterExit.saved?.progress)}`);

  // 重新打开
  if (!(await openDoc())) {
    console.log('  ✗ 重新打开失败');
    report.push({ label, ok: false, reason: 'reopen-failed', before, afterExit });
    return;
  }
  const after = await anchor();
  const drift = after !== null && before !== null ? Math.abs(after.top - before.top) : null;
  const sameBid = after !== null && before !== null && after.bid === before.bid;
  const savedOk = afterExit.saved?.progress?.bid === before?.bid;
  console.log(`  重开锚点：${after?.bid}@${after?.top}px  scrollY=${after?.scrollY} blocks=${after?.blocks}`);
  console.log(`  判定：同块=${sameBid} 漂移=${drift}px 落库bid匹配=${savedOk}`);

  report.push({
    label,
    ok: sameBid && drift !== null && drift <= 80,
    before, after, afterExit, drift, sameBid, savedOk,
  });

  // 回书架准备下一条路径
  await ev(`location.hash='#/'`);
  await sleep(1400);
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

  const report = [];
  try {
    await ev(`location.hash='#/'`);
    await sleep(800);

    // 路径 1：阅读页顶栏返回键（界面内返回）
    await testPath(
      '路径1 顶栏返回键 back-to-shelf',
      `(document.querySelector('[data-testid="back-to-shelf"]') ?? { click() {} }).click()`,
      report,
    );

    // 路径 2：系统返回键（handleSystemBack → nav/back）
    await testPath(
      '路径2 系统返回键（dispatch nav/back）',
      `(() => {
        history.back();
        return true;
      })()`,
      report,
    );

    // 路径 3：hash 直接切回书架
    await testPath(
      '路径3 location.hash = "#/"',
      `(() => { location.hash = '#/'; return true; })()`,
      report,
    );

    // 路径 4：切到设置 tab（nav/tab → 离开阅读页）
    await testPath(
      '路径4 切到设置 tab',
      `(() => { location.hash = '#/settings'; return true; })()`,
      report,
    );

    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'progress-paths.json'), JSON.stringify(report, null, 1), 'utf8');

    console.log('\n=== 汇总 ===');
    for (const r of report) {
      console.log(`  ${r.ok ? '✓' : '✗'} ${r.label}  漂移=${r.drift}px 同块=${r.sameBid} 落库=${r.savedOk}`);
    }
    console.log('证据：', join(OUT, 'progress-paths.json'));
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    try { adb('forward', '--remove', `tcp:${PORT}`); } catch { /* ignore */ }
  }
}

await main();
