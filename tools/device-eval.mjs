#!/usr/bin/env node
/**
 * 真机 WebView 远程执行 —— F1/F2 走查用。
 *
 * 手机屏幕锁着也能用：通过 adb forward 到 WebView 的 devtools socket，
 * 再用 CDP Runtime.evaluate 在应用里执行一段表达式，拿回 JSON 结果。
 * 这样不依赖 `adb shell input`（HyperOS 未开「USB 调试（安全设置）」时会拒绝注入）。
 *
 * 用法：
 *   node tools/device-eval.mjs "document.body.innerText.slice(0,300)"
 *   node tools/device-eval.mjs --file script.js
 *   node tools/device-eval.mjs --shot docs/screenshots/F/xx.png "click(...)"   # 执行后顺手截图
 *   node tools/device-eval.mjs --reload "…"                                    # 先重载再执行（验证迁移）
 *
 * 环境变量：MDLEGO_CDP_PORT（默认 9333）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.MDLEGO_CDP_PORT ?? '9333';
const ENDPOINT = `http://127.0.0.1:${PORT}`;

/** 极简 CDP 客户端（Node 24 自带 WebSocket）。 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 在页面里执行表达式，返回 JSON 可序列化的值。 */
  async eval(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
      allowUnsafeEvalBlockedByCSP: true,
    });
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      throw new Error(`页面异常：${d.exception?.description ?? d.text ?? JSON.stringify(d)}`);
    }
    return result.result?.value;
  }

  static async connect() {
    const info = await (await fetch(`${ENDPOINT}/json`)).json();
    const page = info.find((t) => t.type === 'page' && /localhost|mdlego/.test(t.url));
    if (!page) throw new Error(`找不到应用页面：${info.map((t) => t.url).join(', ')}`);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    const cdp = new Cdp(ws);
    cdp.target = page;
    return cdp;
  }
}

/** 截图（fromSurface=false：屏幕锁着也能拿到渲染结果）。 */
async function capture(cdp, outPath) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: false });
  writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
  return outPath;
}

const argv = process.argv.slice(2);
const jsonOut = argv.includes('--json');
if (jsonOut) argv.splice(argv.indexOf('--json'), 1);
const shotIdx = argv.indexOf('--shot');
const shotPath = shotIdx >= 0 ? argv[shotIdx + 1] : null;
if (shotIdx >= 0) argv.splice(shotIdx, 2);
const reload = argv.includes('--reload');
if (reload) argv.splice(argv.indexOf('--reload'), 1);
const withLogs = argv.includes('--logs');
if (withLogs) argv.splice(argv.indexOf('--logs'), 1);
// --active：把后台/息屏的 WebView 切到 active（否则 visibilityState=hidden，
// requestAnimationFrame 与 View Transition 都会被节流，真机验证会失真）
const withActive = argv.includes('--active');
if (withActive) argv.splice(argv.indexOf('--active'), 1);
const fileIdx = argv.indexOf('--file');
const code = fileIdx >= 0 ? readFileSync(argv[fileIdx + 1], 'utf8') : argv.join(' ');

if (!code.trim()) {
  console.error('用法：node tools/device-eval.mjs "表达式" | --file a.js | --shot out.png "表达式"');
  process.exit(2);
}

const cdp = await Cdp.connect();
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
if (withActive) {
  try {
    await cdp.send('Page.bringToFront');
  } catch { /* 有的 WebView 版本不支持 */ }
  try {
    await cdp.send('Page.setWebLifecycleState', { state: 'active' });
  } catch { /* 同上 */ }
  try {
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  } catch { /* 同上 */ }
  await sleep(600);
}

if (reload) {
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(2500);
}

let value;
try {
  value = await cdp.eval(code);
} catch (err) {
  const logs = cdp.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled')
    .slice(-10)
    .map((e) => e.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  console.error(String(err.message));
  if (logs.length) console.error('最近 console：\n' + logs.join('\n'));
  process.exitCode = 1;
  value = { error: String(err.message) };
}

if (shotPath) {
  await capture(cdp, shotPath);
  if (!jsonOut) console.error(`截图：${shotPath}`);
}
if (withLogs) {
  const logs = cdp.events
    .filter((e) => e.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(e.params.type))
    .map((e) => {
      const text = e.params.args
        .map((a) => a.value ?? a.description ?? JSON.stringify(a.preview?.properties ?? a.type))
        .join(' ');
      return `${e.params.type}: ${text}`;
    });
  console.error(`console 事件 ${logs.length} 条` + (logs.length ? ':\n' + logs.join('\n') : ''));
}
console.log(jsonOut || typeof value !== 'string' ? JSON.stringify(value, null, 2) : value);
cdp.ws.close();
