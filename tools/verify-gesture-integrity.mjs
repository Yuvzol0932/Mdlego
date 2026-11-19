#!/usr/bin/env node
/**
 * #A 回归：三条手势序列的完整性验收（真机）。
 *
 * 任务书 §6 要求的三条序列：
 *   1. start → move×N → cancel
 *   2. start → cancel → start → commit
 *   3. start → move → （应用切后台再回来，无结束事件）
 *
 * 每条序列结束后断言：
 *   - 阅读页元素没有 style 属性变化
 *   ⑤ #app 子节点数与手势前一致
 *   - 无 .page-mask*
 *   - .appbar 的 getBoundingClientRect().top 与手势前相差 < 0.5px
 *   - scrollTop 不变
 *
 * 用法：node tools/verify-gesture-integrity.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'perf', '1.2.1', 'evidence');
const SERIAL = process.env.MDLEGO_SERIAL ?? '518d68b2';
const PKG = 'cn.mdlego.reader';
const PORT = 9233;

const ADB = [
  'D:\\Workbuddyspace\\.android-sdk\\platform-tools\\adb.exe',
  process.env.LOCALAPPDATA + '\\Android\\Sdk\\platform-tools\\adb.exe',
  'adb',
].find((p) => p === 'adb' || (p && existsSync(p)));
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 }).trim();

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

const sample = () => ev(`(() => {
  const shell = document.querySelector('[data-testid="shell"]');
  const appbar = document.querySelector('[data-testid="app-title"]')?.closest('header') ?? null;
  const article = document.querySelector('[data-testid="article"]');
  return {
    shellStyle: shell ? shell.getAttribute('style') : null,
    appbarTop: appbar ? Math.round(appbar.getBoundingClientRect().top * 100) / 100 : null,
    articleStyle: article ? article.getAttribute('style') : null,
    masks: document.querySelectorAll('.page-mask').length,
    scrims: document.querySelectorAll('.page-mask-scrim').length,
    appChildren: document.querySelector('[data-testid="app-root"]')?.children.length ?? -1,
    scrollY: Math.round(scrollY),
    hiddenClass: shell ? shell.className.includes('is-gesture-hidden') : null,
    inReader: !!article,
    onShelf: !!document.querySelector('[data-testid="shelf-grid"]'),
  };
})()`);

/** 一条序列结束后的统一断言。 */
async function assertClean(before, label) {
  await sleep(700);
  const after = await sample();
  const okStyle = after.shellStyle === before.shellStyle;
  const okBar = after.appbarTop !== null && before.appbarTop !== null
    ? Math.abs(after.appbarTop - before.appbarTop) < 0.5 : false;
  const okMask = after.masks === 0 && after.scrims === 0;
  const okChildren = after.appChildren === before.appChildren;
  const okScroll = after.scrollY === before.scrollY;
  const okHidden = after.hiddenClass === false;

  check(`${label}：阅读页 style 未变`, okStyle, `${JSON.stringify(before.shellStyle)} → ${JSON.stringify(after.shellStyle)}`);
  check(`${label}：.appbar top 相差 < 0.5px`, okBar,
    `Δ=${before.appbarTop === null || after.appbarTop === null ? '?' : (after.appbarTop - before.appbarTop).toFixed(2)}px`);
  check(`${label}：无残留 .page-mask*`, okMask, `masks=${after.masks} scrims=${after.scrims}`);
  check(`${label}：#app 子节点数一致`, okChildren, `${before.appChildren} → ${after.appChildren}`);
  check(`${label}：scrollY 不变`, okScroll, `${before.scrollY} → ${after.scrollY}`);
  check(`${label}：无残留隐藏类`, okHidden, `hiddenClass=${after.hiddenClass}`);
  return after;
}

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
    if (!(await ev(`!!document.querySelector('[data-testid="article"]')`))) {
      await ev(`(() => { const c = document.querySelector('[data-testid="shelf-grid"] [data-doc-id]'); if (c) c.click(); return true; })()`);
      await sleep(2500);
    }
    // 滚到中段，让 scrollY 非零（更容易暴露补偿类 bug）
    await ev(`scrollTo(0, Math.round(document.documentElement.scrollHeight * 0.4))`);
    await sleep(900);

    // ── 序列 1：start → move ×N → cancel ──
    let before = await sample();
    report.seq1Before = before;
    await ev(`window.__mdlegoBackGesture('start', 0, 0, 400, 0)`);
    await sleep(140);
    for (const p of [0.2, 0.45, 0.7, 0.95]) {
      await ev(`window.__mdlegoBackGesture('move', ${p}, 0, ${400 + p * 200}, 0)`);
      await sleep(80);
    }
    const during1 = await sample();
    check('序列1 手势中：临时层已挂出', during1.masks === 1 && during1.scrims === 1, `masks=${during1.masks}`);
    await ev(`window.__mdlegoBackGesture('cancel', 0, 0, 400, 0)`);
    report.seq1After = await assertClean(before, '序列1 start→move→cancel');

    // ── 序列 2：start → cancel → start → commit ──
    before = await sample();
    report.seq2Before = before;
    await ev(`window.__mdlegoBackGesture('start', 0, 0, 400, 0)`);
    await sleep(120);
    await ev(`window.__mdlegoBackGesture('move', 0.5, 0, 500, 0)`);
    await sleep(80);
    await ev(`window.__mdlegoBackGesture('cancel', 0.5, 0, 500, 0)`);
    await sleep(700);
    const afterCancel2 = await sample();
    check('序列2 第一次 cancel 后：无残留层', afterCancel2.masks === 0 && afterCancel2.scrims === 0,
      `masks=${afterCancel2.masks}`);

    // 再来一次并 commit
    await ev(`window.__mdlegoBackGesture('start', 0, 0, 400, 0)`);
    await sleep(120);
    await ev(`window.__mdlegoBackGesture('move', 0.6, 0, 520, 0)`);
    await sleep(80);
    await ev(`window.__mdlegoBackGesture('commit', 1, 0, 520, 0)`);
    await sleep(1400);
    const afterCommit2 = await sample();
    check('序列2 commit 后：已回到书架', afterCommit2.onShelf === true && afterCommit2.inReader === false,
      JSON.stringify({ onShelf: afterCommit2.onShelf, inReader: afterCommit2.inReader }));
    check('序列2 commit 后：无残留 .page-mask*',
      afterCommit2.masks === 0 && afterCommit2.scrims === 0, `masks=${afterCommit2.masks}`);
    report.seq2After = afterCommit2;

    // 回阅读页准备序列 3
    await ev(`(() => { const c = document.querySelector('[data-testid="shelf-grid"] [data-doc-id]'); if (c) c.click(); return true; })()`);
    await sleep(2500);
    await ev(`scrollTo(0, Math.round(document.documentElement.scrollHeight * 0.3))`);
    await sleep(900);

    // ── 序列 3：start → move → 切后台再回来（没有结束事件）──
    before = await sample();
    report.seq3Before = before;
    await ev(`window.__mdlegoBackGesture('start', 0, 0, 400, 0)`);
    await sleep(140);
    await ev(`window.__mdlegoBackGesture('move', 0.5, 0, 500, 0)`);
    await sleep(120);
    const during3 = await sample();
    check('序列3 手势中：临时层已挂出', during3.masks === 1, `masks=${during3.masks}`);

    // 切后台（HOME），再切回来 —— 原生不会发结束事件
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    await sleep(1200);
    adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
    await sleep(1800);
    report.seq3After = await assertClean(before, '序列3 切后台再回来');
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    try { adb('forward', '--remove', `tcp:${PORT}`); } catch { /* ignore */ }
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'A-gesture-sequences.json'), JSON.stringify(report, null, 1), 'utf8');
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n结果：${checks.length - failed.length}/${checks.length}`);
  console.log('证据：', join(OUT, 'A-gesture-sequences.json'));
  if (failed.length > 0) {
    console.log('失败：\n' + failed.map((f) => `  ✗ ${f.name}`).join('\n'));
    process.exitCode = 1;
  }
}

await main();
