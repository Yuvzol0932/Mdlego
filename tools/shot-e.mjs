#!/usr/bin/env node
/**
 * 阶段 E1 截图（真实 Chrome，393×873，两套主题）。
 *
 * 生成 docs/screenshots/E/：
 *   e-shelf-filters-<theme>     书架筛选条（收藏/标签/文件夹 chip）
 *   e-shelf-tag-filter-<theme>  按标签筛选后的书架
 *   e-collection-tags-<theme>   长按多选 → 标签面板
 *   e-collection-folder-<theme> 文件夹面板
 *   e-search-grouped-<theme>    全库搜索分组结果（关键词高亮）
 *
 * 数据：夹具文档 + 给其中几篇写标签/文件夹（只写 IndexedDB，不改夹具源文件）。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { serveStatic } from './serve.mjs';
import { FIXTURE_DOCS } from './fixtures/docs.mjs';
import { seedDocs } from './seed-c.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'screenshots', 'E');
const PORT = 9338;
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
const VIEWPORT = { width: 393, height: 873, deviceScaleFactor: 2, mobile: true };
const THEMES = ['warm-paper', 'warm-night'];

/** 夹具 + 标签 / 文件夹（覆盖「多标签、部分共有、多个文件夹」三种情况）。 */
function docsWithCollections() {
  const tagPlan = [
    ['考研', '词汇'],
    ['考研'],
    ['写作', '考研'],
    ['写作'],
    [],
    ['长文'],
  ];
  const folderPlan = ['备考', '备考', '写作', '写作', '笔记', null];
  return FIXTURE_DOCS.map((doc, index) => ({
    ...doc,
    tags: tagPlan[index % tagPlan.length] ?? [],
    folder: folderPlan[index % folderPlan.length] ?? null,
  }));
}

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
      '--user-data-dir=' + join(ROOT, 'artifacts', '.chrome-e'),
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
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    };
    const exists = async (testId) => evaluate(`!!document.querySelector('[data-testid="${testId}"]')`);
    const click = async (testId) => {
      for (let i = 0; i < 20; i++) {
        const ok = await evaluate(`(() => {
          const el = document.querySelector('[data-testid="${testId}"]');
          if (!el) return false;
          el.click();
          return true;
        })()`);
        if (ok === true) {
          await sleep(180);
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
    const longPress = async () => {
      await evaluate(`(() => {
        const card = document.querySelector('[data-testid="doc-item"]');
        if (!card) return false;
        const rect = card.getBoundingClientRect();
        card.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, clientX: rect.left + 12, clientY: rect.top + 12,
        }));
        return true;
      })()`);
      await sleep(700);
    };

    // IndexedDB 只在页面上下文可用：先打开应用再写夹具
    await cdp.send('Page.navigate', { url: server.url }, sid);
    await sleep(1500);
    const seed = await seedDocs(cdp, sid, docsWithCollections());
    check('夹具文档 + 标签写入 IndexedDB', seed.docs === FIXTURE_DOCS.length, `${seed.docs} 篇`);

    for (const theme of THEMES) {
      console.log(`\n【${theme}】`);
      await setTheme(theme);
      await cdp.send('Page.navigate', { url: server.url }, sid);
      await sleep(1600);

      check('筛选条存在', (await exists('shelf-filters')) === true);
      await shot(`e-shelf-filters-${theme}`);

      await click('shelf-filter-tag-0');
      await sleep(400);
      check('按标签筛选后仍有卡片', (await evaluate(
        `document.querySelectorAll('[data-testid="doc-item"]').length`,
      )) > 0);
      await shot(`e-shelf-tag-filter-${theme}`);
      await click('shelf-filter-tag-0');
      await sleep(300);

      // 长按 → 标签面板
      await longPress();
      check('长按进入多选', (await evaluate(
        `!document.querySelector('[data-testid="shelf-selectbar"]')?.hasAttribute('hidden')`,
      )) === true);
      await click('shelf-select-tag');
      await sleep(450);
      check('标签面板打开', (await exists('collection-sheet')) === true);
      await shot(`e-collection-tags-${theme}`);
      await click('collection-close');
      await sleep(500);

      // 重新长按 → 文件夹面板（多选状态在关闭面板后仍保留）
      if (!(await exists('collection-sheet'))) {
        await longPress();
      }
      await click('shelf-select-folder');
      await sleep(450);
      check('文件夹面板打开', (await exists('collection-sheet')) === true);
      await shot(`e-collection-folder-${theme}`);
      await click('collection-close');
      await sleep(500);
      await click('shelf-select-cancel');
      await sleep(400);

      // 全库搜索（分组 + 高亮）
      await click('tab-search');
      await sleep(600);
      await evaluate(`(() => {
        const input = document.querySelector('[data-testid="library-search-input"]');
        if (!input) return false;
        input.value = 'Markdown';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await sleep(900);
      check('搜索出现分组', (await evaluate(
        `document.querySelectorAll('[data-testid="library-search-group"]').length`,
      )) > 0);
      check('搜索关键词高亮', (await evaluate(`document.querySelectorAll('.search-hit mark').length`)) > 0);
      await shot(`e-search-grouped-${theme}`);

      await click('tab-shelf');
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
    console.error('\n✗ 阶段 E1 截图失败：');
    for (const f of failed) console.error(`  - ${f.name}${f.detail ? `：${f.detail}` : ''}`);
    process.exit(1);
  }
  console.log('\n✓ 阶段 E1 截图完成');
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
