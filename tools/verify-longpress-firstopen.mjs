#!/usr/bin/env node
/**
 * #D 验收：冷启动后**第一次**进文档，长按英文词必须出选词工具条。
 *
 * 逐项断言：
 *   1. 转场期间 article 的 pointer-events 是 auto（不是 none）
 *      —— 这是 #D 的根因：`.page-mask__reader` 继承 none，事件到不了正文
 *   2. 转场期间 pointerdown 能到达 article
 *   3. 长按英文词 → 选词工具条出现且可见
 *   4. 工具条在视口内、位置合理
 *   5. 第二次打开同样可用（无回归）
 *
 * 用法：node tools/verify-longpress-firstopen.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'perf', '1.2.1', 'evidence');
const SERIAL = process.env.MDLEGO_SERIAL ?? '518d68b2';
const PKG = 'cn.mdlego.reader';
const PORT = 9271;

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

/** 找一个「已挂载且在视口内」的英文词坐标。 */
const findWord = () => ev(`(() => {
  const art = document.querySelector('[data-testid="article"]');
  if (!art) return null;
  const walker = document.createTreeWalker(art, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node !== null) {
    const t = node.textContent ?? '';
    const i = t.search(/[A-Za-z]{3,}/);
    if (i >= 0) {
      const r = document.createRange();
      r.setStart(node, i + 1);
      r.setEnd(node, i + 2);
      const rs = r.getClientRects();
      if (rs.length > 0 && rs[0].top > 80 && rs[0].top < window.innerHeight - 120) {
        const rr = rs[0];
        return { x: Math.round(rr.left + rr.width / 2), y: Math.round(rr.top + rr.height / 2), word: /[A-Za-z]{3,}/.exec(t.slice(i))?.[0] };
      }
    }
    node = walker.nextNode();
  }
  return null;
})()`);

/** 长按（真触摸序列）。 */
async function longPress(x, y, ms = 750) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }] });
  await sleep(ms);
  const mid = await readToolbar();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(350);
  return mid;
}

/** 读工具条真实几何与可见性（不能用 offsetParent：fixed 元素恒为 null）。 */
const readToolbar = () => ev(`(() => {
  const b = document.querySelector('[data-testid="sel-toolbar"], .sel-toolbar');
  if (b === null) return { present: false };
  const r = b.getBoundingClientRect();
  const cs = getComputedStyle(b);
  return {
    present: true,
    visible: r.width > 40 && r.height > 20 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.5,
    inViewport: r.top >= -2 && r.left >= -2 && r.bottom <= window.innerHeight + 2 && r.right <= window.innerWidth + 2,
    rect: { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) },
    position: cs.position,
    buttons: b.querySelectorAll('button').length,
  };
})()`);

const dismissToolbar = () => ev(`(() => {
  const b = document.querySelector('[data-testid="sel-toolbar"], .sel-toolbar');
  if (b) b.remove();
  const s = window.getSelection();
  if (s) s.removeAllRanges();
  return true;
})()`);

async function openDoc() {
  await ev(`location.hash='#/'`);
  await sleep(700);
  const ok = await ev(`(() => { const c = document.querySelector('[data-testid="shelf-grid"] [data-doc-id]'); if (!c) return false; c.click(); return true; })()`);
  return ok;
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
    // ── 冷启动后第一次打开 ──
    check('打开一篇文档（冷启动后第一次）', await openDoc() === true);

    // 转场进行中就检查 pointer-events 与事件是否到得了正文
    await sleep(140);
    const during = await ev(`(() => {
      const art = document.querySelector('[data-testid="article"]');
      const mask = document.querySelector('[data-testid="page-mask"]');
      return {
        mask: !!mask,
        artPointerEvents: art ? getComputedStyle(art).pointerEvents : null,
        readerLive: !!document.querySelector('.page-mask__reader--live'),
      };
    })()`);
    report.duringTransition = during;
    check('转场期间形变壳存在', during.mask === true);
    check('转场期间 article 的 pointer-events 是 auto（#D 根因已修）',
      during.artPointerEvents === 'auto', `pointer-events=${during.artPointerEvents}`);
    check('打开方向的承载层带 --live 可交互类', during.readerLive === true);

    // 等转场与首屏稳定
    await sleep(2600);
    const ready = await ev(`({
      blocks: document.querySelectorAll('[data-testid="article"] [data-bid]').length,
      complete: document.querySelector('[data-testid="shell"]')?.getAttribute('data-article') ?? null,
      masks: document.querySelectorAll('[data-testid="page-mask"]').length,
    })`);
    report.ready = ready;
    check('转场已结束、正文已齐全', ready.masks === 0 && ready.complete === 'complete',
      `masks=${ready.masks} complete=${ready.complete} blocks=${ready.blocks}`);

    // ── 长按英文词 ──
    const w1 = await findWord();
    check('找到可长按的英文词', w1 !== null, w1 ? `"${w1.word}" @(${w1.x},${w1.y})` : '');
    if (w1 !== null) {
      const tb = await longPress(w1.x, w1.y);
      report.toolbar = tb;
      check('长按英文词 → 工具条出现', tb.present === true);
      check('工具条可见（有尺寸、不透明、非 hidden）', tb.visible === true,
        tb.present ? JSON.stringify(tb.rect) : '');
      check('工具条完整落在视口内', tb.inViewport === true,
        tb.present ? `top=${tb.rect.top} bottom=${tb.rect.top + tb.rect.height}` : '');
      check('工具条有操作按钮', (tb.buttons ?? 0) >= 3, `buttons=${tb.buttons}`);
    }
    await dismissToolbar();

    // ── 第二次打开（无回归）──
    await ev(`(document.querySelector('[data-testid="back-to-shelf"]') ?? { click() {} }).click()`);
    await sleep(1500);
    check('返回书架', await ev(`!!document.querySelector('[data-testid="shelf-grid"]')`) === true);
    await openDoc();
    await sleep(2600);
    const w2 = await findWord();
    if (w2 !== null) {
      const tb2 = await longPress(w2.x, w2.y);
      report.toolbar2 = tb2;
      check('第二次打开长按同样可用（无回归）', tb2.present === true && tb2.visible === true,
        tb2.present ? JSON.stringify(tb2.rect) : '');
    } else {
      check('第二次打开找到英文词', false);
    }
    await dismissToolbar();
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    try { adb('forward', '--remove', `tcp:${PORT}`); } catch { /* ignore */ }
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'D-longpress-verify.json'), JSON.stringify(report, null, 1), 'utf8');
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n结果：${checks.length - failed.length}/${checks.length}`);
  console.log('证据：', join(OUT, 'D-longpress-verify.json'));
  if (failed.length > 0) {
    console.log('失败：\n' + failed.map((f) => `  ✗ ${f.name}`).join('\n'));
    process.exitCode = 1;
  }
}

await main();
