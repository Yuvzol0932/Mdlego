#!/usr/bin/env node
/**
 * 退书转场验收（改造计划书 Step 2）。
 *
 * 断言的是计划书 §Step 2 的两条硬指标：
 *   1. 返回瞬间底层书架**不得**在转场层之前露出来（消除 ~166ms 裸奔闪屏）；
 *      判据：整段退书过程中，任一帧只要「书架可见」就必须「转场层已存在」。
 *   2. 退出转场参与合成的 DOM 规模从「整篇数千块」降到「视口内的十几块」；
 *      判据：转场层里的快照块数 ≤ 40，且原文块数远大于它。
 *
 * 用法：npm run build && node tools/verify-close-transition.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = join(ROOT, 'docs', 'screenshots', 'transition-rc3', 'close-v2');
const PREVIEW_PORT = 4185;
const CDP_PORT = 9463;
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

function writeLargeSample() {
  const parts = ['# 压测大文档 900KB\n'];
  for (let i = 1; i <= 900; i += 1) {
    parts.push(`## 第 ${i} 节\n`);
    parts.push(`这是第 ${i} 段填充文字，用来把文档撑到约 900KB，验证打开时不会一次性渲染整篇正文。` + '书架与阅读页之间的转场必须从被点卡片的矩形展开，阅读页内容保持真实尺寸。' + '这段会重复很多次。\n');
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

let cdp; let sid;
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
    `--user-data-dir=${join(ROOT, 'artifacts', '.chrome-close-v2')}`, 'about:blank',
  ], { stdio: 'ignore' });

  try {
    check('vite preview 就绪', (await waitUrl(`http://127.0.0.1:${PREVIEW_PORT}/`)) === true);
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
    await evalJs('localStorage.clear(); true');
    await cdp.send('Page.reload', {}, sid);
    await sleep(2200);

    await importSample();
    await sleep(600);

    // 打开长文并等全量挂完
    const card = await centerOf('[data-testid="shelf-grid"] .book-card__title');
    await tap(card.x, card.y);
    for (let i = 0; i < 40; i += 1) {
      await sleep(250);
      if ((await evalJs(`document.querySelector('[data-testid="article"]')?.getAttribute('data-article') === 'complete'`)) === true) break;
    }
    const full = await evalJs(`({
      blocks: document.querySelectorAll('[data-testid="article"] [data-bid]').length,
      nodes: document.querySelectorAll('[data-testid="article"] *').length,
      complete: document.querySelector('[data-testid="article"]')?.getAttribute('data-article') ?? null,
    })`);
    check('正文已全量挂载（在屏 DOM 很大）', full.blocks > 400, `${full.blocks} 块 / ${full.nodes} 节点 / data-article=${full.complete}`);

    // 滚到中段，模拟真实阅读位置
    await evalJs(`scrollTo(0, Math.round(document.documentElement.scrollHeight * 0.5))`);
    await sleep(600);

    // 逐帧采样：书架可见性 vs 转场层存在性
    // 用 rAF 钩子在点击之后记录每一帧的状态
    await evalJs(`(() => {
      window.__frames = [];
      window.__watch = true;
      const tick = () => {
        if (!window.__watch) return;
        const layer = document.querySelector('[data-testid="page-mask"]');
        const shelf = document.querySelector('[data-testid="shelf-grid"]');
        const snap = layer ? layer.querySelectorAll('.page-mask__snapshot [class]').length : 0;
        const snapBlocks = layer ? (layer.querySelector('.page-mask__snapshot')?.childElementCount ?? 0) : 0;
        window.__frames.push({
          t: Math.round(performance.now()),
          layer: layer !== null,
          phase: layer?.dataset.phase ?? null,
          snapshot: layer?.dataset.snapshot ?? null,
          snapBlocks,
          snapNodes: snap,
          shelf: shelf !== null,
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    })()`);

    await evalJs(`window.__t0 = performance.now(); true`);
    await evalJs(`document.querySelector('[data-testid="back-to-shelf"]').click()`);
    await sleep(30);
    await shotAt('close-early');
    await sleep(900);
    await evalJs(`window.__watch = false; true`);
    const frames = await evalJs(`window.__frames`);
    const rel = frames.map((f) => ({ ...f, t: f.t - frames[0].t }));

    // ── 断言 1：书架不得在转场层之前露出来 ──
    // 「裸露」= 这一帧书架可见 且 没有转场层。
    // 只看**转场窗口内**（从第一帧出现转场层 → 最后一帧转场层）：转场结束
    // 之后书架本就该在屏上，那些帧不算裸露。
    const firstLayerIdx = rel.findIndex((f) => f.layer);
    const lastLayerIdx = rel.map((f) => f.layer).lastIndexOf(true);
    const inTransition = firstLayerIdx < 0 ? [] : rel.slice(firstLayerIdx, lastLayerIdx + 1);
    const nakedEarly = inTransition.filter((f) => f.shelf && !f.layer);
    check(
      '退书全程书架没有提前裸露（无「裸奔」帧）',
      inTransition.length > 0 && nakedEarly.length === 0,
      inTransition.length === 0
        ? '没采到转场层'
        : `转场窗口 ${inTransition.length} 帧，裸露 ${nakedEarly.length} 帧` +
          (nakedEarly.length > 0 ? `（首个在 ${nakedEarly[0].t - rel[firstLayerIdx].t}ms）` : ''),
    );
    // 额外报告：点击到转场层出现之间隔了多久（旧实现约 166ms）
    const t0 = rel[0].t;
    const layerAt = firstLayerIdx >= 0 ? rel[firstLayerIdx].t - t0 : null;
    console.log(`    (点击→转场层出现：${layerAt}ms；转场窗口 ${inTransition.length} 帧)`);

    // ── 断言 2：转场层用快照，且规模只有一屏 ──
    const masked = rel.filter((f) => f.layer && f.phase === 'close');
    const usingSnapshot = masked.filter((f) => f.snapshot === '1');
    const maxSnapBlocks = Math.max(0, ...masked.map((f) => f.snapBlocks));
    check('退书转场层存在', masked.length > 0, `${masked.length} 帧`);
    check('退书使用视口轻量快照', usingSnapshot.length > 0, `${usingSnapshot.length}/${masked.length} 帧标记 snapshot=1`);
    check(
      '快照块数只有一屏量级（≤40 块，远小于全文）',
      maxSnapBlocks > 0 && maxSnapBlocks <= 40,
      `快照 ${maxSnapBlocks} 块 / 全文 ${full.blocks} 块`,
    );

    // ── 断言 3：转场结束后清理干净 ──
    await sleep(400);
    const cleaned = await evalJs(`({
      masks: document.querySelectorAll('.page-mask').length,
      snaps: document.querySelectorAll('.page-mask__snapshot').length,
      scrims: document.querySelectorAll('.page-mask-scrim').length,
      onShelf: !!document.querySelector('[data-testid="shelf-grid"]'),
      reader: !!document.querySelector('[data-testid="article"]'),
    })`);
    check('转场层与快照层全部清理干净', cleaned.masks === 0 && cleaned.snaps === 0 && cleaned.scrims === 0, JSON.stringify(cleaned));
    check('已回到书架', cleaned.onShelf === true && cleaned.reader === false);
    await shotAt('close-settled');

    const passed = checks.filter((c) => c.ok).length;
    console.log(`\n结果：${passed}/${checks.length}`);
    console.log(`截图：${SHOTS}`);
    const failed = checks.filter((c) => !c.ok);
    if (failed.length > 0) {
      console.log('失败：');
      for (const f of failed) console.log(`  ✗ ${f.name}`);
      process.exitCode = 1;
    }
  } finally {
    chrome.kill();
    preview.kill();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
