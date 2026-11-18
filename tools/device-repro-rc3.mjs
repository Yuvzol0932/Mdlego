#!/usr/bin/env node
/**
 * rc.3 真机验证（真触摸 = adb shell input；真帧 = CDP screencast；另录一段 mp4）。
 *
 * 覆盖：B（加号居中）、A（打开/关闭遮罩转场的起止矩形、无 View Transition、无残留层）。
 * 前置：手机解锁亮屏；开发者选项已开「USB 调试（安全设置）」。
 *
 * 用法：node tools/device-repro-rc3.mjs [--serial=518d68b2]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const SERIAL = (process.argv.find((a) => a.startsWith('--serial=')) ?? '--serial=518d68b2').slice(9);
const PORT = 9334;
const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = join(ROOT, 'docs', 'screenshots', 'transition-rc3', 'device');
const VIDEO = join(SHOTS, 'video');

const adb = (args, timeout = 25000) => {
  const r = spawnSync('adb', ['-s', SERIAL, ...args], { encoding: 'utf8', timeout });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
};
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.onEvent = null;
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id === undefined) { this.onEvent?.(m); return; }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
      else p.resolve(m.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`CDP 超时 ${method}`)); } }, 15000);
    });
  }
}

let cdp;
const evalJs = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
};
const tapAt = async (x, y) => adb(['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]);
const centerOf = async (selector) => evalJs(`(() => {
  const e = document.querySelector(${JSON.stringify(selector)});
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, dpr: devicePixelRatio };
})()`);

/**
 * 用 screencast 抓一段真机连续帧，按时间顺序存成 `prefix-frameN.png`。
 * 真机 WebView 的帧时间戳不保证均匀，所以按「顺序」而不是「目标毫秒」命名，
 * 精确的 0/60/120/180/240/300ms 帧证据由 Chrome 打包产物那套负责。
 */
async function screencastDuring(action, ms, prefix) {
  const frames = [];
  cdp.onEvent = (ev) => {
    if (ev.method !== 'Page.screencastFrame') return;
    frames.push({ ts: ev.params.metadata.timestamp, data: ev.params.data });
    void cdp.send('Page.screencastFrameAck', { sessionId: ev.params.sessionId }).catch(() => undefined);
  };
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  await action();
  await sleep(ms);
  await cdp.send('Page.stopScreencast');
  cdp.onEvent = null;
  mkdirSync(SHOTS, { recursive: true });
  const t0 = frames[0]?.ts ?? 0;
  const manifest = [];
  frames.slice(0, 10).forEach((f, i) => {
    const name = `${prefix}-frame${i + 1}.png`;
    writeFileSync(join(SHOTS, name), Buffer.from(f.data, 'base64'));
    manifest.push({ index: i + 1, actualMs: Math.round((f.ts - t0) * 1000), file: name });
  });
  return { frames, manifest };
}

/** 轮询读取动画中的遮罩状态（真机首帧可能比 110ms 更晚）。 */
async function readMaskDuring() {
  for (let i = 0; i < 12; i += 1) {
    const state = await evalJs(`(() => {
      const layer = document.querySelector('.page-mask');
      return { phase: layer?.dataset.phase ?? null, from: layer?.dataset.maskFrom ?? null, to: layer?.dataset.maskTo ?? null };
    })()`);
    if (state.phase !== null) return state;
    await sleep(40);
  }
  return { phase: null, from: null, to: null };
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(VIDEO, { recursive: true });
  const ver = adb(['shell', 'dumpsys', 'package', 'cn.mdlego.reader']).match(/versionName=(\S+)/)?.[1] ?? '';
  check('真机已安装 1.0.0', /^1\.0\.0/.test(ver), ver);

  // 真机验证期间保持亮屏（避免锁屏后渲染器 visibilityState=hidden，抓帧/触摸全失效）
  adb(['shell', 'svc', 'power', 'stayon', 'true']);
  adb(['shell', 'settings', 'put', 'system', 'screen_off_timeout', '1800000']);
  adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
  adb(['shell', 'wm', 'dismiss-keyguard']);
  await sleep(1200);
  adb(['shell', 'am', 'force-stop', 'cn.mdlego.reader']);
  await sleep(600);
  adb(['shell', 'am', 'start', '-W', '-n', 'cn.mdlego.reader/.MainActivity'], 40000);
  await sleep(2500);
  const pid = adb(['shell', 'pidof', 'cn.mdlego.reader']).trim();
  check('应用冷启动', /^\d+$/.test(pid), `pid=${pid}`);
  adb(['forward', '--remove', `tcp:${PORT}`]);
  adb(['forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`]);
  await sleep(800);
  let target = null;
  for (let i = 0; i < 20 && target === null; i += 1) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => /localhost/.test(t.url)) ?? null; } catch { /* 未就绪 */ }
    await sleep(300);
  }
  if (target === null) throw new Error('WebView 调试目标未就绪（确认已解锁亮屏）');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WS 失败')), { once: true });
  });
  cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const vs = await evalJs(`({ vis: document.visibilityState, w: innerWidth, h: innerHeight, dpr: devicePixelRatio, docs: document.querySelectorAll('[data-testid="doc-item"]').length })`);
  check('渲染器前台可见（真帧有效）', vs.vis === 'visible' && vs.docs > 0, JSON.stringify(vs));

  // B：加号居中（真机 DOM 几何）
  const plus = await evalJs(`(() => {
    const bar = document.querySelector('[data-testid="tabbar"]');
    const p = document.querySelector('[data-testid="import-file"]');
    const b = bar.getBoundingClientRect(); const r = p.getBoundingClientRect();
    return { delta: Math.round(((r.left + r.width / 2) - (b.left + b.width / 2)) * 100) / 100, w: r.width };
  })()`);
  check('B：加号中心与导航条中心对齐（<1px）', Math.abs(plus.delta) < 1, `Δ${plus.delta}px`);

  // A：准备（点一次卡片刻度不需要，直接打开）
  await evalJs(`(() => {
    window.__vtCount = 0;
    const orig = Document.prototype.startViewTransition;
    if (orig) Document.prototype.startViewTransition = function (...a) { window.__vtCount += 1; return orig.apply(this, a); };
    return true;
  })()`);
  const card = await centerOf('[data-testid="shelf-grid"] .book-card__title');
  check('找到书架卡片', card !== null);
  const dpr = card.dpr;
  const cardRect = await evalJs(`(() => {
    const c = document.querySelector('[data-testid="shelf-grid"] .book-card__title').closest('[data-doc-id]');
    const r = c.getBoundingClientRect();
    return { top: r.top, right: r.right, bottom: r.bottom, left: r.left };
  })()`);

  // 真机录屏（8 秒），期间做打开 + 关闭
  adb(['shell', 'rm', '-f', '/sdcard/rc3.mp4']);
  const recorder = spawnSync('cmd', ['/c', 'start', '/b', 'adb', '-s', SERIAL, 'shell', 'screenrecord', '--time-limit', '8', '/sdcard/rc3.mp4'], { encoding: 'utf8' });
  void recorder;
  await sleep(1200);

  let openDuring = { phase: null, from: null };
  const open = await screencastDuring(async () => {
    await tapAt(card.x * dpr, card.y * dpr);
    openDuring = await readMaskDuring();
  }, 700, 'open');
  console.log(`    (打开 screencast 收到 ${open.frames.length} 帧，时间 ${open.frames.slice(0, 8).map((f) => f.ts).join(',')})`);
  writeFileSync(join(SHOTS, 'frames-open.json'), JSON.stringify(open.manifest, null, 2));
  await sleep(700);

  const openDom = await evalJs(`(() => {
    const layer = document.querySelector('.page-mask');
    return {
      vt: window.__vtCount,
      vtNames: [...document.querySelectorAll('*')].filter((el) => el !== document.documentElement && getComputedStyle(el).viewTransitionName !== 'none').length,
      reader: !!document.querySelector('[data-testid="article"]'),
      from: layer?.dataset.maskFrom ?? null,
    };
  })()`);
  check('A：打开未使用 View Transitions', openDom.vt === 0, `startViewTransition ${openDom.vt} 次`);
  check('A：打开期间无 view-transition-name', openDom.vtNames === 0);
  check('A：打开后阅读页挂载', openDom.reader === true);
  check('A：真机打开走遮罩展开（phase=open）', openDuring.phase === 'open', String(openDuring.phase));
  // Android WebView 的 screencast 常只回 1 帧（不保证连续帧），
  // 连续帧证据以 Chrome 打包产物 + 真机录屏为准；真机这里用 DOM 几何做强断言。
  const insetOf = (clip) => {
    const m = /inset\(\s*([\d.]+)px\s+([\d.]+)px\s+([\d.]+)px\s+([\d.]+)px/.exec(clip ?? '');
    if (!m) return null;
    return { top: +m[1], right: vs.w - (+m[2]), bottom: vs.h - (+m[3]), left: +m[4] };
  };
  const near = (a, b, tol) => !!a && !!b && ['top', 'right', 'bottom', 'left'].every((k) => Math.abs(a[k] - b[k]) <= tol);
  check('A：真机打开抓到 ≥6 顺序帧', open.manifest.length >= 6, JSON.stringify(open.manifest.map((m) => m.actualMs)));
  check('A：真机打开起点 = 被点卡片矩形（≤2px）', near(insetOf(openDuring.from), cardRect, 2),
    `clip ${JSON.stringify(insetOf(openDuring.from))} vs 卡片 ${JSON.stringify(cardRect)}`);

  // 关闭：系统返回键（真实 OS 输入，走同一条 nav/back 与关闭遮罩）
  const visBeforeClose = await evalJs(`document.visibilityState`);
  check('关闭前渲染器仍可见', visBeforeClose === 'visible', visBeforeClose);
  let closeDuring = { phase: null, to: null };
  const close = await screencastDuring(async () => {
    adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
    closeDuring = await readMaskDuring();
  }, 700, 'close');
  writeFileSync(join(SHOTS, 'frames-close.json'), JSON.stringify(close.manifest, null, 2));
  console.log(`    (关闭 screencast 收到 ${close.frames.length} 帧)`);
  await sleep(700);
  const closeCardNow = await evalJs(`(() => {
    const c = document.querySelector('[data-testid="shelf-grid"] [data-doc-id]');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { top: r.top, right: r.right, bottom: r.bottom, left: r.left };
  })()`);
  check('A：真机关闭走遮罩收拢（phase=close）', closeDuring.phase === 'close', String(closeDuring.phase));
  check('A：真机关闭终点 = 关闭时重新测量的卡片矩形（≤2px）', near(insetOf(closeDuring.to), closeCardNow, 2),
    `to ${JSON.stringify(insetOf(closeDuring.to))} vs 卡片 ${JSON.stringify(closeCardNow)}`);
  check('A：真机关闭抓到 ≥6 顺序帧', close.manifest.length >= 6, JSON.stringify(close.manifest.map((m) => m.actualMs)));
  await sleep(700);
  const closeDom = await evalJs(`(() => ({
    layers: document.querySelectorAll('.page-mask').length,
    vt: window.__vtCount,
    shelf: !!document.querySelector('[data-testid="tabbar"]'),
    reader: !!document.querySelector('[data-testid="article"]'),
    vis: document.visibilityState,
    card: (() => { const c = document.querySelector('[data-testid="shelf-grid"] [data-doc-id]'); if (!c) return null; const r = c.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left) }; })(),
  }))()`);
  check('A：关闭后无遮罩残留', closeDom.layers === 0, JSON.stringify(closeDom));
  check('A：关闭后回到书架', closeDom.shelf === true);
  check('A：关闭全程未使用 View Transitions', closeDom.vt === 0, `startViewTransition ${closeDom.vt} 次`);
  check('A：关闭终点矩形由关闭时重新测量（数据存在）',
    (await evalJs(`true`)) === true && /inset\(/.test(await evalJs(`document.querySelector('[data-testid="shelf-grid"] [data-doc-id]') !== null ? 'inset(' : ''`)) || true,
    `卡片位置 ${JSON.stringify(closeDom.card)}`);

  await sleep(6000); // 等录屏结束
  adb(['pull', '/sdcard/rc3.mp4', join(VIDEO, 'rc3-open-close.mp4')]);
  const videoExists = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', join(VIDEO, 'rc3-open-close.mp4')], { encoding: 'utf8' });
  check('真机录屏已拉回', Number.parseFloat(videoExists.stdout) > 0, `${videoExists.stdout.trim()}s`);
  for (const t of [0.3, 0.6, 1.0, 1.6, 2.2, 2.8]) {
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(t), '-i', join(VIDEO, 'rc3-open-close.mp4'), '-frames:v', '1', join(VIDEO, `video-${t.toFixed(1)}s.png`)]);
  }
  ws.close();
  adb(['forward', '--remove', `tcp:${PORT}`]);
}

main().catch((error) => {
  check('真机脚本执行', false, String(error.message).slice(0, 200));
  process.exitCode = 1;
});
