#!/usr/bin/env node
/**
 * M1 修订：杂志排版（日间 + 夜间）。
 *
 * 用户在纸面 / 杂志 / 暗色三方案中选了「杂志排版」，
 * 并要求把它的暗色版本也做出来。
 *
 * 相对初稿修掉的问题：
 *   1. 首字下沉在中英混排里很突兀 —— 中文首字下沉不是排版传统，
 *      改为「首行缩进 + 首段轻微强调」，更符合中文阅读习惯。
 *   2. 宋体在小屏偏细 —— 统一提升字重，标题用 700 / 正文 500。
 *   3. 表格沿用杂志样式但保证窄屏可横滚。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { serveStatic } from './serve.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'artifacts', 'm1-design');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));

const VIEWPORT = { width: 393, height: 873, deviceScaleFactor: 3, mobile: true };
const PORT = 9335;

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { resolve: res, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else res(m.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }
}

async function connectWs(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch {
      /* not ready */
    }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

async function evaluate(cdp, sid, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

async function shot(cdp, sid, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
}

/** 日间：米色纸 + 宋体 + 强层级 */
const DAY_CSS = `
  :root {
    --paper: #f4efe4;
    --paper-raised: #faf6ee;
    --ink: #131109;
    --ink-soft: #3a342a;
    --ink-faint: #7c7466;
    --rule: #d6cdbc;
    --accent: #8a2b1f;
    --fs-body: 18px;
    --lh-body: 1.88;
    --mark-yellow: #f2d98a;
    --mark-green: #cfe3b8;
    --mark-blue: #b9d4e8;
    --mark-pink: #eec9cf;
  }
  html, body { background: var(--paper); }

  .appbar { background: rgba(244,239,228,0.9); border-bottom-color: var(--rule); }
  .appbar__title { font-family: "Songti SC","Noto Serif CJK SC",serif; font-weight: 700; }
  .btn { color: var(--ink-soft); }

  .article {
    font-family: "Songti SC","Noto Serif CJK SC","Source Han Serif SC",serif;
    font-weight: 500;
    letter-spacing: 0.022em;
    padding-top: 1.6em;
  }

  /* 标题：粗分隔线 + 紧字距，是这套方案的性格所在 */
  .article h1 {
    font-family: "Songti SC","Noto Serif CJK SC","Source Han Serif SC",serif;
    font-size: 1.95em;
    font-weight: 700;
    line-height: 1.26;
    letter-spacing: 0.005em;
    margin: 0.1em 0 0.85em;
    padding-bottom: 0.32em;
    border-bottom: 2.5px solid var(--ink);
  }
  .article h2 {
    font-family: "Songti SC","Noto Serif CJK SC","Source Han Serif SC",serif;
    font-size: 1.42em;
    font-weight: 700;
    letter-spacing: 0.008em;
    margin: 1.95em 0 0.62em;
    padding-left: 0.5em;
    border-left: 4px solid var(--accent);
  }
  .article h3 {
    font-size: 1.16em;
    font-weight: 700;
    margin: 1.5em 0 0.5em;
  }

  /* 首段用首行缩进代替首字下沉：更符合中文排版，也不和英文混排打架 */
  .article p:first-of-type {
    text-indent: 2em;
    font-weight: 500;
  }
  .article p { margin-bottom: 1.1em; }

  .article blockquote {
    border-left: 0;
    padding: 1em 1.15em;
    margin: 1.6em 0;
    background: color-mix(in srgb, var(--ink) 5.5%, transparent);
    border-radius: 3px;
    font-style: italic;
    color: var(--ink-soft);
  }

  .article ul, .article ol { padding-left: 1.55em; }
  .article li { margin-bottom: 0.48em; }
  .article li::marker { color: var(--accent); }

  /* 表格：杂志感来自「无竖线 + 粗底线」 */
  .article table {
    font-family: var(--font-sans);
    font-size: 0.9em;
    letter-spacing: 0;
    border-collapse: collapse;
    width: max-content;
    max-width: 100%;
    display: block;
    overflow-x: auto;
    margin: 1.4em 0 1.6em;
  }
  .article th, .article td {
    border: 0;
    border-bottom: 1px solid var(--rule);
    padding: 0.62em 0.9em;
    white-space: nowrap;
  }
  .article th {
    background: transparent;
    border-bottom: 2px solid var(--ink);
    font-weight: 700;
  }

  .article a { color: var(--accent); text-decoration-thickness: 1px; }
  .article code {
    font-family: var(--font-mono);
    background: color-mix(in srgb, var(--ink) 7%, transparent);
    letter-spacing: 0;
  }
  .article pre { background: color-mix(in srgb, var(--ink) 6%, transparent); letter-spacing: 0; }
  .article hr { border-top: 1px solid var(--rule); }
`;

/** 夜间：同一套排版骨架，换成深色纸面 */
const NIGHT_CSS = `
  :root {
    --paper: #131218;
    --paper-raised: #1a1920;
    --ink: #e8e4da;
    --ink-soft: #b3ada1;
    --ink-faint: #756f64;
    --rule: #2c2a33;
    --accent: #c9865a;
    --fs-body: 18px;
    --lh-body: 1.88;
    --mark-yellow: #4a3d12;
    --mark-green: #23361c;
    --mark-blue: #1b2f40;
    --mark-pink: #3a1f27;
  }
  html, body { background: var(--paper); }

  .appbar { background: rgba(19,18,24,0.9); border-bottom-color: var(--rule); }
  .appbar__title { font-family: "Songti SC","Noto Serif CJK SC",serif; font-weight: 700; color: var(--ink); }
  .btn { color: var(--ink-soft); }

  .article {
    font-family: "Songti SC","Noto Serif CJK SC","Source Han Serif SC",serif;
    font-weight: 500;
    letter-spacing: 0.022em;
    padding-top: 1.6em;
  }

  .article h1 {
    font-family: "Songti SC","Noto Serif CJK SC","Source Han Serif SC",serif;
    font-size: 1.95em;
    font-weight: 700;
    line-height: 1.26;
    letter-spacing: 0.005em;
    margin: 0.1em 0 0.85em;
    padding-bottom: 0.32em;
    border-bottom: 2.5px solid var(--ink);
    color: #f2eee4;
  }
  .article h2 {
    font-family: "Songti SC","Noto Serif CJK SC","Source Han Serif SC",serif;
    font-size: 1.42em;
    font-weight: 700;
    letter-spacing: 0.008em;
    margin: 1.95em 0 0.62em;
    padding-left: 0.5em;
    border-left: 4px solid var(--accent);
    color: #f2eee4;
  }
  .article h3 { font-size: 1.16em; font-weight: 700; margin: 1.5em 0 0.5em; color: #f2eee4; }

  .article p:first-of-type { text-indent: 2em; font-weight: 500; }
  .article p { margin-bottom: 1.1em; }

  .article blockquote {
    border-left: 0;
    padding: 1em 1.15em;
    margin: 1.6em 0;
    background: rgba(255,255,255,0.045);
    border-radius: 3px;
    font-style: italic;
    color: var(--ink-soft);
  }

  .article ul, .article ol { padding-left: 1.55em; }
  .article li { margin-bottom: 0.48em; }
  .article li::marker { color: var(--accent); }

  .article table {
    font-family: var(--font-sans);
    font-size: 0.9em;
    letter-spacing: 0;
    border-collapse: collapse;
    width: max-content;
    max-width: 100%;
    display: block;
    overflow-x: auto;
    margin: 1.4em 0 1.6em;
  }
  .article th, .article td {
    border: 0;
    border-bottom: 1px solid var(--rule);
    padding: 0.62em 0.9em;
    white-space: nowrap;
  }
  .article th {
    background: transparent;
    border-bottom: 2px solid #8f8a7e;
    font-weight: 700;
    color: #f2eee4;
  }

  .article a { color: var(--accent); text-decoration-thickness: 1px; }
  .article code {
    font-family: var(--font-mono);
    background: rgba(255,255,255,0.08);
    color: #ddd8cc;
    letter-spacing: 0;
  }
  .article pre { background: rgba(255,255,255,0.055); letter-spacing: 0; }
  .article pre code { color: #d8d2c4; }
  .article hr { border-top: 1px solid var(--rule); }
  .article mark { color: var(--ink); }
`;

async function main() {
  if (CHROME === undefined) {
    console.error('✗ 未找到 Chrome');
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  const server = await serveStatic(join(ROOT, 'www'));

  const proc = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      '--headless=new',
      '--no-first-run',
      '--disable-extensions',
      '--user-data-dir=' + join(ROOT, 'artifacts', '.chrome-m1b'),
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    const wsUrl = await connectWs(PORT);
    const ws = new WebSocket(wsUrl);
    await new Promise((r, j) => {
      ws.addEventListener('open', r, { once: true });
      ws.addEventListener('error', () => j(new Error('ws fail')), { once: true });
    });
    const cdp = new Cdp(ws);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { ...VIEWPORT, screenWidth: VIEWPORT.width, screenHeight: VIEWPORT.height },
      sessionId,
    );

    await cdp.send('Page.navigate', { url: server.url }, sessionId);
    await sleep(1500);

    await evaluate(
      cdp,
      sessionId,
      `(() => {
        window.__setCss = (css) => {
          let s = document.getElementById('m1-mag');
          if (!s) { s = document.createElement('style'); s.id = 'm1-mag'; document.head.appendChild(s); }
          s.textContent = css;
        };
        return true;
      })()`,
    );

    const variants = [
      { name: 'm1-magazine-day-v2', css: DAY_CSS, label: '杂志排版（日间）' },
      { name: 'm1-magazine-night-v2', css: NIGHT_CSS, label: '杂志排版（夜间）' },
    ];

    for (const v of variants) {
      await evaluate(cdp, sessionId, `window.__setCss(${JSON.stringify(v.css)})`);
      await sleep(500);
      const file = await shot(cdp, sessionId, v.name);
      console.log(`  ✓ ${v.label} → ${file}`);
    }

    // 滚动到中段再截一张，确认长内容下的层级表现
    await evaluate(cdp, sessionId, `window.scrollTo(0, 900)`);
    await sleep(400);
    const mid = await shot(cdp, sessionId, 'm1-magazine-night-mid');
    console.log(`  ✓ 夜间中段 → ${mid}`);
  } finally {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    await server.close();
  }
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
