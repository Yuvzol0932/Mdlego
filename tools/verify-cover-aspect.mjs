#!/usr/bin/env node
/**
 * #B 验收：转场中的形变壳必须裁成**封面的宽高比**，不得出现「屏幕比例大矩形」。
 *
 * 判据（打包产物 + 真触摸）：
 *   1. 打开第 1 帧：形变壳可见区域 = 形变壳矩形 ∩ clip-path，宽高比与封面一致（≤1%）
 *   2. 打开第 1 帧：可见区域高度 ≈ 封面高度 × scale，不得高一倍多
 *   3. 关闭最后 1 帧：同上
 *   4. 全程可见区域不与相邻卡片的标题区域相交
 *   5. 圆角由 clip-path 承担：形变壳上不应有内联 border-radius
 *
 * 用法：node tools/verify-cover-aspect.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = join(ROOT, 'docs', 'perf', '1.2.1', 'evidence', 'cover-aspect');
const PREVIEW_PORT = 4185;
const CDP_PORT = 9470;
const VIEWPORT = { width: 393, height: 873, deviceScaleFactor: 3, mobile: true };

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
const centerOf = (selector) => evalJs(`(() => {
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

/**
 * 量「形变壳当前可见区域」，并从 clip-path 里解析出裁剪与圆角。
 *
 * 可见区域 = 形变壳矩形 ∩ clip-path(inset)。因为形变壳同时带 transform：scale，
 * getBoundingClientRect() 已经是**视觉**矩形，这里只按 clip-path 的百分比/像素
 * 在视觉坐标系里再裁一次（inset 的值都是形变壳自身的布局单位，等价于视觉
 * 单位乘以 scale —— 所以用「视觉高度 / 布局高度」换算）。
 */
const measure = () => evalJs(`(() => {
  const layer = document.querySelector('.page-mask');
  if (layer === null) return null;
  const cs = getComputedStyle(layer);
  const fit = {
    transform: cs.transform,
    clipPath: cs.clipPath,
    inlineBorderRadius: layer.style.borderRadius || null,
    layoutH: layer.offsetHeight,
    layoutW: layer.offsetWidth,
    visual: layer.getBoundingClientRect().toJSON(),
  };
  // 解析 inset(top right bottom left round R)
  const m = /inset\\(([^)]+)\\)/.exec(cs.clipPath);
  let clipBottomPx = 0;
  let clipRadiusPx = 0;
  if (m) {
    const parts = m[1].split('round');
    const sides = parts[0].trim().split(/\\s+/).map((v) => parseFloat(v) || 0);
    clipBottomPx = sides.length >= 3 ? sides[2] : 0;
    if (parts[1]) clipRadiusPx = parseFloat(parts[1]) || 0;
  }
  const scale = fit.layoutH > 0 ? fit.visual.height / fit.layoutH : 1;
  // 可见区域换算到视觉坐标
  const visibleTop = fit.visual.top;
  const visibleHeight = Math.max(0, fit.layoutH - clipBottomPx) * scale;
  const visibleLeft = fit.visual.left;
  const visibleWidth = fit.layoutW * scale;
  return {
    ...fit,
    scale,
    clipBottomPx,
    clipRadiusPx,
    visible: {
      top: visibleTop, left: visibleLeft,
      width: visibleWidth, height: visibleHeight,
      right: visibleLeft + visibleWidth,
      bottom: visibleTop + visibleHeight,
      ratio: visibleHeight > 0 ? visibleWidth / visibleHeight : 0,
    },
  };
})()`);

/** 目标封面的真实矩形（书架上那张卡里的 .cover）。 */
const coverRect = (docId) => evalJs(`(() => {
  const el = document.querySelector('[data-cover-doc="${docId}"]') ?? document.querySelector('[data-doc-id="${docId}"] .cover');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height, ratio: r.width / r.height };
})()`);

/** 相邻卡片标题区域（用来断言「不得盖住标题」）。 */
const neighborTitles = (docId) => evalJs(`(() => {
  const out = [];
  for (const card of document.querySelectorAll('[data-doc-id]')) {
    if (card.getAttribute('data-doc-id') === ${JSON.stringify(docId)}) continue;
    const t = card.querySelector('.book-card__title');
    if (!t) continue;
    const r = t.getBoundingClientRect();
    if (r.width === 0) continue;
    out.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
  }
  return out;
})()`);

function overlaps(a, b) {
  // 形变壳带大圆角，边缘轻微相交不算「盖住」：留 2px 容差
  return a.left < b.right - 2 && a.right > b.left + 2 && a.top < b.bottom - 2 && a.bottom > b.top + 2;
}

async function importSample() {
  const SAMPLE = join(ROOT, 'artifacts', '.cover-aspect.md');
  const parts = ['# 宽高比验收样张\n'];
  for (let i = 1; i <= 60; i += 1) parts.push(`## 第 ${i} 节\n\n第 ${i} 段正文， suficiente length.\n`);
  writeFileSync(SAMPLE, parts.join('\n'), 'utf8');
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
  await sleep(3500);
}

async function main() {
  if (CHROME === undefined) throw new Error('找不到 Chrome');
  const preview = spawn(process.execPath, [
    join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview',
    '--port', String(PREVIEW_PORT), '--strictPort', '--host', '127.0.0.1',
  ], { cwd: ROOT, stdio: 'ignore' });
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${CDP_PORT}`, '--headless=new', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    `--user-data-dir=${join(ROOT, 'artifacts', '.chrome-aspect-profile')}`, 'about:blank',
  ], { stdio: 'ignore' });

  const report = {};
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

    const card = await evalJs(`(() => {
      const cards = [...document.querySelectorAll('[data-testid="shelf-grid"] [data-doc-id]')];
      const target = cards.find((c) => (c.textContent ?? '').includes('宽高比验收')) ?? cards[0];
      if (!target) return null;
      const t = target.querySelector('.book-card__title');
      const r = (t ?? target).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, docId: target.getAttribute('data-doc-id') };
    })()`);
    check('找到目标卡片', card !== null, card?.docId);
    const cover = await coverRect(card.docId);
    check('量到封面矩形（3:4）', cover !== null, cover ? `${cover.width.toFixed(1)}×${cover.height.toFixed(1)} ratio=${cover.ratio.toFixed(3)}` : '');
    const titles = await neighborTitles(card.docId);

    // ── 打开：抓**真正的第 0 帧** ──
    //
    // 不能 sleep 几十毫秒再量：400ms 的动画跑 30ms 已经是 7% 进度以上
    // （实测某些帧能到 35%），那时形变壳已经放大，量到的是中间态。
    // 这里在点击后的第一个 rAF 里读，且读之前把动画**暂停在起点**
    // （pause() 会冻结在当前时间，起点即 offset 0 的关键帧）。
    await evalJs(`(() => {
      window.__openFrame = null;
      const orig = Element.prototype.animate;
      Element.prototype.animate = function (frames, opts) {
        const anim = orig.call(this, frames, opts);
        // 只关心形变壳那个主动画（带 clipPath 的关键帧）
        if (Array.isArray(frames) && frames.some((f) => f && f.clipPath !== undefined)) {
          anim.pause();
          anim.currentTime = 0;
          window.__openFrame = { el: this, anim };
        }
        return anim;
      };
      window.__restoreAnimate = () => { Element.prototype.animate = orig; };
      return true;
    })()`);
    await tap(card.x, card.y);
    await sleep(120);
    const openFirst = await measure();
    // 量完恢复播放
    await evalJs(`(() => { try { window.__openFrame?.anim.play(); } catch {} window.__restoreAnimate?.(); return true; })()`);
    report.openFirst = openFirst;
    await shotAt('open-first');
    await sleep(1200);
    await shotAt('open-settled');

    check('打开第 1 帧：形变壳存在', openFirst !== null);
    if (openFirst !== null && cover !== null) {
      const ratioErr = Math.abs(openFirst.visible.ratio - cover.ratio) / cover.ratio;
      check('打开第 1 帧：可见区域宽高比 = 封面（≤1%）', ratioErr <= 0.01,
        `可见 ${openFirst.visible.width.toFixed(1)}×${openFirst.visible.height.toFixed(1)} ratio=${openFirst.visible.ratio.toFixed(3)} vs 封面 ${cover.ratio.toFixed(3)}（误差 ${(ratioErr * 100).toFixed(2)}%）`);
      check('打开第 1 帧：可见高度 ≈ 封面高度（不是屏幕比例的 1.5 倍以上）',
        openFirst.visible.height <= cover.height * 1.15,
        `可见高 ${openFirst.visible.height.toFixed(1)} vs 封面高 ${cover.height.toFixed(1)}（×${(openFirst.visible.height / cover.height).toFixed(2)}）`);
      check('打开第 1 帧：clip-path 真的裁了底部', openFirst.clipBottomPx > 1,
        `clipBottom=${openFirst.clipBottomPx.toFixed(1)}px`);
      check('打开第 1 帧：圆角由 clip-path 承担（形变壳无内联 border-radius）',
        openFirst.inlineBorderRadius === null,
        `inline border-radius=${JSON.stringify(openFirst.inlineBorderRadius)} clip round=${openFirst.clipRadiusPx.toFixed(1)}px`);
      const hit = titles.filter((t) => overlaps(openFirst.visible, t));
      check('打开第 1 帧：不盖住相邻卡片标题', hit.length === 0, `命中 ${hit.length} 个标题`);
    }

    // ── 关闭：抓最后 1 帧 ──
    await evalJs(`(document.querySelector('[data-testid="back-to-shelf"]') ?? { click() {} }).click()`);
    // 关闭动画 440ms：在 400ms 左右抓「接近落位」的一帧
    await sleep(400);
    const closeLast = await measure();
    report.closeLast = closeLast;
    await shotAt('close-last');
    await sleep(1200);

    check('关闭末帧：形变壳存在', closeLast !== null);
    if (closeLast !== null && cover !== null) {
      const ratioErr = Math.abs(closeLast.visible.ratio - cover.ratio) / cover.ratio;
      check('关闭末帧：可见区域宽高比 = 封面（≤2%）', ratioErr <= 0.02,
        `ratio=${closeLast.visible.ratio.toFixed(3)} vs ${cover.ratio.toFixed(3)}（误差 ${(ratioErr * 100).toFixed(2)}%）`);
      check('关闭末帧：clip-path 真的裁了底部', closeLast.clipBottomPx > 1,
        `clipBottom=${closeLast.clipBottomPx.toFixed(1)}px`);
    }

    // ── 起止几何一致性：打开起点与关闭终点的可见区域应吻合封面 ──
    if (openFirst !== null && cover !== null) {
      const dw = Math.abs(openFirst.visible.width - cover.width);
      const dh = Math.abs(openFirst.visible.height - cover.height);
      check('打开起点可见区域 = 封面矩形（误差 ≤ 2px）', dw <= 2 && dh <= 2,
        `Δw=${dw.toFixed(2)}px Δh=${dh.toFixed(2)}px`);
    }
  } finally {
    try { cdp?.ws.close(); } catch { /* ignore */ }
    try { preview.kill(); } catch { /* ignore */ }
    try { chrome.kill(); } catch { /* ignore */ }
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, 'measure.json'), JSON.stringify(report, null, 1), 'utf8');
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n结果：${checks.length - failed.length}/${checks.length}`);
  console.log('截图与测量：', SHOTS);
  if (failed.length > 0) {
    console.log('失败：\n' + failed.map((f) => `  ✗ ${f.name}`).join('\n'));
    process.exitCode = 1;
  }
}

await main();
