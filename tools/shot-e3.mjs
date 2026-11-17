#!/usr/bin/env node
/**
 * 阶段 E3 截图（真实 Chrome，393×873，两套主题）。
 *
 * 生成 docs/screenshots/E3/：
 *   e3-backup-section-<theme>   设置页「备份与恢复」分区
 *   e3-restore-dialog-<theme>   恢复确认弹层（显示将覆盖的文档/批注数）
 *
 * 画的是真实流程：先导出（生成备份并写剪贴板），再从剪贴板恢复触发确认层。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { serveStatic } from './serve.mjs';
import { FIXTURE_DOCS } from './fixtures/docs.mjs';
import { seedDocs } from './seed-c.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'screenshots', 'E3');
const PORT = 9340;
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
      '--user-data-dir=' + join(ROOT, 'artifacts', '.chrome-e3'),
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
    await cdp.send('Browser.grantPermissions', {
      origin: new URL(server.url).origin,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });

    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
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

    await cdp.send('Page.navigate', { url: server.url }, sid);
    await sleep(1500);
    const seed = await seedDocs(cdp, sid, FIXTURE_DOCS);
    check('夹具写入', seed.docs === FIXTURE_DOCS.length, `${seed.docs} 篇`);

    for (const theme of THEMES) {
      console.log(`\n【${theme}】`);
      await setTheme(theme);
      await cdp.send('Page.navigate', { url: server.url + '#/settings' }, sid);
      await sleep(1800);

      check('备份分区存在', await evaluate(
        `!!document.querySelector('[data-testid="settings-backup-export"]')`) === true);
      await evaluate(`(() => {
        const row = document.querySelector('[data-testid="settings-backup-export"]');
        if (row) row.scrollIntoView({ block: 'center' });
        return true;
      })()`);
      await sleep(500);
      await shot(`e3-backup-section-${theme}`);

      // 导出 → 再点「从剪贴板」→ 恢复确认层（真实路径）
      await click('backup-export');
      await sleep(900);
      const toastText = await evaluate(`document.querySelector('[data-testid="toast"]')?.textContent ?? ''`);
      check('导出提示出现', toastText.includes('备份'), toastText || '(无)');
      await click('backup-import-clipboard');
      await sleep(900);
      const dialog = await evaluate(
        `[...document.querySelectorAll('[role="alertdialog"]')].length > 0
          || !!document.querySelector('[data-testid="restore-confirm"]')`);
      check('恢复确认层出现', dialog === true);
      check('确认层写明覆盖范围', await evaluate(
        `(document.body.textContent ?? '').includes('篇文档') && (document.body.textContent ?? '').includes('条批注')`) === true);
      await shot(`e3-restore-dialog-${theme}`);
      await click('restore-cancel');
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
    console.error('\n✗ 阶段 E3 截图失败：');
    for (const f of failed) console.error(`  - ${f.name}${f.detail ? `：${f.detail}` : ''}`);
    process.exit(1);
  }
  console.log('\n✓ 阶段 E3 截图完成');
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
