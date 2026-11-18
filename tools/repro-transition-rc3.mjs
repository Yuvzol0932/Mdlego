#!/usr/bin/env node
/**
 * rc.3 A：书架 ⇄ 阅读页遮罩转场的验收脚本。
 *
 * 全部跑 `vite build` 产物（vite preview 提供），真触摸（CDP Input.dispatchTouchEvent），
 * 打开/关闭各在 0/60/120/180/240/300ms 抓帧，并在动画中读 clip 几何。
 *
 * 用法：
 *   npm run build
 *   node tools/repro-transition-rc3.mjs --out=after
 *
 * 修前证据：--out=before（旧 View Transition 版本会失败在「无 view-transition-name」等断言）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = (process.argv.find((a) => a.startsWith('--out=')) ?? '--out=after').slice(6);
const SHOTS = join(ROOT, 'docs', 'screenshots', 'transition-rc3', OUT);
const PREVIEW_PORT = 4174;
const CDP_PORT = 9453;
const VIEWPORT = { width: 393, height: 873, deviceScaleFactor: 3, mobile: true };
const SAMPLE = join(ROOT, 'artifacts', '.rc3-sample.md');
const SAMPLE_TEXT = `# 遮罩转场样张

用来验证「从卡片矩形展开」的阅读页转场。段落写长一点，保证阅读页可以滚动。

## 第一节

阅读是为了遇见更大的世界。书架与阅读页之间的转场必须从被点卡片的位置展开，
而不是两张封面同时在屏幕上飞。

第二段继续填充文字，让正文高度超过一屏，便于验证打开后滚动位置正确。

> It is the interaction between the two that gives rise to the phenomenon.

## 第二节

- [x] 转场期间不能出现重复封面
- [ ] 关闭时缩回当前书架里的卡片

\`\`\`ts
const surface = 'mask';
\`\`\`

## 第三节

最后一段用于验证关闭目标矩形在阅读后（文档被排到最前）仍能重新测量到。
`;

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

async function waitUrl(url, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try { if ((await fetch(url)).ok) return true; } catch { /* 未就绪 */ }
    await sleep(250);
  }
  return false;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.onEvent = null;
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id === undefined) { this.onEvent?.(m); return; }
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
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`CDP 超时：${method}`)); }
      }, 20000);
    });
  }
}

let cdp;
let sid;
const shotAt = async (name) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
};
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

/** 动画期间密集合成状态：layer 的 clip、behind 图层、卡片矩形。 */
const MASK_PROBE = `(() => {
  const layer = document.querySelector('.page-mask');
  const behind = document.querySelector('.page-mask-behind');
  const card = document.querySelector('[data-testid="shelf-grid"] [data-doc-id]');
  const cs = layer ? getComputedStyle(layer) : null;
  return {
    hasLayer: layer !== null,
    hasBehind: behind !== null,
    clip: cs ? cs.clipPath : null,
    from: layer?.dataset.maskFrom ?? null,
    to: layer?.dataset.maskTo ?? null,
    phase: layer?.dataset.phase ?? null,
    scrollTop: layer ? Math.round(layer.scrollTop) : -1,
    card: card ? (() => { const r = card.getBoundingClientRect(); return { top: r.top, right: r.right, bottom: r.bottom, left: r.left }; })() : null,
    vtNames: [...document.querySelectorAll('*')].filter((el) => {
      if (el === document.documentElement) return false; // 根元素默认 name 是 root，浏览器行为
      const v = getComputedStyle(el).viewTransitionName;
      return v && v !== 'none';
    }).map((el) => String(el.className || el.tagName) + ':' + getComputedStyle(el).viewTransitionName),
    articleNodes: document.querySelectorAll('[data-testid="article"] *').length,

  };
})()`;

/** 解析 inset(top right bottom left round R) 里的四个 px。 */
function parseInset(clip) {
  const m = /inset\(\s*([\d.]+)px\s+([\d.]+)px\s+([\d.]+)px\s+([\d.]+)px/.exec(clip ?? '');
  return m ? { top: +m[1], right: +m[2], bottom: +m[3], left: +m[4] } : null;
}
/** clip inset 反推视口矩形（vw/vh 由 CSS 变量传入）。 */
function clipToRect(clip, vw, vh) {
  const p = parseInset(clip);
  if (!p) return null;
  return { top: p.top, right: vw - p.right, bottom: vh - p.bottom, left: p.left };
}
const near = (a, b, tol = 2) => a !== null && b !== null
  && Math.abs(a.top - b.top) <= tol && Math.abs(a.right - b.right) <= tol
  && Math.abs(a.bottom - b.bottom) <= tol && Math.abs(a.left - b.left) <= tol;



/**
 * 用 CDP screencast 抓一段连续帧（比逐帧 captureScreenshot 快几个数量级，
 * 时间戳来自渲染器，能真正对上 0/60/120/… 这些采样点）。
 * 返回 {frames:[{target, ts, file}], firstTs}。
 */
async function captureScreencast(prefix, targets, action, totalMs) {
  const collected = [];
  cdp.onEvent = (event) => {
    if (event.method !== 'Page.screencastFrame') return;
    const p = event.params;
    collected.push({ ts: p.metadata.timestamp, data: p.data });
    void cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sid).catch(() => undefined);
  };
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 }, sid);
  const started = Date.now();
  await action();
  while (Date.now() - started < totalMs) await sleep(20);
  await cdp.send('Page.stopScreencast', {}, sid);
  cdp.onEvent = null;
  if (collected.length === 0) return { frames: [] };
  const firstTs = collected[0].ts;
  const frames = [];
  for (const target of targets) {
    let best = collected[0];
    let bestDelta = Infinity;
    for (const frame of collected) {
      const offset = (frame.ts - firstTs) * 1000;
      const delta = Math.abs(offset - target);
      if (delta < bestDelta) { bestDelta = delta; best = frame; }
    }
    const offset = (best.ts - firstTs) * 1000;
    const file = join(SHOTS, `${prefix}-${String(target).padStart(3, '0')}ms.png`);
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(file, Buffer.from(best.data, 'base64'));
    frames.push({ target, actualMs: Math.round(offset), file: `${prefix}-${String(target).padStart(3, '0')}ms.png` });
  }
  return { frames, captured: collected.length };
}

/** headless Chrome：遮罩转场后 CDP 输入坐标换算会漂，重设一次 emulation 即可。 */
async function resetEmulation() {
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, screenWidth: VIEWPORT.width, screenHeight: VIEWPORT.height }, sid);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sid);
  await sleep(120);
}

/** 回到书架（真触摸优先；阅读页顶栏被隐藏时先把页面滚回顶部）。 */
async function backToShelf() {
  await resetEmulation();
  for (let i = 0; i < 5; i += 1) {
    if ((await evalJs(`!!document.querySelector('[data-testid="tabbar"]')`)) === true) return true;
    await resetEmulation();
    await evalJs(`scrollTo(0, 0); window.dispatchEvent(new Event('scroll')); true`);
    await sleep(350);
    const c = await centerOf('[data-testid="back-to-shelf"]');
    if (c !== null) await tap(c.x, c.y);
    await sleep(650);
  }
  // 触摸多次没回书架时，用程序触发兜底（仅用于继续取景，不作为触摸证据）
  await evalJs(`(() => {
    const back = document.querySelector('[data-testid="back-to-shelf"]');
    if (back) { back.click(); return true; }
    const tab = document.querySelector('[data-testid="tab-shelf"]');
    if (tab) { tab.click(); return true; }
    return false;
  })()`);
  await sleep(800);
  return (await evalJs(`!!document.querySelector('[data-testid="tabbar"]')`)) === true;
}

/** 从书架打开第一本书（真触摸），并确认阅读页已挂载。 */
async function openFromGrid() {
  await backToShelf();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await resetEmulation();
    const c = await centerOf('[data-testid="shelf-grid"] .book-card__title');
    if (c === null) throw new Error('书架没有网格卡片标题');
    await tap(c.x, c.y);
    await sleep(1000);
    if ((await evalJs(`!!document.querySelector('[data-testid="article"]')`)) === true) return;
    await sleep(200);
  }
  // headless 下遮罩收尾后 CDP 坐标换算偶发漂移（harness 限制，已记录）；
  // 兜底用程序触发，只用于后续取景，不作为触摸证据。
  await evalJs(`document.querySelector('[data-testid="shelf-grid"] .book-card__title').click()`);
  await sleep(900);
  if ((await evalJs(`!!document.querySelector('[data-testid="article"]')`)) !== true) {
    throw new Error('阅读页没有打开');
  }
  console.log('    (openFromGrid 触摸 3 次未生效，改用程序触发；该步不作为触摸证据)');
}

async function importSample() {
  await tap(...Object.values(await centerOf('[data-testid="import-file"]')));
  await sleep(350);
  if ((await evalJs(`!!document.querySelector('input[type=file]')`)) !== true) {
    // 触摸没命中时退回程序触发（仅用于准备数据；转场断言仍全部用真触摸）
    await evalJs(`document.querySelector('[data-testid="import-file"]').click()`);
    await sleep(350);
  }
  const { root } = await cdp.send('DOM.getDocument', {}, sid);
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' }, sid);
  if (!nodeId) throw new Error('应用未创建文件输入框');
  await cdp.send('DOM.setFileInputFiles', { files: [SAMPLE], nodeId }, sid);
  await sleep(1500);
}

async function main() {
  if (CHROME === undefined) throw new Error('找不到 Chrome');
  writeFileSync(SAMPLE, SAMPLE_TEXT, 'utf8');

  const preview = spawn(process.execPath, [
    join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview',
    '--port', String(PREVIEW_PORT), '--strictPort', '--host', '127.0.0.1',
  ], { cwd: ROOT, stdio: 'ignore' });
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${CDP_PORT}`, '--headless=new', '--no-first-run',
    // 关掉 overscroll 历史导航：否则从屏幕左缘拖动会触发 Chrome 自带的「后退」整页导航
    '--overscroll-history-navigation=0',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    `--user-data-dir=${join(ROOT, 'artifacts', '.chrome-rc3-profile')}`, 'about:blank',
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

    // 干净书架 → 导入样张 → 打开再返回，制造「继续阅读 + 网格」同书
    await importSample();
    await cdp.send('Page.reload', {}, sid);
    await sleep(1800);
    const cardCenter = await centerOf('[data-testid="shelf-grid"] .book-card__title');
    await tap(cardCenter.x, cardCenter.y);
    await sleep(1200);
    await tap(...Object.values(await centerOf('[data-testid="back-to-shelf"]')));
    await sleep(900);

    // PR 准备：记录旧版本会启动 View Transition；新版应为 0 次
    await evalJs(`(() => {
      window.__vtCalls = 0;
      const orig = Document.prototype.startViewTransition;
      if (orig) Document.prototype.startViewTransition = function (...args) { window.__vtCalls += 1; return orig.apply(this, args); };
      window.__longTasks = [];
      try {
        new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__longTasks.push(Math.round(e.duration)); })
          .observe({ type: 'longtask', buffered: false });
      } catch { /* 不支持 */ }
      return true;
    })()`);

    // ── 打开：几何采样 + 抓帧（两遍跑，避免截图开销把采样时间点拖偏） ──
    console.log('\n【打开】');
    const startRectMs = await evalJs(`(() => {
      const c = document.querySelector('[data-testid="shelf-grid"] .book-card__title').closest('[data-doc-id]');
      const r = c.getBoundingClientRect();
      return { top: r.top, right: r.right, bottom: r.bottom, left: r.left };
    })()`);
    const OPEN_TARGETS = [0, 60, 120, 180, 240, 300];

    /** 从 tap 起按绝对时间采样；返回每帧的 {target, elapsed, probe}。 */
    async function sampleOpen() {
      const t0 = performance.now();
      await tap(cardCenter.x, cardCenter.y);
      const out = [];
      for (const target of OPEN_TARGETS) {
        const wait = t0 + target - performance.now();
        if (wait > 0) await sleep(wait);
        const probe = await evalJs(MASK_PROBE);
        out.push({ target, elapsed: Math.round(performance.now() - t0), probe });
      }
      return out;
    }

    const openSamples = await sampleOpen();
    await sleep(500);
    check('打开时存在遮罩层', openSamples[0]?.probe?.hasLayer === true, `第 1 帧 ${openSamples[0]?.elapsed}ms`);
    const firstRect = clipToRect(openSamples[0]?.probe?.clip, VIEWPORT.width, VIEWPORT.height);
    const fromRect = clipToRect(openSamples[0]?.probe?.from, VIEWPORT.width, VIEWPORT.height);
    check('起始帧 clip 矩形 = 被点卡片矩形（≤2px）', near(firstRect, startRectMs) === true && near(fromRect, startRectMs) === true,
      `clip ${JSON.stringify(firstRect)} / from ${JSON.stringify(fromRect)} vs 卡片 ${JSON.stringify(startRectMs)}`);
    check('打开终点 = inset(0)', openSamples[0]?.probe?.to === 'inset(0px round 0px)', String(openSamples[0]?.probe?.to));
    check('打开期间没有任何元素带 view-transition-name', openSamples.every((f) => (f.probe?.vtNames ?? []).length === 0),
      JSON.stringify(openSamples[0]?.probe?.vtNames));
    check('打开未调用 startViewTransition', await evalJs('window.__vtCalls') === 0, `calls=${await evalJs('window.__vtCalls')}`);
    const openLast = openSamples[openSamples.length - 1];
    const lastInset = parseInset(openLast.probe.clip ?? '');
    const lastMax = lastInset ? Math.max(lastInset.top, lastInset.right, lastInset.bottom, lastInset.left) : 0;
    check('末段遮罩接近全屏（各边 ≤4px 或已收尾）', openLast.probe.hasLayer === false || lastMax <= 4,
      `t=${openLast.elapsed}ms clip=${openLast.probe.clip}`);
    check('动画结束阅读页在文档流且遮罩层移除',
      await evalJs(`document.querySelectorAll('.page-mask').length === 0 && !!document.querySelector('[data-testid="article"]')`) === true);
    const openLong = await evalJs('window.__longTasks');
    check('打开过程无 >50ms 长任务', Array.isArray(openLong) && openLong.every((d) => d <= 50), JSON.stringify(openLong));

    // 抓帧：回到书架再打开一次，用 screencast 连续抓帧并按时间挑帧
    await backToShelf();
    const openShot = await captureScreencast('open', OPEN_TARGETS, async () => {
      await tap(cardCenter.x, cardCenter.y);
    }, 420);
    writeFileSync(join(SHOTS, 'frames-open.json'), JSON.stringify(openShot, null, 2));
    check('打开抓帧完成（0/60/120/180/240/300ms）', openShot.frames.length === OPEN_TARGETS.length, `${openShot.captured ?? 0} 帧中挑 ${openShot.frames.length} 帧`);

    // ── 关闭：几何采样 + 抓帧 ──
    console.log('\n【关闭】');
    const CLOSE_TARGETS = [60, 120, 180, 240, 300, 360];
    // 阅读页先滚动再回到顶部：既验证「关闭目标重新测量」，也保证返回按钮可见
    await evalJs(`scrollBy(0, 400)`);
    await sleep(400);
    await evalJs(`scrollTo(0, 0)`);
    await sleep(400);

    async function sampleClose() {
      const t0 = performance.now();
      const back = await centerOf('[data-testid="back-to-shelf"]');
      await tap(back.x, back.y);
      const out = [];
      for (const target of CLOSE_TARGETS) {
        const wait = t0 + target - performance.now();
        if (wait > 0) await sleep(wait);
        const probe = await evalJs(MASK_PROBE);
        out.push({ target, elapsed: Math.round(performance.now() - t0), probe });
      }
      return out;
    }

    const closeSamples = await sampleClose();
    await sleep(400);
    const closeFirst = closeSamples.find((f) => f.probe?.hasLayer === true) ?? null;
    check('关闭时存在遮罩层（阅读页作为收缩窗口）', closeFirst !== null,
      closeFirst === null ? '全部帧都没有遮罩层' : `首个有层帧 ${closeFirst.elapsed}ms`);
    const cardNow = await evalJs(`(() => {
      const c = document.querySelector('[data-testid="shelf-grid"] [data-doc-id]');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { top: r.top, right: r.right, bottom: r.bottom, left: r.left, scrollY: Math.round(scrollY) };
    })()`);
    const closeFrom = closeFirst?.probe?.from ?? null;
    const closeTo = closeFirst?.probe?.to ?? null;
    const toRect = closeTo === null ? null : clipToRect(closeTo, VIEWPORT.width, VIEWPORT.height);
    check('关闭起点 = inset(0)（阅读页全屏）', closeFrom === 'inset(0px round 0px)', String(closeFrom));
    check('关闭终点矩形 = 重新测量的卡片矩形（≤2px）', near(toRect, cardNow, 2) === true,
      `to ${JSON.stringify(toRect)} vs 卡片 ${JSON.stringify(cardNow)}`);
    const stagedClips = closeSamples.filter((f) => (f.probe?.clip ?? '').includes('inset(')).map((f) => parseInset(f.probe.clip));
    const lastCloseInset = stagedClips.length > 0 ? stagedClips[stagedClips.length - 1] : null;
    const layerGone = await evalJs(`document.querySelectorAll('.page-mask').length === 0`);
    const endRectFromClip = lastCloseInset ? {
      top: lastCloseInset.top, right: VIEWPORT.width - lastCloseInset.right,
      bottom: VIEWPORT.height - lastCloseInset.bottom, left: lastCloseInset.left,
    } : null;
    check('关闭末段 clip 已收敛（≤6px 或已收尾）', layerGone === true || (endRectFromClip !== null && near(endRectFromClip, cardNow, 6)) === true,
      `clipless/last=${JSON.stringify(endRectFromClip)} vs 卡片 ${JSON.stringify(cardNow)}`);
    check('关闭期间没有任何元素带 view-transition-name', closeSamples.every((p) => (p.probe?.vtNames ?? []).length === 0),
      JSON.stringify(closeSamples[0]?.probe?.vtNames));
    check('关闭结束遮罩层清理干净', await evalJs(`document.querySelectorAll('.page-mask').length === 0`) === true);


    // 抓帧：再打开一次，screencast 抓关闭过程
    await openFromGrid();
    await evalJs(`scrollTo(0, 0)`);
    await sleep(300);
    const closeShot = await captureScreencast('close', CLOSE_TARGETS, async () => {
      await tap(...Object.values(await centerOf('[data-testid="back-to-shelf"]')));
    }, 460);
    writeFileSync(join(SHOTS, 'frames-close.json'), JSON.stringify(closeShot, null, 2));
    check('关闭抓帧完成（60/120/180/240/300/360ms）', closeShot.frames.length === CLOSE_TARGETS.length, `${closeShot.captured ?? 0} 帧中挑 ${closeShot.frames.length} 帧`);

    // ── 左缘右滑返回（真触摸拖拽；放在场景覆盖之前，避免前面多次导航污染状态）──
    await openFromGrid();
    await resetEmulation();
    const y = Math.round(VIEWPORT.height * 0.5);
    // 左缘手势用鼠标按下/拖动/抬起：CDP 触摸的整段拖动会触发 headless 的整页历史后退
    // （实测页面会跳到 about:blank），鼠标拖动走同一套 pointer 事件但不触发浏览器手势。
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 20, y, button: 'left', clickCount: 1 }, sid);
    for (const dx of [40, 90, 150, 220, 270]) {
      await sleep(25);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20 + dx, y, button: 'left' }, sid);
    }
    const during = await evalJs(`({ t: getComputedStyle(document.querySelector('.shell')).transform, motion: document.documentElement.dataset.motion, page: document.querySelector('.reader-page')?.getAttribute('data-bars') })`);
    console.log('    滑动中：' + JSON.stringify(during));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 20 + 270, y, button: 'left', clickCount: 1 }, sid);
    // 关闭动画在提交后要等 3 帧才建层，采样点放在 220ms
    await sleep(220);
    const swipeProbe = await evalJs(MASK_PROBE);
    const swipeState = await evalJs(`(() => {
      const app = document.querySelector('#app');
      return {
        tabbar: !!document.querySelector('[data-testid="tabbar"]'),
        reader: !!document.querySelector('[data-testid="article"]'),
        motion: document.documentElement.dataset.motion,
        appKids: app ? [...app.children].map((e) => String(e.className || e.tagName)) : null,
        appHtmlLen: app ? app.innerHTML.length : -1,
        text: document.body.innerText.slice(0, 30),
        href: location.href,
        masks: document.querySelectorAll('.page-mask').length,
      };
    })()`);
    console.log('    滑动松手后：' + JSON.stringify(swipeState));
    await sleep(900);
    check('场景：左缘右滑复用关闭遮罩（无第二套转场）',
      swipeProbe.hasLayer === true && swipeProbe.phase === 'close',
      `phase=${swipeProbe.phase} clip=${swipeProbe.clip}`);
    check('左缘右滑后回到书架且遮罩清理', await evalJs(`document.querySelectorAll('.page-mask').length === 0 && !!document.querySelector('[data-testid="tabbar"]')`) === true);

    // ── 场景覆盖（每项只断言「转场跑过 + 清理干净」） ──
    console.log('\n【场景覆盖】');
    const scenarios = [
      ['点封面', `[data-testid="shelf-grid"] [data-cover-doc]`],
      ['点标题', `[data-testid="shelf-grid"] .book-card__title`],
      ['点继续阅读卡片', `[data-testid="continue-open"]`],
    ];
    for (const [label, selector] of scenarios) {
      await resetEmulation();
      const c = await centerOf(selector);
      if (c === null) { check(`场景：${label}`, false, '元素不存在'); continue; }
      await tap(c.x, c.y);
      await sleep(80);
      const probing = await evalJs(MASK_PROBE);
      await sleep(400);
      const cleaned = await evalJs(`document.querySelectorAll('.page-mask').length === 0 && !!document.querySelector('[data-testid="article"]')`);
      check(`场景：${label} 走遮罩转场并清理`, probing.hasLayer === true && cleaned === true,
        `layer=${probing.hasLayer} clip=${probing.clip}`);
      await backToShelf();
    }

    // 点播放按钮（继续阅读卡片里）
    await resetEmulation();
    const play = await centerOf('[data-testid="continue-open"] .continue-card__play');
    if (play !== null) {
      await tap(play.x, play.y);
      await sleep(80);
      const probing = await evalJs(MASK_PROBE);
      await sleep(400);
      check('场景：点播放按钮 走遮罩转场', probing.hasLayer === true, `clip=${probing.clip}`);
      await backToShelf();
    }

    // 书架滚动后再点
    await resetEmulation();
    await evalJs(`scrollBy(0, 300)`);
    await sleep(300);
    const scrolled = await centerOf('[data-testid="shelf-grid"] .book-card__title');
    await tap(scrolled.x, scrolled.y);
    await sleep(80);
    const scrollProbe = await evalJs(MASK_PROBE);
    await sleep(500);
    check('场景：书架滚动后打开仍从卡片展开', scrollProbe.hasLayer === true, `clip=${scrollProbe.clip}`);
    await backToShelf();

    // 动画中连点（快速点两下不同卡片）
    await resetEmulation();
    const title1 = await centerOf('[data-testid="shelf-grid"] .book-card__title');
    await tap(title1.x, title1.y);
    await sleep(60);
    await tap(title1.x, title1.y);
    await sleep(900);
    const afterRapid = await evalJs(`({
      layers: document.querySelectorAll('.page-mask').length,
      reader: !!document.querySelector('[data-testid="article"]'),
      bars: document.querySelector('.reader-page')?.getAttribute('data-bars'),
    })`);
    check('场景：动画中连点不残留遮罩层、阅读页状态正常',
      afterRapid.layers === 0 && afterRapid.reader === true,
      JSON.stringify(afterRapid));
    await backToShelf();

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
