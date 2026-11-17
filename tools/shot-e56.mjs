#!/usr/bin/env node
/**
 * 阶段 E5/E6 截图（真实 Chrome，393×873，两套主题）。
 *
 * 生成 docs/screenshots/E56/：
 *   e56-editor-<theme>        编辑器（编辑态）
 *   e56-preview-<theme>       实时预览
 *   e56-save-dialog-<theme>   无原文件时的保存方式选择
 *   e56-reader-eyecare-<theme> 护眼模式下的阅读页
 *   e56-tts-<theme>           朗读播放条
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { serveStatic } from './serve.mjs';
import { FIXTURE_DOCS } from './fixtures/docs.mjs';
import { seedDocs } from './seed-c.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'screenshots', 'E56');
const PORT = 9342;
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
const VIEWPORT = { width: 393, height: 873, deviceScaleFactor: 2, mobile: true };
const THEMES = ['warm-paper', 'warm-night'];

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
  throw new Error('Chrome 未就绪');
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

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
      '--user-data-dir=' + join(ROOT, 'artifacts', '.chrome-e56'),
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    const ws = new WebSocket(await connectWs(PORT));
    await new Promise((r, j) => {
      ws.addEventListener('open', r, { once: true });
      ws.addEventListener('error', () => j(new Error('ws fail')), { once: true });
    });
    const cdp = new Cdp(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Runtime.enable', {}, sid);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      ...VIEWPORT,
      screenWidth: VIEWPORT.width,
      screenHeight: VIEWPORT.height,
    }, sid);

    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'page error');
      return r.result.value;
    };
    const click = async (testId) => {
      for (let i = 0; i < 20; i++) {
        const ok = await evaluate(`(() => {
          const el = document.querySelector('[data-testid="${testId}"]');
          if (!el) return false;
          el.click();
          return true;
        })()`);
        if (ok === true) {
          await sleep(220);
          return true;
        }
        await sleep(120);
      }
      return false;
    };
    const shot = async (name) => {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
      writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
      console.log(`  📸 ${name}.png`);
    };
    const setTheme = async (theme) => {
      await evaluate(`(() => {
        const raw = localStorage.getItem('mdlego:settings');
        const env = raw ? JSON.parse(raw) : { schemaVersion: 5, settings: {} };
        env.schemaVersion = 5;
        env.settings = Object.assign({}, env.settings, { theme: ${JSON.stringify(theme)} });
        localStorage.setItem('mdlego:settings', JSON.stringify(env));
        return true;
      })()`);
    };
    /** 优先打开没有内联 base64 图片的文档，截图更干净（夹具里 Markdown 进阶指南带长图）。 */
    const openDoc = async (fragment) => {
      await evaluate(`location.hash = '#/'; true`);
      await sleep(700);
      const opened = await evaluate(`(() => {
        const cards = [...document.querySelectorAll('[data-testid="doc-item"]')];
        const target = cards.find((card) => card.textContent.includes(${JSON.stringify(fragment)})) ?? cards[0];
        if (!target) return false;
        target.click();
        return true;
      })()`);
      await sleep(1200);
      return opened;
    };

    await cdp.send('Page.navigate', { url: server.url }, sid);
    await sleep(1500);
    const seed = await seedDocs(cdp, sid, FIXTURE_DOCS);
    check('夹具写入', seed.docs === FIXTURE_DOCS.length, `${seed.docs} 篇`);

    for (const theme of THEMES) {
      console.log(`\n【${theme}】`);
      await setTheme(theme);
      await cdp.send('Page.navigate', { url: server.url }, sid);
      await sleep(1600);

      // 编辑器 / 预览 / 保存方式
      await openDoc('技术写作指南');
      await click('reader-more');
      await sleep(400);
      await click('open-editor');
      await sleep(900);
      check('编辑器打开', await evaluate(
        `!!document.querySelector('[data-testid="editor-page"]')`) === true);
      await shot(`e56-editor-${theme}`);

      await evaluate(`(() => {
        const input = document.querySelector('[data-testid="editor-input"]');
        if (!input) return false;
        input.value += '\\\\n\\\\n## 新增一节\\n\\n这是编辑后的内容，用来演示实时预览。';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await click('editor-tab-preview');
      await sleep(700);
      check('预览显示新内容', await evaluate(
        `(document.querySelector('[data-testid="editor-preview"]')?.textContent ?? '').includes('新增一节')`) === true);
      await shot(`e56-preview-${theme}`);

      await click('editor-save');
      await sleep(900);
      check('保存方式弹层出现', await evaluate(
        `!!document.querySelector('[data-testid="editor-save-copy"]')`) === true);
      await shot(`e56-save-dialog-${theme}`);
      await click('editor-save-cancel');
      await sleep(400);
      await evaluate(`location.hash = '#/'; true`);
      await sleep(700);

      // 护眼模式（设置里开 → 回阅读页截图 → 关）
      await evaluate(`location.hash = '#/settings'; true`);
      await sleep(900);
      await click('eye-care-switch');
      await sleep(500);
      check('护眼属性生效', await evaluate(
        `document.documentElement.getAttribute('data-eyecare') === '1'`) === true);
      await openDoc('技术写作指南');
      await sleep(600);
      await shot(`e56-reader-eyecare-${theme}`);
      await evaluate(`location.hash = '#/settings'; true`);
      await sleep(800);
      await click('eye-care-switch');
      await sleep(400);

      // 朗读播放条
      await openDoc('技术写作指南');
      await click('reader-more');
      await sleep(400);
      await click('reader-tts');
      await sleep(1200);
      check('朗读播放条出现', await evaluate(
        `!!document.querySelector('[data-testid="tts-bar"]')`) === true);
      await shot(`e56-tts-${theme}`);
      await evaluate(`(() => {
        const stop = document.querySelector('[data-testid="tts-stop"]');
        if (stop) stop.click();
        return true;
      })()`);
      await sleep(400);
      await evaluate(`document.querySelector('[data-testid="menu-panel"]')?.remove(); true`);
    }
  } finally {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    await server.close();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log('\n────────────────────────────');
  console.log(`断言：通过 ${checks.length - failed.length} 项 · 失败 ${failed.length} 项`);
  console.log(`截图目录：${OUT}`);
  if (failed.length > 0) {
    console.error('\n✗ 阶段 E5/E6 截图失败：');
    for (const f of failed) console.error(`  - ${f.name}${f.detail ? `：${f.detail}` : ''}`);
    process.exit(1);
  }
  console.log('\n✓ 阶段 E5/E6 截图完成');
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
