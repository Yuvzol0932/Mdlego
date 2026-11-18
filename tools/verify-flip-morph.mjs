#!/usr/bin/env node
/**
 * FLIP 形变转场验收（改造计划书 Step 3）。
 *
 * 断言：
 *   1. 形变壳几何：缩放严格等比、位移落向卡片左上角、圆角补偿
 *   2. 双层交叉溶解：关闭时阅读层先淡出、封面后升起（不再硬切）
 *   3. 书架景深：底层书架 scale 在转场中从 1 → 0.95（打开）/ 0.95 → 1（关闭）
 *   4. 背景压暗层存在且透明度随时间变化
 *   5. 原卡槽防重影：转场期间目标卡片带 .is-morph-slot-hidden，结束后必恢复
 *   6. 转场结束后所有临时层与类名清理干净（异常自愈）
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = join(ROOT, 'docs', 'screenshots', 'transition-rc3', 'flip');
const PREVIEW_PORT = 4186;
const CDP_PORT = 9464;
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
  for (let i = 1; i <= 700; i += 1) {
    parts.push(`## 第 ${i} 节\n`);
    parts.push(`这是第 ${i} 段填充文字，用来验证 FLIP 形变转场的几何与性能。` + '书架与阅读页之间的转场必须从被点卡片的矩形展开。\n');
    parts.push(`- 要点 A${i}\n- 要点 B${i}\n`);
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
  await sleep(3500);
}

/**
 * 采样器：逐帧记录形变壳的 transform / 圆角、各层 opacity、
 * 底层书架 scale、卡槽隐身状态。
 */
const SAMPLER = `(() => {
  window.__morph = [];
  window.__morphWatch = true;
  const tick = () => {
    if (!window.__morphWatch) return;
    const stage = document.querySelector('[data-testid="page-mask"]');
    const scrim = document.querySelector('.page-mask-scrim');
    const reader = stage?.querySelector('.page-mask__reader');
    const cover = stage?.querySelector('.page-mask__cover');
    // 采样器记录形变壳与各层透明度；底层书架的 scale 单独记录
    const behind = document.querySelector('.page-mask-behind');
    const hiddenSlot = document.querySelectorAll('.is-morph-slot-hidden').length;
    const cs = stage ? getComputedStyle(stage) : null;
    const behindCs = behind ? getComputedStyle(behind) : null;
    // 关闭方向的底层书架：转场层之前、跳过 scrim 的那个兄弟节点
    let shelfEl = null;
    if (stage) {
      let node = stage.previousElementSibling;
      while (node) {
        if (node.matches('.page-mask-scrim') || node.matches('[data-testid="page-mask"]')) { node = node.previousElementSibling; continue; }
        shelfEl = node; break;
      }
    }
    const shelfCs = shelfEl ? getComputedStyle(shelfEl) : null;
    window.__morph.push({
      t: Math.round(performance.now()),
      present: stage !== null,
      phase: stage?.dataset.phase ?? null,
      morph: stage?.dataset.morph ?? null,
      transform: cs ? cs.transform : null,
      radius: cs ? cs.borderTopLeftRadius : null,
      scrim: scrim ? getComputedStyle(scrim).opacity : null,
      readerOp: reader ? getComputedStyle(reader).opacity : null,
      coverOp: cover ? getComputedStyle(cover).opacity : null,
      behindTransform: behindCs ? behindCs.transform : null,
      shelfTransform: shelfCs ? shelfCs.transform : null,
      hiddenSlot,
    });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
})()`;

/** 从 matrix(...) 里解析出缩放与位移。 */
function parseMatrix(value) {
  if (typeof value !== 'string') return null;
  const m = /matrix\(([^)]+)\)/.exec(value);
  if (m === null) {
    // none / matrix3d 兜底
    if (value === 'none') return { scale: 1, tx: 0, ty: 0 };
    return null;
  }
  const parts = m[1].split(',').map((n) => Number.parseFloat(n.trim()));
  if (parts.length < 6) return null;
  return { scale: parts[0], tx: parts[4], ty: parts[5] };
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
    `--user-data-dir=${join(ROOT, 'artifacts', '.chrome-flip')}`, 'about:blank',
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

    // 记录卡片几何（用于校验形变终点）
    const cardRect = await evalJs(`(() => {
      const c = document.querySelector('[data-testid="shelf-grid"] .book-card');
      const r = c.getBoundingClientRect();
      const cs = getComputedStyle(c.querySelector('[data-cover]') ?? c);
      return { left: r.left, top: r.top, width: r.width, height: r.height, radius: Number.parseFloat(cs.borderTopLeftRadius) || 0 };
    })()`);
    console.log(`\n【卡片几何】${JSON.stringify(cardRect)}`);

    // ── A. 打开转场 ──
    await evalJs(SAMPLER);
    const tl = await evalJs(`(() => { const c = document.querySelector('[data-testid="shelf-grid"] .book-card'); const r = c.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
    await tap(tl.x, tl.y);
    await sleep(120);
    await shotAt('open-120ms');
    await sleep(700);
    await evalJs(`window.__morphWatch = false; true`);
    const openFrames = await evalJs(`window.__morph`);
    const openRel = openFrames.map((f) => ({ ...f, t: f.t - openFrames[0].t }));
    const openStage = openRel.filter((f) => f.present && f.phase === 'open');

    check('打开转场使用 FLIP 形变壳', openStage.length > 0 && openStage.every((f) => f.morph === 'flip'), `${openStage.length} 帧 morph=flip`);

    // 缩放严格等比：首帧 scale ≈ 卡片宽/视口宽
    const expectedScale = cardRect.width / VIEWPORT.width;
    const firstM = parseMatrix(openStage[0]?.transform ?? null);
    check(
      '起始缩放严格等于「卡片宽 / 视口宽」',
      firstM !== null && Math.abs(firstM.scale - expectedScale) < 0.02,
      `实测 ${firstM?.scale?.toFixed(4)} / 期望 ${expectedScale.toFixed(4)}`,
    );

    // 位移落向卡片左上角
    check(
      '起始位移落在卡片左上角',
      firstM !== null && Math.abs(firstM.tx - cardRect.left) < 4 && Math.abs(firstM.ty - cardRect.top) < 4,
      `实测 (${firstM?.tx?.toFixed(1)}, ${firstM?.ty?.toFixed(1)}) / 卡片 (${cardRect.left.toFixed(1)}, ${cardRect.top.toFixed(1)})`,
    );

    // 圆角反向补偿：屏幕上可见圆角 = radius × scale ≈ 卡片圆角
    const firstRadius = Number.parseFloat(openStage[0]?.radius ?? '0');
    const visibleRadius = firstRadius * (firstM?.scale ?? 1);
    check(
      '圆角反向补偿（可见圆角 = 卡片圆角）',
      cardRect.radius <= 0 || Math.abs(visibleRadius - cardRect.radius) < 1.5,
      `补偿后可见 ${visibleRadius.toFixed(1)}px / 卡片 ${cardRect.radius.toFixed(1)}px`,
    );

    // 形变单调推进到全屏
    const scales = openStage.map((f) => parseMatrix(f.transform)?.scale).filter((n) => typeof n === 'number');
    check('形变单调放大到全屏', scales.length > 2 && scales[scales.length - 1] > scales[0], `${scales[0]?.toFixed(3)} → ${scales[scales.length - 1]?.toFixed(3)}`);

    // 交叉溶解：封面 opacity 递减，阅读层从低到 1
    const coverOps = openStage.map((f) => Number.parseFloat(f.coverOp ?? '1')).filter((n) => !Number.isNaN(n));
    const readerOps = openStage.map((f) => Number.parseFloat(f.readerOp ?? '1')).filter((n) => !Number.isNaN(n));
    check('打开：封面层淡出（交叉溶解）', coverOps.length > 1 && coverOps[0] > coverOps[coverOps.length - 1], `${coverOps[0]?.toFixed(2)} → ${coverOps[coverOps.length - 1]?.toFixed(2)}`);
    check('打开：阅读层淡入到不透明', readerOps.length > 1 && readerOps[readerOps.length - 1] > 0.9, `${readerOps[0]?.toFixed(2)} → ${readerOps[readerOps.length - 1]?.toFixed(2)}`);

    // 景深：底层书架 scale 变小
    const behindScales = openStage.map((f) => parseMatrix(f.behindTransform)?.scale).filter((n) => typeof n === 'number');
    check('打开：底层书架景深微缩', behindScales.length > 1 && behindScales[behindScales.length - 1] < behindScales[0], `${behindScales[0]?.toFixed(3)} → ${behindScales[behindScales.length - 1]?.toFixed(3)}`);

    // 压暗层
    const scrims = openStage.map((f) => Number.parseFloat(f.scrim ?? '0')).filter((n) => !Number.isNaN(n));
    check('打开：背景压暗层淡入', scrims.length > 1 && scrims[scrims.length - 1] > scrims[0], `${scrims[0]?.toFixed(2)} → ${scrims[scrims.length - 1]?.toFixed(2)}`);

    // 卡槽防重影
    check('打开：原卡槽已隐身（防重影）', openStage.some((f) => f.hiddenSlot > 0), `最多 ${Math.max(...openStage.map((f) => f.hiddenSlot))} 张`);
    const afterOpen = await evalJs(`({
      masks: document.querySelectorAll('.page-mask').length,
      scrims: document.querySelectorAll('.page-mask-scrim').length,
      hidden: document.querySelectorAll('.is-morph-slot-hidden').length,
      reader: !!document.querySelector('[data-testid="article"]'),
    })`);
    check('打开结束后临时层与隐身全部恢复', afterOpen.masks === 0 && afterOpen.scrims === 0 && afterOpen.hidden === 0, JSON.stringify(afterOpen));
    await shotAt('open-settled');

    // 滚到中段再退
    await evalJs(`scrollTo(0, Math.round(document.documentElement.scrollHeight * 0.45))`);
    await sleep(600);

    // ── B. 关闭转场 ──
    await evalJs(SAMPLER);
    await evalJs(`document.querySelector('[data-testid="back-to-shelf"]').click()`);
    await sleep(120);
    await shotAt('close-120ms');
    await sleep(700);
    await evalJs(`window.__morphWatch = false; true`);
    const closeFrames = await evalJs(`window.__morph`);
    const closeRel = closeFrames.map((f) => ({ ...f, t: f.t - closeFrames[0].t }));
    const closeStage = closeRel.filter((f) => f.present && f.phase === 'close');

    check('关闭转场使用 FLIP 形变壳', closeStage.length > 0 && closeStage.every((f) => f.morph === 'flip'), `${closeStage.length} 帧`);
    const closeScales = closeStage.map((f) => parseMatrix(f.transform)?.scale).filter((n) => typeof n === 'number');
    check('关闭：形变单调缩小落向卡片', closeScales.length > 2 && closeScales[closeScales.length - 1] < closeScales[0], `${closeScales[0]?.toFixed(3)} → ${closeScales[closeScales.length - 1]?.toFixed(3)}`);

    const closeCoverOps = closeStage.map((f) => Number.parseFloat(f.coverOp ?? '0')).filter((n) => !Number.isNaN(n));
    const closeReaderOps = closeStage.map((f) => Number.parseFloat(f.readerOp ?? '1')).filter((n) => !Number.isNaN(n));
    check('关闭：阅读层淡出', closeReaderOps.length > 1 && closeReaderOps[closeReaderOps.length - 1] < 0.2, `${closeReaderOps[0]?.toFixed(2)} → ${closeReaderOps[closeReaderOps.length - 1]?.toFixed(2)}`);
    check('关闭：封面层升起（消灭白底黑字硬切）', closeCoverOps.length > 1 && closeCoverOps[closeCoverOps.length - 1] > 0.9, `${closeCoverOps[0]?.toFixed(2)} → ${closeCoverOps[closeCoverOps.length - 1]?.toFixed(2)}`);

    // 关闭终点缩放应接近卡片宽/视口宽
    const lastClose = parseMatrix(closeStage[closeStage.length - 1]?.transform ?? null);
    check(
      '关闭终点缩放到卡片尺寸',
      lastClose !== null && Math.abs(lastClose.scale - expectedScale) < 0.06,
      `实测 ${lastClose?.scale?.toFixed(4)} / 期望 ${expectedScale.toFixed(4)}`,
    );

    // 关闭：底层书架浮起恢复（从 0.95 回到 1）
    const shelfScales = closeStage.map((f) => parseMatrix(f.shelfTransform)?.scale).filter((n) => typeof n === 'number');
    check(
      '关闭：底层书架浮起恢复',
      shelfScales.length > 1 && shelfScales[shelfScales.length - 1] > shelfScales[0],
      shelfScales.length === 0
        ? '没采到书架 transform'
        : `${shelfScales[0]?.toFixed(3)} → ${shelfScales[shelfScales.length - 1]?.toFixed(3)}`,
    );

    check('关闭：原卡槽已隐身（防重影）', closeStage.some((f) => f.hiddenSlot > 0), `最多 ${Math.max(...closeStage.map((f) => f.hiddenSlot))} 张`);

    await sleep(500);
    const afterClose = await evalJs(`({
      masks: document.querySelectorAll('.page-mask').length,
      scrims: document.querySelectorAll('.page-mask-scrim').length,
      hidden: document.querySelectorAll('.is-morph-slot-hidden').length,
      onShelf: !!document.querySelector('[data-testid="shelf-grid"]'),
      reader: !!document.querySelector('[data-testid="article"]'),
    })`);
    check('关闭结束后临时层与卡槽隐身全部恢复', afterClose.masks === 0 && afterClose.scrims === 0 && afterClose.hidden === 0, JSON.stringify(afterClose));
    check('已回到书架', afterClose.onShelf === true && afterClose.reader === false);
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
