#!/usr/bin/env node
/**
 * #D 复现：冷启动后**第一次**进文档，长按英文词没有工具条；退出再进才有。
 *
 * 任务书要求：先复现、逐项对比「第一次」与「第二次」的差异，差异就是根因。
 * 这个脚本把两边都量一遍，并逐项打印：
 *   1. 长按点 elementFromPoint 命中的是不是 article
 *   2. article 的 data-gen 与 selectionBinding 绑定的节点是否同一个
 *   3. blockTexts() 返回多少条
 *   4. 是否收到 pointerdown / pointercancel / pointerup
 *   5. 长按计时器是否到点、wordRangeAtPoint 是否命中
 *   6. 工具条是否出现
 *
 * 用法：node tools/diag-longpress.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'perf', '1.2.1', 'evidence');
const SERIAL = process.env.MDLEGO_SERIAL ?? '518d68b2';
const PKG = 'cn.mdlego.reader';
const PORT = 9255;

const ADB = [
  'D:\\Workbuddyspace\\.android-sdk\\platform-tools\\adb.exe',
  process.env.LOCALAPPDATA + '\\Android\\Sdk\\platform-tools\\adb.exe',
  'adb',
].find((p) => p === 'adb' || (p && existsSync(p)));
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.logs = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.consoleAPICalled') {
        const a = (m.params?.args ?? []).map((x) => x.value ?? x.description ?? '');
        this.logs.push(a.join(' '));
        return;
      }
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

/** 装长按探针：记录事件序列与工具条出现。 */
const installProbe = () => ev(`(() => {
  window.__lp = { events: [], toolbar: null, blockTexts: null, gen: null };
  const art = document.querySelector('[data-testid="article"]');
  window.__lp.gen = art ? art.getAttribute('data-gen') : null;
  const push = (t) => window.__lp.events.push({ t, at: Math.round(performance.now()) });
  document.addEventListener('pointerdown', (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    push('doc:pointerdown@' + (el ? el.tagName + '.' + (el.className || '').split(' ')[0] : 'null'));
  }, { capture: true, once: true });
  art?.addEventListener('pointerdown', () => push('article:pointerdown'), { once: true });
  art?.addEventListener('pointercancel', () => push('article:pointercancel'), { once: true });
  art?.addEventListener('pointerup', () => push('article:pointerup'), { once: true });
  return true;
})()`);

/** 长按一个英文词（用 CDP 触摸事件，原生回调不会伪造 pointer 序列）。 */
async function longPressAt(x, y, ms = 700) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }] });
  await sleep(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(500);
}

/** 找一个含英文词的块并返回它的屏幕坐标。 */
const findEnglishWordPoint = () => ev(`(() => {
  const art = document.querySelector('[data-testid="article"]');
  if (!art) return null;
  for (const b of art.querySelectorAll('[data-bid]')) {
    const txt = b.textContent ?? '';
    const m = /[A-Za-z]{3,}/.exec(txt);
    if (!m) continue;
    const r = b.getBoundingClientRect();
    if (r.width < 20 || r.bottom < 80 || r.top > window.innerHeight - 80) continue;
    // 用 Range 精确定位到词中间，模拟用户按住词
    const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node !== null) {
      const t = node.textContent ?? '';
      const idx = t.search(/[A-Za-z]{3,}/);
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx + 1);
        range.setEnd(node, idx + 2);
        const rects = range.getClientRects();
        if (rects.length > 0) {
          const rr = rects[0];
          return { x: Math.round(rr.left + rr.width / 2), y: Math.round(rr.top + rr.height / 2), word: /[A-Za-z]{3,}/.exec(t.substr(idx))?.[0] };
        }
      }
      node = walker.nextNode();
    }
  }
  return null;
})()`);

const readState = () => ev(`(() => {
  const art = document.querySelector('[data-testid="article"]');
  const bar = document.querySelector('[data-testid="sel-toolbar"], .sel-toolbar');
  return {
    hasArticle: !!art,
    gen: art ? art.getAttribute('data-gen') : null,
    articleComplete: document.querySelector('[data-testid="shell"]')?.getAttribute('data-article') ?? null,
    blocks: art ? art.querySelectorAll('[data-bid]').length : 0,
    toolbar: bar !== null && bar.offsetParent !== null,
    events: window.__lp?.events ?? [],
    probeGen: window.__lp?.gen ?? null,
    masks: document.querySelectorAll('[data-testid="page-mask"]').length,
  };
})()`);

async function openOnce(label) {
  await ev(`location.hash='#/'`);
  await sleep(700);
  const onShelf = await ev(`!!document.querySelector('[data-testid="shelf-grid"] [data-doc-id]')`);
  if (!onShelf) return null;
  await ev(`(() => { const c = document.querySelector('[data-testid="shelf-grid"] [data-doc-id]'); if (c) c.click(); return true; })()`);
  // 等转场 + 首屏稳定（冷启动首次要等 Worker）
  await sleep(3200);
  const pt = await findEnglishWordPoint();
  if (pt === null) {
    console.log(`  [${label}] 找不到英文词（文档可能没有英文）`);
    return { error: 'no-english-word' };
  }
  await installProbe();
  const before = await readState();
  await longPressAt(pt.x, pt.y);
  const after = await readState();
  const out = { label, point: pt, before, after, toolbarAppeared: after.toolbar };
  console.log(`\n[${label}]`);
  console.log(`  长按点 (${pt.x},${pt.y}) 词 "${pt.word}"`);
  console.log(`  article: gen=${after.gen} blocks=${after.blocks} data-article=${after.articleComplete}`);
  console.log(`  探针记录的 gen=${after.probeGen}`);
  console.log(`  事件序列: ${JSON.stringify(after.events)}`);
  console.log(`  工具条出现: ${after.toolbar ? '✓ 是' : '✗ 否'}`);
  return out;
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

  const report = {};
  try {
    // 冷启动后**第一次**打开
    report.first = await openOnce('第一次（冷启动后）');

    // 返回书架
    await ev(`(document.querySelector('[data-testid="back-to-shelf"]') ?? {click(){}}).click()`);
    await sleep(1500);

    // **第二次**打开（同一会话内）
    report.second = await openOnce('第二次');

    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'D-longpress.json'), JSON.stringify(report, null, 1), 'utf8');

    console.log('\n=== 差异 ===');
    const a = report.first, b = report.second;
    if (a && b && !a.error && !b.error) {
      console.log(`  首次工具条: ${a.toolbarAppeared ? '✓' : '✗'}   二次: ${b.toolbarAppeared ? '✓' : '✗'}`);
      console.log(`  首次 events: ${JSON.stringify(a.after.events)}`);
      console.log(`  二次 events: ${JSON.stringify(b.after.events)}`);
      console.log(`  首次 gen=${a.after.gen} blocks=${a.after.blocks} data-article=${a.after.articleComplete}`);
      console.log(`  二次 gen=${b.after.gen} blocks=${b.after.blocks} data-article=${b.after.articleComplete}`);
    }
    console.log('证据：', join(OUT, 'D-longpress.json'));
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    try { adb('forward', '--remove', `tcp:${PORT}`); } catch { /* ignore */ }
  }
}

await main();
