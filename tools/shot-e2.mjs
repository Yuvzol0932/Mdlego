#!/usr/bin/env node
/**
 * 阶段 E2 截图（真实 Chrome，393×873，两套主题）。
 *
 * 生成 docs/screenshots/E2/：
 *   e2-toolbar-<theme>     选中文字后的标注工具条（四色/下划线/删除线/批注/查词/复制）
 *   e2-annotations-<theme> 正文里的黄绿高亮 + 下划线 + 批注虚线
 *   e2-note-<theme>        备注面板（含原文预览）
 *   e2-marks-list-<theme>  批注列表（类型/原文/备注/导出）
 *   e2-mark-actions-<theme> 点击已有标注的动作条（删除/编辑备注/复制）
 *
 * 选区走「程序化 Range + selectionchange」兼容路径（与 smoke 一致），
 * 因为 headless 下没有真实触摸拖选；视线与手势的实机效果不在这里断言。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { serveStatic } from './serve.mjs';
import { FIXTURE_DOCS } from './fixtures/docs.mjs';
import { seedDocs } from './seed-c.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'screenshots', 'E2');
const PORT = 9339;
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
      '--user-data-dir=' + join(ROOT, 'artifacts', '.chrome-e2'),
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
    /** 选中第 index 个段落的前 maxLen 个字符（程序化 Range + selectionchange）。 */
    const selectParagraph = async (maxLen, index = 0) => evaluate(`(() => {
      const art = document.querySelector('[data-testid="article"]');
      const ps = [...art.querySelectorAll('p[data-bid]')];
      // 从指定下标开始找第一个「有文字」的段落：夹具里有纯图片段落，不能按下标硬取
      let t = null;
      for (let i = ${index}; i < ps.length; i++) {
        const walker = document.createTreeWalker(ps[i], NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node !== null && node.data.trim().length === 0) node = walker.nextNode();
        if (node !== null) { t = node; break; }
      }
      if (!t) return 0;
      const len = Math.min(${maxLen}, t.data.length);
      const range = document.createRange();
      range.setStart(t, 0);
      range.setEnd(t, len);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return len;
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
      // 每套主题都从「没有标注」开始，截图才可比（剧本会反复跑，不能累积）
      await evaluate(`(async () => {
        const db = await new Promise((res, rej) => {
          const req = indexedDB.open('mdlego');
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        await new Promise((res, rej) => {
          const tx = db.transaction('marks', 'readwrite');
          tx.objectStore('marks').clear();
          tx.oncomplete = res;
          tx.onerror = () => rej(tx.error);
        });
        db.close();
        return true;
      })()`);
      await cdp.send('Page.navigate', { url: server.url }, sid);
      await sleep(1400);
      await click('doc-item');
      await sleep(1400);
      check('正文已渲染', (await exists('article')) === true);
      check('CSS Highlight API 可用', await evaluate(`!!(CSS.highlights && window.Highlight)`));

      await selectParagraph(14, 0);
      await sleep(400);
      check('工具条出现', (await exists('mark-toolbar')) === true);
      await shot(`e2-toolbar-${theme}`);
      await click('mark-color-yellow');
      await sleep(300);

      await selectParagraph(18, 1);
      await sleep(400);
      await click('mark-color-green');
      await sleep(300);

      await selectParagraph(16, 2);
      await sleep(400);
      const underlineClicked = await click('mark-underline');
      await sleep(300);
      const underlineRanges = await evaluate(`CSS.highlights?.get('mdlego-underline')?.size ?? 0`);
      check('下划线已绘制', underlineClicked === true && underlineRanges >= 1, `${underlineRanges} 段`);

      // 批注：选区 → 批注 → 备注面板 → 保存
      await selectParagraph(20, 3);
      await sleep(400);
      await click('mark-note');
      await sleep(500);
      check('备注面板打开', (await exists('note-sheet')) === true);
      check('备注面板显示原文预览', await evaluate(
        `(document.querySelector('[data-testid="note-quote"]')?.textContent ?? '').length > 0`,
      ));
      await shot(`e2-note-${theme}`);
      await evaluate(`(() => {
        const area = document.querySelector('[data-testid="note-input"]');
        if (!area) return false;
        area.value = '这一段值得反复读，记一下。';
        area.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await click('note-save');
      await sleep(500);

      const painted = await evaluate(`CSS.highlights?.get('mdlego-hl-yellow')?.size ?? 0`);
      check('黄色高亮已绘制', painted >= 1, `${painted} 段`);
      // 滚动到第一个高亮段落附近再截图，保证画面里能看到标注
      await evaluate(`(() => {
        const art = document.querySelector('[data-testid="article"]');
        const p = art.querySelector('p[data-bid]');
        if (p) p.scrollIntoView({ block: 'center' });
        return true;
      })()`);
      await sleep(500);
      await shot(`e2-annotations-${theme}`);

      // 点已有标注 → 动作条（坐标取自高亮段落中点）
      const point = await evaluate(`(() => {
        const art = document.querySelector('[data-testid="article"]');
        const p = art.querySelector('p[data-bid]');
        if (!p) return null;
        const rect = p.getBoundingClientRect();
        return { x: rect.left + 12, y: rect.top + rect.height / 2 };
      })()`);
      if (point !== null) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1, buttons: 1,
        }, sid);
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1, buttons: 0,
        }, sid);
        await sleep(500);
      }
      check('点击标注弹出动作条', (await exists('mark-actions')) === true);
      await shot(`e2-mark-actions-${theme}`);
      await evaluate(`document.querySelector('[data-testid="mark-actions"]')?.remove(); true`);
      await sleep(200);

      // 批注列表
      await click('reader-more');
      await sleep(400);
      await click('open-marks');
      await sleep(600);
      check('批注列表打开', (await exists('marks-sheet')) === true);
      const items = await evaluate(`document.querySelectorAll('[data-testid="mark-item"]').length`);
      check('批注列表有条目', items >= 3, `${items} 条`);
      await shot(`e2-marks-list-${theme}`);
      await click('marks-close');
      await sleep(500);
      await click('back-to-shelf');
      await sleep(700);
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
    console.error('\n✗ 阶段 E2 截图失败：');
    for (const f of failed) console.error(`  - ${f.name}${f.detail ? `：${f.detail}` : ''}`);
    process.exit(1);
  }
  console.log('\n✓ 阶段 E2 截图完成');
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
