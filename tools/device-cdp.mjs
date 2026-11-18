#!/usr/bin/env node
/**
 * 真机（小米 11 Ultra）WebView CDP 驱动。
 *
 * 为什么不用 adb shell input：该机未开「USB 调试(安全设置)」，shell 无
 * INJECT_EVENTS 权限，tap/keyevent 一律 SecurityException。但 WebView 的
 * DevTools socket 是开的，可 adb forward 后直连 CDP，用 Runtime.evaluate
 * 触发真实 DOM click、用 Page.captureScreenshot 截真机图。
 *
 * 用法：
 *   import { connectDevice } from './device-cdp.mjs';
 *   const dev = await connectDevice();          // 自动 forward + 附加
 *   await dev.shot('name');                     // 存 artifacts/screenshots/name.png
 *   await dev.eval('location.hash = "#/settings"');
 *   await dev.tapTestId('open-toc');
 *   await dev.close();
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 9222;
const ROOT = resolve(import.meta.dirname, '..');

/** 极简 CDP 客户端（Node 原生 WebSocket，零依赖）。 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else res(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, reject) => {
      this.pending.set(id, { resolve: res, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 30000);
    });
  }
}

function sh(cmd) {
  return execFileSync('adb', cmd, { encoding: 'utf8' }).trim();
}

export async function connectDevice() {
  const pid = sh(['shell', 'pidof', 'cn.mdlego.reader']);
  if (!pid) throw new Error('墨读没在跑，先 adb shell am start -n cn.mdlego.reader/.MainActivity');
  sh(['forward', 'tcp:' + PORT, 'localabstract:webview_devtools_remote_' + pid]);
  await sleep(400);

  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('WebView 页面没找到');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket 连不上')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const dir = join(ROOT, 'artifacts', 'screenshots');
  mkdirSync(dir, { recursive: true });

  return {
    cdp,
    /** 执行页面 JS，返回值。 */
    async eval(expression) {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('页面脚本异常: ' + r.exceptionDetails.text);
      return r.result.value;
    },
    /** 截真机 WebView 图。 */
    async shot(name, dirOverride) {
      const s = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const out = join(dirOverride ?? dir, name + '.png');
      mkdirSync(join(out, '..'), { recursive: true });
      writeFileSync(out, Buffer.from(s.data, 'base64'));
      return out;
    },
    /** 点带 data-testid 的元素。 */
    async tapTestId(testId) {
      const ok = await this.eval(
        '(() => { const e = document.querySelector(\'[data-testid="' + testId + '"]\'); if (!e) return false; e.click(); return true; })()',
      );
      if (!ok) throw new Error('找不到 testid: ' + testId);
      await sleep(400);
      return ok;
    },
    /** 点 CSS 选择器命中的第 n 个元素。 */
    async tapSelector(selector, index = 0) {
      const ok = await this.eval(
        '(() => { const e = document.querySelectorAll(' + JSON.stringify(selector) + ')[' + index + ']; if (!e) return false; e.click(); return true; })()',
      );
      if (!ok) throw new Error('找不到选择器: ' + selector + '[' + index + ']');
      await sleep(400);
      return ok;
    },
    /** 滚到某个百分比位置（0..1）。 */
    async scrollTo(fraction) {
      await this.eval(
        'window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) * ' + fraction + '); true',
      );
      await sleep(500);
    },
    async close() {
      try { ws.close(); } catch { /* ignore */ }
    },
  };
}

// 直接运行 = 自检：截图一张
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const dev = await connectDevice();
  const p = await dev.shot('probe-' + Date.now(), join(ROOT, 'artifacts'));
  console.log('自检截图：', p);
  await dev.close();
}
