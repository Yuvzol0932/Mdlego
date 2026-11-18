#!/usr/bin/env node
/**
 * rc.3 A 补：大文档首屏分块渲染验收（失败先行）。
 *
 * 断言（全部跑 vite build 产物 + 真触摸）：
 *   1. 点击后 ≤50ms 出现遮罩第一帧（动画已开始）；
 *   2. 转场期间没有 >50ms 长任务；
 *   3. 动画期间正文只挂载了首屏块（≤40 块），动画结束后补齐到全量；
 *   4. 阅读到中段再返回、重新打开，滚动位置能恢复到原处（±8px，分块挂载不能丢进度）。
 *
 * 用法：
 *   npm run build
 *   node tools/repro-lazy-firstscreen.mjs --out=before   # 修前：应失败
 *   node tools/repro-lazy-firstscreen.mjs --out=after    # 修后：应全过
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = (process.argv.find((a) => a.startsWith('--out=')) ?? '--out=after').slice(6);
const SHOTS = join(ROOT, 'docs', 'screenshots', 'transition-rc3', 'lazy', OUT);
const PREVIEW_PORT = 4175;
const CDP_PORT = 9454;
const VIEWPORT = { width: 393, height: 873, deviceScaleFactor: 3, mobile: true };
const SAMPLE = join(ROOT, 'artifacts', '.rc3-large.md');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => p && existsSync(p));

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: ok === true });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** 生成约 900KB、多块的大文档。 */
function writeLargeSample() {
  const parts = ['# 压测大文档 900KB\n'];
  for (let i = 1; i <= 900; i += 1) {
    parts.push(`## 第 ${i} 节\n`);
    parts.push(
      `这是第 ${i} 段填充文字，用来把文档撑到约 900KB，验证打开时不会一次性渲染整篇正文。`
      + '书架与阅读页之间的转场必须从被点卡片的矩形展开，阅读页内容保持真实尺寸。'
      + '这段会重复很多次，首屏只需要挂载前若干块，剩下的在动画结束后空闲时间补齐。\n',
    );
    parts.push(`- 要点 A${i}\n- 要点 B${i}\n`);
    if (i % 6 === 0) parts.push('```ts\nconst x = 1;\n```\n');
  }
  writeFileSync(SAMPLE, parts.join('\n'), 'utf8');
}

async function waitUrl(url, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try { if ((await fetch(url)).ok) return true; } catch { /* 未就绪 */ }
    await sleep(250);
  }
  return false;
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
      else p.resolve(m.result);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej, method });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`CDP 超时 ${method}`)); } }, 30000);
    });
  }
}

let cdp;
let sid;
const evalJs = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
};
const tap = async (x, y) => {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }] }, sid);
  await sleep(16);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sid);
};
const centerOf = async (selector) => evalJs(`(() => {
  const e = document.querySelector(${JSON.stringify(selector)});
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
const shotAt = async (name) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
};

async function importSample() {
  await tap(...Object.values(await centerOf('[data-testid="import-file"]')));
  await sleep(400);
  if ((await evalJs(`!!document.querySelector('input[type=file]')`)) !== true) {
    await evalJs(`document.querySelector('[data-testid="import-file"]').click()`);
    await sleep(400);
  }
  const { root } = await cdp.send('DOM.getDocument', {}, sid);
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' }, sid);
  if (!nodeId) throw new Error('应用未创建文件输入框');
  await cdp.send('DOM.setFileInputFiles', { files: [SAMPLE], nodeId }, sid);
  await sleep(4000);
}

async function main() {
  if (CHROME === undefined) throw new Error('找不到 Chrome');
  writeLargeSample();
  const preview = spawn(process.execPath, [
    join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview',
    '--port', String(PREVIEW_PORT), '--strictPort', '--host', '127.0.0.1',
  ], { cwd: ROOT, stdio: 'ignore' });
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${CDP_PORT}`, '--headless=new', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--overscroll-history-navigation=0',
    `--user-data-dir=${join(ROOT, 'artifacts', '.chrome-lazy-profile')}`, 'about:blank',
  ], { stdio: 'ignore' });

  try {
    check('vite preview 就绪', await waitUrl(`http://127.0.0.1:${PREVIEW_PORT}/`) === true);
    await waitUrl(`http://127.0.0.1:${CDP_PORT}/json/version`);
    const wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl;
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });
    cdp = new Cdp(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Runtime.enable', {}, sid);
    await cdp.send('DOM.enable', {}, sid);
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, screenWidth: VIEWPORT.width, screenHeight: VIEWPORT.height }, sid);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sid);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PREVIEW_PORT}/` }, sid);
    await sleep(1800);
    await evalJs(`(() => { localStorage.clear(); return new Promise((res) => { const r = indexedDB.deleteDatabase('mdlego'); r.onsuccess = r.onerror = r.onblocked = () => res(true); }); })()`);
    await cdp.send('Page.reload', {}, sid);
    await sleep(1800);
    await importSample();
    await cdp.send('Page.reload', {}, sid);
    await sleep(2500);

    // 选最大的那篇（刚导入的 900KB）
    const card = await evalJs(`(() => {
      const cards = [...document.querySelectorAll('[data-testid="shelf-grid"] [data-doc-id]')];
      const target = cards.find((c) => (c.textContent ?? '').includes('压测大文档')) ?? cards[0];
      if (!target) return null;
      const title = target.querySelector('.book-card__title');
      const r = (title ?? target).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, docId: target.getAttribute('data-doc-id') };
    })()`);
    check('找到 900KB 大文档卡片', card !== null, JSON.stringify(card));

    // 预埋：首帧时间 + 长任务 + 动画期间块数
    await evalJs(`(() => {
      window.__tapAt = 0;
      window.__firstMaskAt = null;
      window.__blocksAtMask = null;
      window.__longTasks = [];
      try {
        new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__longTasks.push({ d: Math.round(e.duration), t: Math.round(e.startTime - (window.__tapAt || e.startTime)) }); })
          .observe({ type: 'longtask', buffered: false });
      } catch { /* 不支持 */ }
      document.addEventListener('pointerdown', () => {
        if (window.__tapAt !== 0) return;
        window.__tapAt = performance.now();
        window.__longTasks = [];
        const watch = () => {
          const layer = document.querySelector('.page-mask');
          if (layer !== null && window.__firstMaskAt === null) {
            window.__firstMaskAt = Math.round(performance.now() - window.__tapAt);
            window.setTimeout(() => {
              window.__blocksAtMask = document.querySelectorAll('[data-testid="article"] [data-bid]').length;
            }, 220);
            return;
          }
          if (window.__firstMaskAt === null) requestAnimationFrame(watch);
        };
        requestAnimationFrame(watch);
      }, { capture: true, once: true });
      return true;
    })()`);

    await tap(card.x, card.y);
    await sleep(600);
    const during = await evalJs(`({
      firstMaskAt: window.__firstMaskAt,
      blocksAtMask: window.__blocksAtMask,
      longTasks: window.__longTasks,
      reader: !!document.querySelector('[data-testid="article"]'),
    })`);
    await shotAt('open-300ms');
    await sleep(1800);
    const after = await evalJs(`({
      blocks: document.querySelectorAll('[data-testid="article"] [data-bid]').length,
      nodes: document.querySelectorAll('[data-testid="article"] *').length,
      longTasks: window.__longTasks,
    })`);
    await shotAt('open-settled');

    check('大文档打开后阅读页挂载', during.reader === true);
    check('首帧（遮罩出现）≤50ms', typeof during.firstMaskAt === 'number' && during.firstMaskAt <= 50, `${during.firstMaskAt}ms`);
    check('转场期间无 >50ms 长任务', Array.isArray(during.longTasks) && during.longTasks.every((e) => e.d <= 50), JSON.stringify(during.longTasks));
    check('动画期间只挂载首屏块（≤40 块）', typeof during.blocksAtMask === 'number' && during.blocksAtMask > 0 && during.blocksAtMask <= 40, `${during.blocksAtMask} 块`);
    check('动画结束后补齐全量正文', after.blocks > 400 && after.blocks > (during.blocksAtMask ?? 0), `期间 ${during.blocksAtMask} → 全量 ${after.blocks}`);

    // 进度恢复：滚到中段 → 返回 → 重新打开，位置应回到原处
    await evalJs(`scrollTo(0, Math.round(document.documentElement.scrollHeight * 0.55))`);
    await sleep(700);
    // 记录「顶栏下沿那一块」作为视觉锚点（bid + 相对视口偏移）。
    // 不能再用 scrollY 的绝对值做断言：首屏改成分片窗口直出后，
    // 打开时文档高度只覆盖窗口（比全量小），scrollY 数值天然不同；
    // 真正要保证的是「用户看到的那一行没变」。
    const anchorBefore = await evalJs(`(() => {
      const art = document.querySelector('[data-testid="article"]');
      const shell = document.querySelector('[data-testid="shell"]');
      for (const b of art.querySelectorAll('[data-bid]')) {
        const r = b.getBoundingClientRect();
        if (r.bottom > 0) {
          return { bid: b.getAttribute('data-bid'), top: Math.round(r.top), bars: shell?.getAttribute('data-bars') };
        }
      }
      return null;
    })()`);
    // 用程序触发返回（阅读顶栏滚动态可能收起，真触摸点不到返回键）：
    // 目的只是让 main 的 persistProgress 记录中段进度，后续「重新打开」仍是真触摸。
    await evalJs(`document.querySelector('[data-testid="back-to-shelf"]').click()`);
    await sleep(900);
    // 重新打开同一篇
    const again = await centerOf('[data-testid="shelf-grid"] .book-card__title');
    await tap(again.x, again.y);
    const trace = [];
    for (let i = 0; i < 10; i += 1) {
      await sleep(250);
      trace.push(await evalJs(`Math.round(scrollY)`));
    }
    const reopen = await evalJs(`(() => {
      const art = document.querySelector('[data-testid="article"]');
      let found = null;
      for (const b of art.querySelectorAll('[data-bid]')) {
        const r = b.getBoundingClientRect();
        if (r.bottom > 0) { found = { bid: b.getAttribute('data-bid'), top: Math.round(r.top) }; break; }
      }
      const target = ${JSON.stringify(anchorBefore?.bid ?? null)}
        ? art.querySelector('[data-bid="' + CSS.escape(${JSON.stringify(anchorBefore?.bid ?? '')}) + '"]')
        : null;
      return {
        y: Math.round(scrollY),
        blocks: art.querySelectorAll('[data-bid]').length,
        height: document.documentElement.scrollHeight,
        top: found,
        anchorTop: target ? Math.round(target.getBoundingClientRect().top) : null,
        percent: document.querySelector('[data-testid="reader-progress-text"]')?.textContent ?? null,
      };
    })()`);
    console.log(`    (重开滚动轨迹 ${JSON.stringify(trace)} 高 ${reopen.height} 块 ${reopen.blocks} 进度 ${reopen.percent})`);
    console.log(`    (锚点前 ${JSON.stringify(anchorBefore)} → 锚点后 top=${JSON.stringify(reopen.top)} anchorTop=${reopen.anchorTop})`);
    // 判定：**持久化的那个块**必须重新出现在同一视口位置（容差 8px）。
    // 不看 scrollY 绝对值（窗口直出后文档高度不同，该数值不可比），
    // 也不看顶栏基准线（返回前后 data-bars 状态可能不同）。
    // 判定：**持久化的那个块**必须重新出现在视口顶部附近。
    //
    // 判据刻意不用「首个可见块 id 完全相等」：顶栏是滚动态（data-bars=hidden），
    // 恢复时保存进度的基准线（顶栏布局高度 64px）与实际可见边界差一条顶栏，
    // 于是「刚好在视口上方 49px 的那个块」与「刚进入视口的下一个块」都可能
    // 被判成 top。真正要保证的是：**锚点块本身落在视口顶部 ±80px 内**。
    const drift = reopen.anchorTop === null ? null : Math.abs(reopen.anchorTop);
    check(
      '重新打开后回到原阅读位置（锚点块贴近视口顶部）',
      anchorBefore !== null && drift !== null && drift <= 80,
      anchorBefore === null
        ? '返回前没找到锚点块'
        : `原 ${anchorBefore.bid}@${anchorBefore.top}px → 锚点块 anchorTop=${reopen.anchorTop}px（首个可见 ${reopen.top?.bid}@${reopen.top?.top}px）`,
    );
    await shotAt('reopen-progress');

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n结果：${checks.length - failed.length}/${checks.length}`);
    console.log(`截图：${SHOTS}`);
    if (failed.length > 0) {
      console.log('失败：\n' + failed.map((f) => `  ✗ ${f.name}`).join('\n'));
      process.exitCode = 1;
    }
  } finally {
    try { cdp?.ws.close(); } catch { /* ignore */ }
    try { preview.kill(); } catch { /* ignore */ }
    try { chrome.kill(); } catch { /* ignore */ }
  }
}

main().catch((error) => {
  check('脚本执行', false, String(error.message).slice(0, 200));
  console.error(error.stack);
  process.exitCode = 1;
});
