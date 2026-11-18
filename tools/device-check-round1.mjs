#!/usr/bin/env node
/**
 * 真机冒烟（锁屏状态下）——只确认「装上了、能启动、首页能渲染」。
 *
 * 明确边界：手机锁屏时 WebView visibilityState=hidden，触摸注入/View Transition
 * 都不可靠，且 screencap 只能拿到黑屏。因此本脚本**不充当任何交互项的证据**，
 * #1/#3/#4/#5 的证据一律来自 Chrome 触摸模拟（tools/repro-round1.mjs）。
 *
 * 用法：node tools/device-check-round1.mjs [--serial=518d68b2]
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const SERIAL = (process.argv.find((a) => a.startsWith('--serial=')) ?? '--serial=518d68b2').slice(9);
const PORT = 9333;
const SHOTS = join(resolve(import.meta.dirname, '..'), 'docs', 'screenshots', 'fix-round1', 'device');
const adb = (args) => (spawnSync('adb', ['-s', SERIAL, ...args], { encoding: 'utf8', timeout: 25000 }).stdout ?? '').trim();
const rows = [];
const mark = (name, ok, detail) => { rows.push({ name, ok, detail }); console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };

const pkg = adb(['shell', 'dumpsys', 'package', 'cn.mdlego.reader']);
const ver = pkg.match(/versionName=(\S+)/)?.[1] ?? '';
const code = pkg.match(/versionCode=(\d+)/)?.[1] ?? '';
mark('已安装 1.0.0-rc.2', ver === '1.0.0-rc.2' && code === '1000052', `${ver} / ${code}`);

adb(['shell', 'am', 'force-stop', 'cn.mdlego.reader']);
await sleep(600);
adb(['shell', 'am', 'start', '-W', '-n', 'cn.mdlego.reader/.MainActivity'], 40000);
await sleep(2200);
const pid = adb(['shell', 'pidof', 'cn.mdlego.reader']);
mark('应用可冷启动', /^\d+$/.test(pid), `pid=${pid}`);

adb(['forward', '--remove', `tcp:${PORT}`]);
adb(['forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`]);
let target = null;
for (let i = 0; i < 15 && target === null; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    target = list.find((t) => /localhost|mdlego/.test(t.url)) ?? null;
  } catch { /* 端口未就绪 */ }
  await sleep(400);
}

if (target === null) {
  mark('WebView 调试目标可连', false, '锁屏状态下系统可能已冻结渲染进程');
} else {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); }
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(`超时 ${method}`)); } }, 12000);
  });
  const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
  await send('Page.enable');
  await send('Runtime.enable');
  const state = await evalJs(`({ vis: document.visibilityState, docs: document.querySelectorAll('[data-testid="doc-item"]').length, w: innerWidth, h: innerHeight, text: document.body.innerText.slice(0, 30) })`);
  mark('首页渲染且旧数据可读', state.docs > 0, `${state.docs} 篇 · ${state.w}x${state.h} · ${state.text.replace(/\n/g, ' ')}`);
  mark('渲染器处于前台（可作触摸证据）', state.vis === 'visible', `visibilityState=${state.vis}（hidden 时触摸/转场不采信）`);
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: false });
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, '00-shelf-device.png'), Buffer.from(shot.data, 'base64'));
    mark('CDP 截图可用', true, '00-shelf-device.png');
  } catch {
    mark('CDP 截图可用', false, '锁屏时 WebView 冻结，截不到画面（真机视觉验收需解锁，见阻塞项）');
  }
  ws.close();
}
adb(['forward', '--remove', `tcp:${PORT}`]);

const failed = rows.filter((r) => !r.ok);
console.log(`\n真机冒烟：${rows.length - failed.length}/${rows.length}（锁屏状态下仅冒烟，不作为 #1/#3/#4/#5 的交互证据）`);
if (failed.length > 0) process.exitCode = 1;
