#!/usr/bin/env node
/**
 * 阶段 E4 截图（真实 Chrome，393×873，两套主题）。
 *
 * 生成 docs/screenshots/E4/：
 *   e4-lookup-card-<theme>  玻璃底查词卡片（含音标/释义/生词本按钮）
 *   e4-wordbook-<theme>     生词本分段（收藏的单词）
 *   e4-history-<theme>      查词历史分段
 *
 * 每套主题开始前清空 meta 里的生词本/历史，截图可比、不累积。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { serveStatic } from './serve.mjs';
import { FIXTURE_DOCS } from './fixtures/docs.mjs';
import { seedDocs } from './seed-c.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'screenshots', 'E4');
const PORT = 9341;
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
const VIEWPORT = { width: 393, height: 873, deviceScaleFactor: 2, mobile: true };
const THEMES = ['warm-paper', 'warm-night'];
/** 夹具正文里能找到、且词库有合理释义的候选词。 */
const WORD_CANDIDATES = ['design', 'reading', 'method', 'progress', 'theme', 'material'];

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
      '--user-data-dir=' + join(ROOT, 'artifacts', '.chrome-e4'),
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
          await sleep(200);
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
        const env = raw ? JSON.parse(raw) : { schemaVersion: 4, settings: {} };
        env.schemaVersion = 4;
        env.settings = Object.assign({}, env.settings, { theme: ${JSON.stringify(theme)} });
        localStorage.setItem('mdlego:settings', JSON.stringify(env));
        return true;
      })()`);
    };
    /** 清空 meta 里的生词本/历史，保证两套主题截图一致。 */
    const clearVocabulary = async () => {
      await evaluate(`(async () => {
        const db = await new Promise((res, rej) => {
          const req = indexedDB.open('mdlego');
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        await new Promise((res, rej) => {
          const tx = db.transaction('meta', 'readwrite');
          const store = tx.objectStore('meta');
          store.delete('wordbook');
          store.delete('lookupHistory');
          tx.oncomplete = res;
          tx.onerror = () => rej(tx.error);
        });
        return true;
      })()`);
    };
    const selectCandidateWord = async () => evaluate(`(() => {
      const words = ${JSON.stringify(WORD_CANDIDATES)};
      const art = document.querySelector('[data-testid="article"]');
      if (!art) return null;
      const walker = document.createTreeWalker(art, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const lower = node.data.toLowerCase();
        for (const word of words) {
          const at = lower.indexOf(word);
          if (at >= 0) {
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + word.length);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            document.dispatchEvent(new Event('selectionchange'));
            return word;
          }
        }
      }
      return null;
    })()`);

    await cdp.send('Page.navigate', { url: server.url }, sid);
    await sleep(1500);
    const seed = await seedDocs(cdp, sid, FIXTURE_DOCS);
    check('夹具写入', seed.docs === FIXTURE_DOCS.length, `${seed.docs} 篇`);

    for (const theme of THEMES) {
      console.log(`\n【${theme}】`);
      await setTheme(theme);
      await cdp.send('Page.navigate', { url: server.url }, sid);
      await sleep(1600);
      await clearVocabulary();
      await cdp.send('Page.navigate', { url: server.url }, sid);
      await sleep(1400);
      await click('doc-item');
      await sleep(1300);

      const word = await selectCandidateWord();
      check('选中可查词的单词', typeof word === 'string', word ?? '(没找到)');
      await sleep(450);
      await click('mark-lookup');
      await sleep(1300);
      check('查词卡片打开', await evaluate(
        `!!document.querySelector('[data-testid="lookup-card"]')`) === true);
      check('卡片有释义', await evaluate(
        `(document.querySelector('[data-testid="lookup-translation"]')?.textContent ?? '').length > 0`) === true);
      await shot(`e4-lookup-card-${theme}`);

      await click('lookup-save-word');
      await sleep(500);
      await click('lookup-close');
      await sleep(500);

      await evaluate(`location.hash = '#/settings'; true`);
      await sleep(900);
      await click('settings-wordbook-open');
      await sleep(800);
      check('生词本面板打开', await evaluate(
        `!!document.querySelector('[data-testid="wordbook-sheet"]')`) === true);
      check('生词本有条目', await evaluate(
        `document.querySelectorAll('[data-testid="wordbook-item"]').length >= 1`) === true);
      await shot(`e4-wordbook-${theme}`);
      await click('wordbook-tab-history');
      await sleep(500);
      check('查词历史有条目', await evaluate(
        `document.querySelectorAll('[data-testid="history-item"]').length >= 1`) === true);
      await shot(`e4-history-${theme}`);
      await click('wordbook-close');
      await sleep(500);
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
    console.error('\n✗ 阶段 E4 截图失败：');
    for (const f of failed) console.error(`  - ${f.name}${f.detail ? `：${f.detail}` : ''}`);
    process.exit(1);
  }
  console.log('\n✓ 阶段 E4 截图完成');
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
