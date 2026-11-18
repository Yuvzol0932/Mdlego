#!/usr/bin/env node
/**
 * UI 线真机截图工具（复用，不是新增验证门禁）。
 *
 * 设备：小米 11 Ultra（adb 518d68b2）。该机 adb shell input 被 MIUI 拦在
 * INJECT_EVENTS 上，所以点击一律走 WebView DevTools CDP 的 Runtime.evaluate。
 *
 * 用法：
 *   import { connect } from '../tools/ui-capture.mjs';
 *   const ui = await connect();
 *   await ui.shelf();                 // 回书架
 *   await ui.open('词根词缀速查表');    // 打开指定标题的文档
 *   await ui.shot('before/xx');       // 存 artifacts/ui-polish/<name>.png
 *   await ui.close();
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 9222;
const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'artifacts', 'ui-polish');

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { resolve: r, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else r(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout: ' + method)); }
      }, 20000);
    });
  }
}

/**
 * 执行 adb 并返回 stdout（去空白）。
 *
 * 关键：adb shell pidof 在「进程不存在」时以退出码 1 结束且输出为空，
 * execFileSync 默认会抛异常。这里显式容忍非零退出码，把空输出原样返回，
 * 让调用方自己判断「没 pid」而不是被异常打断。
 */
function adb(args) {
  try {
    return execFileSync('adb', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const out = String(error?.stdout ?? '').trim();
    return out;
  }
}

/**
 * 连接真机 WebView。
 *
 * 冷启动后 WebView 的 devtools socket 不是立刻可用：进程起来了但 socket
 * 还没监听，或 /json/list 还是空的。这里做有界重试（最多约 20 秒），
 * 避免复现脚本因为「刚启动」而误判失败。
 */
export async function connect() {
  let pid = '';
  for (let i = 0; i < 20; i++) {
    pid = adb(['shell', 'pidof', 'cn.mdlego.reader']);
    if (pid) break;
    await sleep(500);
  }
  if (!pid) throw new Error('墨读没在跑：adb shell am start -n cn.mdlego.reader/.MainActivity');
  adb(['forward', 'tcp:' + PORT, 'localabstract:webview_devtools_remote_' + pid]);

  let page = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      page = list.find((t) => t.type === 'page');
      if (page) break;
    } catch { /* socket 还没监听，继续等 */ }
  }
  if (!page) throw new Error('没找到 WebView 页面（devtools socket 未就绪）');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连不上')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  mkdirSync(OUT, { recursive: true });

  const api = {
    async ev(expression) {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('页面异常: ' + r.exceptionDetails.text);
      return r.result.value;
    },
    /** 截图，file 相对 artifacts/ui-polish/ */
    async shot(name) {
      const s = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const p = join(OUT, name + '.png');
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, Buffer.from(s.data, 'base64'));
      return p;
    },
    /** 派发一次真实触摸（CDP Input 域，非合成 DOM 事件）。kind: start / end / move */
    async cdpTouch(x, y, kind) {
      const type = kind === 'start' ? 'touchStart' : kind === 'move' ? 'touchMove' : 'touchEnd';
      const touchPoints = kind === 'end' ? [] : [{ x, y, radiusX: 4, radiusY: 4, force: 1 }];
      await cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
    },
    /** 局部截图（用于逐像素对比某一行），box 为 CSS 像素坐标。 */
    async shotClip(name, box) {
      const dpr = await this.ev('window.devicePixelRatio');
      const s = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
        clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 },
      });
      const p = join(OUT, name + '.png');
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, Buffer.from(s.data, 'base64'));
      return p;
    },
    /** 断言后截图，不满足断言直接抛错，避免拍到错误界面。 */
    async shotAssert(name, assertionExpr) {
      const ok = await this.ev(assertionExpr);
      if (!ok) throw new Error('截图前断言失败: ' + name + ' ← ' + assertionExpr);
      return this.shot(name);
    },
    async tap(testId) {
      const ok = await this.ev(
        '(() => { const e = document.querySelector(\'[data-testid="' + testId + '"]\'); if (!e) return false; e.click(); return true; })()',
      );
      if (!ok) throw new Error('找不到 testid: ' + testId);
      await sleep(400);
    },
    /** 回书架（带轮询与断言） */
    async shelf() {
      for (let i = 0; i < 6; i++) {
        const st = await this.ev(String.raw`(() => {
          if (document.querySelector('[data-testid="shelf"]')) return 'shelf';
          const b = document.querySelector('[data-testid="back-to-shelf-top"]') || document.querySelector('[data-testid="back-to-shelf"]');
          if (b) { b.click(); return 'clicked'; }
          if (document.querySelector('[data-testid="close-font-sheet"]')) { document.querySelector('[data-testid="close-font-sheet"]').click(); return 'closed'; }
          for (const id of ['toc-drawer-close', 'search-close']) {
            const x = document.querySelector('[data-testid="' + id + '"]');
            if (x) { x.click(); return 'closed'; }
          }
          location.hash = '#/';
          return 'other';
        })()`);
        if (st === 'shelf') { await sleep(300); return true; }
        await sleep(600);
      }
      throw new Error('回不到书架');
    },
    async open(title) {
      await this.shelf();
      const ok = await this.ev(
        '(() => { const hit = [...document.querySelectorAll(\'[data-testid="doc-item"]\')].find(e => e.querySelector(".doc-item__title")?.textContent === ' +
        JSON.stringify(title) + '); if (!hit) return false; hit.click(); return true; })()',
      );
      if (!ok) throw new Error('找不到文档: ' + title);
      await sleep(1100);
      return true;
    },
    async theme(testId) {
      await this.ev('location.hash = "#/settings"; true');
      await sleep(700);
      await this.tap(testId);
      await this.ev('location.hash = "#/"; true');
      await sleep(600);
    },
    async scroll(px) { await this.ev('window.scrollTo(0, ' + px + '); true'); await sleep(500); },
    async close() { try { ws.close(); } catch { /* ignore */ } },
  };
  return api;
}

// 直接运行：截一张当前画面做连通性自检
if (process.argv[1] && process.argv[1].endsWith('ui-capture.mjs')) {
  const ui = await connect();
  console.log('自检截图：', await ui.shot('_probe'));
  await ui.close();
}
