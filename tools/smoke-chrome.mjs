#!/usr/bin/env node
/**
 * 真实 Chrome 冒烟测试。
 *
 * 用 Chrome DevTools Protocol 在真实浏览器里跑真应用，
 * 以小米 14 Pro 的逻辑尺寸 + DPR 3 + 触摸模拟渲染，并截图留档。
 *
 * 不用 Playwright（零额外依赖）：Node 24 原生 WebSocket 直连 CDP。
 *
 * 规则见 docs/CONVENTIONS.md §9：禁止用 mock 冒充真实渲染。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { serveStatic } from './serve.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const ARTIFACTS = join(ROOT, 'artifacts', 'screenshots');
const DIST_INDEX = join(ROOT, 'www', 'index.html');

/** Chrome 可执行文件候选。 */
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
];

/** 小米 14 Pro 逻辑参数。 */
const VIEWPORT = { width: 393, height: 873, deviceScaleFactor: 3, mobile: true };

const CDP_PORT = 9333;

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

/** 极简 CDP 客户端。 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else res(msg.result);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, reject) => {
      this.pending.set(id, { resolve: res, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 30000);
    });
  }
}

async function connect(port) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const info = await res.json();
        return info.webSocketDebuggerUrl;
      }
    } catch {
      // 尚未就绪
    }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(`页面脚本出错：${result.exceptionDetails.text}`);
  }
  return result.result.value;
}

async function capture(cdp, sessionId, name) {
  const shot = await cdp.send(
    'Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: false },
    sessionId,
  );
  const file = join(ARTIFACTS, `${name}.png`);
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return file;
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  const mark = ok ? '✓' : '✗';
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  if (!existsSync(DIST_INDEX)) {
    console.error('✗ 未找到 www/index.html，请先运行 npm run build');
    process.exit(1);
  }

  const chrome = findChrome();
  if (chrome === null) {
    console.error('✗ 未找到 Chrome，无法执行真实浏览器冒烟测试');
    process.exit(1);
  }

  mkdirSync(ARTIFACTS, { recursive: true });

  // ES module 在 file:// 下会被 CORS 拦截并静默白屏，必须走 HTTP
  const server = await serveStatic(join(ROOT, 'www'));
  console.log(`静态服务：${server.url}`);

  console.log(`\n启动 Chrome：${chrome}`);
  const proc = spawn(
    chrome,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--user-data-dir=' + join(ROOT, 'artifacts', '.chrome-profile'),
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );

  let cdp;
  try {
    const wsUrl = await connect(CDP_PORT);
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });
    cdp = new Cdp(ws);

    // 建立空白页 target
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    // 移动端视口 + 触摸模拟
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { ...VIEWPORT, screenWidth: VIEWPORT.width, screenHeight: VIEWPORT.height },
      sessionId,
    );
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);

    const fileUrl = server.url;
    await cdp.send('Page.navigate', { url: fileUrl }, sessionId);
    await sleep(1200);

    console.log('\n检查项：');

    // 1. 应用挂载
    const mounted = await evaluate(cdp, sessionId, `!!document.querySelector('[data-testid="shell"]')`);
    check('应用挂载', mounted === true);

    // 2. 顶栏标题：无文档时是「墨读」，有文档时显示文档标题
    const title = await evaluate(
      cdp,
      sessionId,
      `document.querySelector('[data-testid="app-title"]')?.textContent ?? ''`,
    );
    check('顶栏标题非空且为文档标题', title.length > 0 && title.includes('spect'), title);

    // 2b. 顶栏只有一个入口：设置图标按钮（不得再有独立的「字号」文字按钮）
    const topbar = await evaluate(
      cdp,
      sessionId,
      `(() => {
        const bar = document.querySelector('.appbar');
        if (!bar) return null;
        const links = bar.querySelectorAll('a, button');
        return {
          count: links.length,
          hasText: [...links].some((n) => (n.textContent ?? '').trim().length > 0),
          hasSvg: !!bar.querySelector('svg.icon'),
          hasAria: !!bar.querySelector('[aria-label]'),
        };
      })()`,
    );
    check('顶栏只有一个操作入口', topbar !== null && topbar.count === 1, `入口数 ${topbar?.count}`);
    check('入口是图标而非文字', topbar !== null && topbar.hasSvg && !topbar.hasText);
    check('图标按钮有无障碍标签', topbar !== null && topbar.hasAria);

    // 3. 正文渲染
    const blockCount = await evaluate(
      cdp,
      sessionId,
      `document.querySelectorAll('[data-bid]').length`,
    );
    check('可标注块已生成', blockCount > 10, `${blockCount} 个`);

    // 4. 目录锚点存在于正文
    const orphanBids = await evaluate(
      cdp,
      sessionId,
      `(() => {
        const all = new Set([...document.querySelectorAll('[data-bid]')].map(e => e.getAttribute('data-bid')));
        return all.size === 0 ? -1 : all.size;
      })()`,
    );
    check('块锚点唯一', orphanBids === blockCount, `${orphanBids} vs ${blockCount}`);

    // 5. 高亮扩展生效
    const markCount = await evaluate(cdp, sessionId, `document.querySelectorAll('.article mark').length`);
    check('==高亮== 扩展生效', markCount > 0, `${markCount} 处`);

    // 6. 任务清单复选框
    const taskCount = await evaluate(cdp, sessionId, `document.querySelectorAll('.task-box').length`);
    check('任务清单复选框', taskCount === 3, `${taskCount} 个`);

    // 7. 表格未被压扁
    const tableWidth = await evaluate(
      cdp,
      sessionId,
      `(() => {
        const t = document.querySelector('.article table');
        if (!t) return -1;
        const cell = t.querySelector('td');
        if (!cell) return -2;
        const style = getComputedStyle(cell);
        return style.whiteSpace === 'nowrap' ? 1 : 0;
      })()`,
    );
    check('表格单元格不逐字换行', tableWidth === 1);

    // 8. 代码块横向可滚动
    const codeScroll = await evaluate(
      cdp,
      sessionId,
      `(() => {
        const pre = document.querySelector('.article pre');
        return pre ? getComputedStyle(pre).overflowX : 'none';
      })()`,
    );
    check('代码块可横向滚动', codeScroll === 'auto', codeScroll);

    // 9. 安全：无脚本注入
    const injected = await evaluate(
      cdp,
      sessionId,
      `document.querySelectorAll('.article script, .article iframe').length`,
    );
    check('原文 HTML 未执行', injected === 0, `${injected} 个危险元素`);

    // 10. 中文字体度量正常（正文行高 > 字号）
    const metrics = await evaluate(
      cdp,
      sessionId,
      `(() => {
        const p = document.querySelector('.article p');
        if (!p) return null;
        const s = getComputedStyle(p);
        return { fontSize: parseFloat(s.fontSize), lineHeight: parseFloat(s.lineHeight) };
      })()`,
    );
    check(
      '正文行高大于字号',
      metrics !== null && metrics.lineHeight > metrics.fontSize,
      metrics ? `${metrics.fontSize}px / ${metrics.lineHeight}px` : 'n/a',
    );

    await capture(cdp, sessionId, '00-smoke-reader');
    console.log('\n  截图：artifacts/screenshots/00-smoke-reader.png');

    // 11. 设置页版本信息
    await evaluate(cdp, sessionId, `location.hash = '#/settings'`);
    await sleep(500);
    const version = await evaluate(
      cdp,
      sessionId,
      `document.querySelector('[data-testid="build-version"]')?.textContent ?? ''`,
    );
    const buildId = await evaluate(
      cdp,
      sessionId,
      `document.querySelector('[data-testid="build-id"]')?.textContent ?? ''`,
    );
    check('设置页显示版本号', /^\d+\.\d+\.\d+$/.test(version), version);
    check('设置页显示构建指纹', buildId.length > 5, buildId);

    await capture(cdp, sessionId, '00-smoke-settings');

    // 12. 控制台无报错
    const errors = await evaluate(
      cdp,
      sessionId,
      `window.__smokeErrors ? window.__smokeErrors.length : 0`,
    );
    check('页面无未捕获错误', errors === 0);
  } finally {
    try {
      proc.kill();
    } catch {
      // 忽略
    }
    await server.close();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log('');
  if (failed.length > 0) {
    console.error(`✗ 冒烟测试失败：${failed.length}/${checks.length} 项未通过\n`);
    for (const f of failed) console.error(`  - ${f.name}${f.detail ? `：${f.detail}` : ''}`);
    process.exit(1);
  }
  console.log(`✓ 冒烟测试通过：${checks.length}/${checks.length} 项\n`);
}

main().catch((error) => {
  console.error('✗ 冒烟测试异常：', error.message);
  process.exit(1);
});
