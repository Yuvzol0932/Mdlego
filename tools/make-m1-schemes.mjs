#!/usr/bin/env node
/**
 * M1：生成三份视觉方案对比图。
 *
 * 用同一篇真实英语笔记内容，在真实 Chrome 里以小米 14 Pro 的
 * 逻辑尺寸渲染三个方向，各截图留档，供人选择。
 *
 * 三种方向不是换颜色，而是三种排版哲学：
 *   1. 纸面极简 —— 预算全花在排版精度：字距、行距、留白、层级克制
 *   2. 杂志排版 —— 大字号、强层级、衬线体、首字下沉，偏「阅读刊物」
 *   3. 暗色专注 —— 深底低饱和，为夜间与长时间复习
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
const PORT = 9334;

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
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sid,
  );
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

async function shot(cdp, sid, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
}

async function main() {
  if (CHROME === undefined) {
    console.error('✗ 未找到 Chrome');
    process.exit(1);
  }
  if (!existsSync(join(ROOT, 'www', 'index.html'))) {
    console.error('✗ 未找到 www/，请先 npm run build');
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
      '--user-data-dir=' + join(ROOT, 'artifacts', '.chrome-m1'),
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

    // 注入三套方案样式：只改视觉，不改内容结构
    await evaluate(
      cdp,
      sessionId,
      `(() => {
        const root = document.documentElement;
        root.setAttribute('data-font', 'sans');

        // 三套方案共用一个切换函数
        window.__applyScheme = (scheme) => {
          const style = document.getElementById('m1-scheme') ?? (() => {
            const s = document.createElement('style');
            s.id = 'm1-scheme';
            document.head.appendChild(s);
            return s;
          })();

          if (scheme === 'paper') {
            style.textContent = \`
              :root {
                --paper: #faf9f6; --ink: #1a1917; --ink-soft: #48453f;
                --ink-faint: #918c84; --rule: #e8e4dc; --accent: #a8612e;
                --fs-body: 17px; --lh-body: 1.82;
              }
              .article { letter-spacing: 0.012em; }
              .article h1 { letter-spacing: -0.012em; font-weight: 640; }
              .article h2 { letter-spacing: -0.006em; font-weight: 620; }
              .article p { margin-bottom: 1.15em; }
              .article li { margin-bottom: 0.5em; }
            \`;
          } else if (scheme === 'magazine') {
            style.textContent = \`
              :root {
                --paper: #f4efe4; --ink: #131109; --ink-soft: #3a342a;
                --ink-faint: #7c7466; --rule: #d6cdbc; --accent: #8a2b1f;
                --fs-body: 18.5px; --lh-body: 1.9;
              }
              .article { font-family: "Songti SC", "Noto Serif CJK SC", serif; letter-spacing: 0.02em; }
              .article h1 {
                font-family: "Songti SC", "Noto Serif CJK SC", serif;
                font-size: 2.05em; font-weight: 700; letter-spacing: 0.01em;
                line-height: 1.24; margin-bottom: 0.7em;
                border-bottom: 2.5px solid var(--ink); padding-bottom: 0.34em;
              }
              .article h2 {
                font-family: "Songti SC", "Noto Serif CJK SC", serif;
                font-size: 1.45em; font-weight: 700; margin-top: 1.9em;
                letter-spacing: 0.008em;
              }
              .article p:first-of-type::first-letter {
                float: left; font-size: 3.1em; line-height: 0.86;
                padding: 0.06em 0.1em 0 0; font-weight: 700; color: var(--accent);
              }
              .article blockquote {
                border-left: 0; padding: 0.9em 1.1em; margin: 1.5em 0;
                background: color-mix(in srgb, var(--ink) 5%, transparent);
                border-radius: 2px; font-style: italic;
              }
              .article table { font-family: var(--font-sans); font-size: 0.88em; }
              .article th { background: transparent; border-bottom: 2px solid var(--ink); }
            \`;
          } else {
            style.textContent = \`
              :root {
                --paper: #101014; --ink: #e6e3dd; --ink-soft: #a8a49c;
                --ink-faint: #6b675f; --rule: #26262e; --accent: #c98a4e;
                --fs-body: 17px; --lh-body: 1.84;
                --mark-yellow: #3f3413; --mark-green: #17301a;
                --mark-blue: #152a3c; --mark-pink: #361a26;
              }
              html, body { background: #101014; }
              .article { letter-spacing: 0.014em; }
              .article h1, .article h2, .article h3 { color: #f0ede6; }
              .article a { color: var(--accent); }
              .appbar { background: rgba(16,16,20,0.88); border-bottom-color: #26262e; }
              .appbar__title { color: #e6e3dd; }
              .btn { color: #a8a49c; }
              .article code { background: rgba(255,255,255,0.09); }
              .article pre { background: rgba(255,255,255,0.06); }
              .article th { background: rgba(255,255,255,0.05); }
            \`;
          }
        };
        return true;
      })()`,
    );

    const schemes = [
      { key: 'paper', label: '方案一 纸面极简' },
      { key: 'magazine', label: '方案二 杂志排版' },
      { key: 'dark', label: '方案三 暗色专注' },
    ];

    const produced = [];
    for (const s of schemes) {
      await evaluate(cdp, sessionId, `window.__applyScheme(${JSON.stringify(s.key)})`);
      await sleep(450);
      const file = await shot(cdp, sessionId, `m1-${s.key}`);
      produced.push({ ...s, file });
      console.log(`  ✓ ${s.label} → ${file}`);
    }

    console.log('\n三份方案已生成，请查看并选择。');
    writeFileSync(
      join(OUT, 'schemes.json'),
      JSON.stringify(produced.map((p) => ({ key: p.key, label: p.label })), null, 2),
    );
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
