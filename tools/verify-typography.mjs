#!/usr/bin/env node
/**
 * 排版可调性验证 —— 证明「改设置真的会变」。
 *
 * 这是对「预留接口」的验收：
 *   不是断言"类型里有 fontSize 字段"，而是断言
 *   "点了 + 号 / 拖了滑块之后，页面上正文的计算字号确实变了，并且刷新后还在"。
 *
 * 阶段 C3 起界面结构变了：
 *   - 字号/行距/段距的「档位调节器」在设置页（保留 type-scale-* 等 testid）
 *   - 阅读页的 Aa 面板用滑块调同一套档位（任务书 §2.4 要求滑块）
 * 所以脚本分两段：
 *   1. 设置页上逐个档位量计算值（读 .preview 块）
 *   2. 阅读页 Aa 面板上用滑块验证「同一套档位真的驱动正文」（读 .article）
 *
 * 覆盖：
 *   1. 字号 7 档逐一验证计算值单调递增
 *   2. 行距 5 档逐一验证行高/字号比例单调递增
 *   3. 段间距 3 档验证段落下边距递增
 *   4. 字体切换验证 font-family 真的换了
 *   5. Aa 面板滑块驱动同一套档位
 *   6. 持久化：刷新页面后设置仍在
 *   7. 主题切换验证背景色真的变了
 *   8. 边界：最大档时加号禁用
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { serveStatic } from './serve.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'artifacts', 'screenshots');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));

const VIEWPORT = { width: 393, height: 873, deviceScaleFactor: 3, mobile: true };
const PORT = 9336;

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

async function evaluate(cdp, sid, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

async function shot(cdp, sid, name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 点击带 data-testid 的元素；若尚未渲染则短暂重试。 */
async function click(cdp, sid, testId) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const found = await evaluate(
      cdp,
      sid,
      `(() => {
        const b = document.querySelector('[data-testid="${testId}"]');
        if (!b) return false;
        b.click();
        return true;
      })()`,
    );
    if (found === true) {
      await sleep(140);
      return true;
    }
    await sleep(120);
  }
  return false;
}

/** 反复点击直到到达边界（按钮被禁用）。 */
async function clickToEdge(cdp, sid, testId, times) {
  for (let i = 0; i < times; i++) {
    const clicked = await click(cdp, sid, testId);
    if (!clicked) break;
    const disabled = await evaluate(
      cdp,
      sid,
      `document.querySelector('[data-testid="${testId}"]')?.hasAttribute('disabled') ?? true`,
    );
    if (disabled === true) break;
  }
}

/** 设置滑块值并派发 input 事件（与手指拖动走同一条代码路径）。 */
async function setSlider(cdp, sid, testId, value) {
  return evaluate(
    cdp,
    sid,
    `(() => {
      const s = document.querySelector('[data-testid="${testId}"]');
      if (!s) return false;
      s.value = String(${value});
      s.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
  );
}

/** 读排版度量。优先读阅读页正文，若不在阅读页则读设置页预览块。 */
async function readTypography(cdp, sid) {
  return evaluate(
    cdp,
    sid,
    `(() => {
      const target = document.querySelector('.article p') ?? document.querySelector('.preview p');
      if (!target) return null;
      const s = getComputedStyle(target);
      return {
        fontSize: parseFloat(s.fontSize),
        lineHeight: parseFloat(s.lineHeight),
        marginBottom: parseFloat(s.marginBottom),
        fontFamily: s.fontFamily,
        letterSpacing: s.letterSpacing,
      };
    })()`,
  );
}

/** 导航并等待渲染完成（等到指定 testid 出现或超时）。 */
async function gotoAndWait(cdp, sid, url, readyTestId) {
  await cdp.send('Page.navigate', { url }, sid);
  for (let i = 0; i < 30; i++) {
    await sleep(150);
    const ready = await evaluate(
      cdp,
      sid,
      `!!document.querySelector('[data-testid="${readyTestId}"]')`,
    );
    if (ready === true) {
      await sleep(200);
      return true;
    }
  }
  return false;
}

/** 回书架 → 打开样张（刷新/换主题后阅读页会关掉，需要重新进）。 */
async function openSampleDoc(cdp, sid) {
  const ok = await gotoAndWait(cdp, sid, serverUrl, 'doc-item');
  if (!ok) return false;
  await click(cdp, sid, 'doc-item');
  await sleep(900);
  return (await evaluate(cdp, sid, `!!document.querySelector('[data-testid="article"]')`)) === true;
}

let serverUrl = '';

async function main() {
  if (CHROME === undefined) {
    console.error('✗ 未找到 Chrome');
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  const server = await serveStatic(join(ROOT, 'www'));
  serverUrl = server.url;

  const proc = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      '--headless=new',
      '--no-first-run',
      '--disable-extensions',
      '--user-data-dir=' + join(ROOT, 'artifacts', '.chrome-typo'),
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    const wsUrl = await connectWs(PORT);
    const ws = new WebSocket(wsUrl);
    await new Promise((r, j) => {
      ws.addEventListener('open', r, { once: true });
      ws.addEventListener('error', () => j(new Error('ws fail')), { once: true });
    });
    const cdp = new Cdp(ws);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('DOM.enable', {}, sessionId);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { ...VIEWPORT, screenWidth: VIEWPORT.width, screenHeight: VIEWPORT.height },
      sessionId,
    );

    // 干净起点
    await cdp.send('Page.navigate', { url: server.url }, sessionId);
    await sleep(900);
    await evaluate(cdp, sessionId, `localStorage.clear();`);
    await cdp.send('Page.reload', {}, sessionId);
    await sleep(1600);

    // ── 准备：真实导入一篇样张（后面阅读页要用） ──
    console.log('\n【准备：导入样张】');
    const SAMPLE_MD = join(ROOT, 'artifacts', '.typo-sample.md');
    writeFileSync(
      SAMPLE_MD,
      '# 排版验收样张\n\n第一段正文，用来量字号、行距与段间距。\n\n第二段正文，段落之间要能看出间距变化。\n',
      'utf8',
    );
    await click(cdp, sessionId, 'import-file');
    await sleep(350);
    const { root: domRoot } = await cdp.send('DOM.getDocument', {}, sessionId);
    const { nodeId } = await cdp.send(
      'DOM.querySelector',
      { nodeId: domRoot.nodeId, selector: 'input[type=file]' },
      sessionId,
    );
    if (!nodeId) throw new Error('应用未创建文件输入框');
    await cdp.send('DOM.setFileInputFiles', { files: [SAMPLE_MD], nodeId }, sessionId);
    await sleep(1500);
    check('样张已导入书架', (await evaluate(cdp, sessionId,
      `document.querySelectorAll('[data-testid="doc-item"]').length`)) >= 1);

    // ── 1. 设置页：字号 7 档 ──
    console.log('\n【字号 7 档（设置页档位调节器）】');
    await gotoAndWait(cdp, sessionId, server.url + '#/settings', 'type-scale-decrease');
    await clickToEdge(cdp, sessionId, 'type-scale-decrease', 10);

    const fontSizes = [];
    for (let level = 1; level <= 7; level++) {
      const t = await readTypography(cdp, sessionId);
      fontSizes.push(t?.fontSize ?? 0);
      if (level < 7) await click(cdp, sessionId, 'type-scale-increase');
    }
    check(
      '字号 7 档严格递增',
      fontSizes.every((v, i) => i === 0 || v > fontSizes[i - 1]),
      fontSizes.join(' → '),
    );
    check('最小档 15px', fontSizes[0] === 15, `${fontSizes[0]}px`);
    check('最大档 25px', fontSizes[6] === 25, `${fontSizes[6]}px`);

    const incDisabledAtMax = await evaluate(
      cdp,
      sessionId,
      `document.querySelector('[data-testid="type-scale-increase"]').hasAttribute('disabled')`,
    );
    check('最大档时加号被禁用', incDisabledAtMax === true);
    const decDisabledAtMax = await evaluate(
      cdp,
      sessionId,
      `document.querySelector('[data-testid="type-scale-decrease"]').hasAttribute('disabled')`,
    );
    check('最大档时减号仍可用', decDisabledAtMax === false);

    // ── 2. 行距 5 档 ──
    console.log('\n【行距 5 档】');
    await clickToEdge(cdp, sessionId, 'type-scale-increase', 10);
    await clickToEdge(cdp, sessionId, 'type-scale-decrease', 10);
    await click(cdp, sessionId, 'type-scale-increase');
    await click(cdp, sessionId, 'type-scale-increase');
    await clickToEdge(cdp, sessionId, 'line-scale-decrease', 10);

    const ratios = [];
    for (let level = 1; level <= 5; level++) {
      const t = await readTypography(cdp, sessionId);
      if (t !== null && t.fontSize > 0) ratios.push(Number((t.lineHeight / t.fontSize).toFixed(3)));
      if (level < 5) await click(cdp, sessionId, 'line-scale-increase');
    }
    check(
      '行距 5 档严格递增',
      ratios.length === 5 && ratios.every((v, i) => i === 0 || v > ratios[i - 1]),
      ratios.join(' → '),
    );

    // ── 3. 段间距 3 档 ──
    console.log('\n【段间距 3 档】');
    await clickToEdge(cdp, sessionId, 'para-scale-decrease', 10);
    const margins = [];
    for (let level = 1; level <= 3; level++) {
      const t = await readTypography(cdp, sessionId);
      margins.push(t?.marginBottom ?? 0);
      if (level < 3) await click(cdp, sessionId, 'para-scale-increase');
    }
    check(
      '段间距 3 档严格递增',
      margins.every((v, i) => i === 0 || v > margins[i - 1]),
      margins.join(' → '),
    );

    // ── 4. 字体 ──
    console.log('\n【字体】');
    const serifFont = await readTypography(cdp, sessionId);
    await click(cdp, sessionId, 'font-sans');
    const sansFont = await readTypography(cdp, sessionId);
    check(
      '切换黑体后 font-family 改变',
      serifFont !== null && sansFont !== null && serifFont.fontFamily !== sansFont.fontFamily,
      `${serifFont?.fontFamily.split(',')[0]} → ${sansFont?.fontFamily.split(',')[0]}`,
    );
    await click(cdp, sessionId, 'font-serif');

    // ── 5. 阅读页 Aa 面板：滑块驱动同一套档位 ──
    console.log('\n【阅读页 Aa 面板（滑块）】');
    check('能回到书架并打开样张', (await openSampleDoc(cdp, sessionId)) === true);
    const sheetOpened = await click(cdp, sessionId, 'open-typeset');
    check(
      '能打开排版面板',
      sheetOpened === true
        && (await evaluate(cdp, sessionId, `!!document.querySelector('[data-testid="typeset-sheet"]')`)) === true,
    );

    const beforeAa = await evaluate(cdp, sessionId, `(() => ({
      scale: document.documentElement.getAttribute('data-type-scale'),
      font: parseFloat(getComputedStyle(document.querySelector('.article p')).fontSize),
    }))()`);
    const targetScale = Math.max(1, Number(beforeAa.scale) - 2);
    await setSlider(cdp, sessionId, 'typeset-type-scale', targetScale);
    await sleep(300);
    const afterAa = await evaluate(cdp, sessionId, `(() => ({
      scale: document.documentElement.getAttribute('data-type-scale'),
      font: parseFloat(getComputedStyle(document.querySelector('.article p')).fontSize),
      sheetValue: document.querySelector('[data-testid="typeset-type-scale"]')?.value ?? null,
    }))()`);
    check('Aa 滑块改变档位', String(afterAa.scale) === String(targetScale), `${beforeAa.scale} → ${afterAa.scale}`);
    check('Aa 滑块让正文字号真的变小', afterAa.font < beforeAa.font, `${beforeAa.font}px → ${afterAa.font}px`);
    check('Aa 面板内滑块值与档位一致', String(afterAa.sheetValue) === String(targetScale), String(afterAa.sheetValue));

    // 滑块拖到最大再确认正文变大（边界方向也测一次）
    await setSlider(cdp, sessionId, 'typeset-type-scale', 7);
    await sleep(300);
    const maxFont = await evaluate(cdp, sessionId,
      `parseFloat(getComputedStyle(document.querySelector('.article p')).fontSize)`);
    check('Aa 拖到最大档正文变大', maxFont > afterAa.font, `${afterAa.font}px → ${maxFont}px`);

    await click(cdp, sessionId, 'typeset-close');
    check(
      '排版面板能关闭',
      (await evaluate(cdp, sessionId, `!document.querySelector('[data-testid="typeset-sheet"]')`)) === true,
    );
    await shot(cdp, sessionId, 'typo-reader-typeset-closed');

    // ── 6. 持久化 ──
    console.log('\n【持久化】');
    await cdp.send('Page.navigate', { url: server.url + '#/settings' }, sessionId);
    await sleep(900);
    await clickToEdge(cdp, sessionId, 'type-scale-decrease', 10);
    for (let i = 0; i < 4; i++) await click(cdp, sessionId, 'type-scale-increase');

    const beforeReload = await evaluate(
      cdp,
      sessionId,
      `document.documentElement.getAttribute('data-type-scale')`,
    );
    const stored = await evaluate(cdp, sessionId, `localStorage.getItem('mdlego:settings')`);
    check('设置已写入 localStorage', typeof stored === 'string' && stored.length > 10);

    await cdp.send('Page.reload', {}, sessionId);
    await sleep(1700);

    const afterReload = await evaluate(
      cdp,
      sessionId,
      `document.documentElement.getAttribute('data-type-scale')`,
    );
    check('刷新后字号档位仍保留', beforeReload === afterReload, `${beforeReload} → ${afterReload}`);

    await gotoAndWait(cdp, sessionId, server.url + '#/settings', 'type-scale-decrease');
    const persisted = await readTypography(cdp, sessionId);
    check(
      '刷新后计算字号与档位一致',
      persisted !== null && persisted.fontSize === 21,
      `${persisted?.fontSize}px（档位 5 期望 21px）`,
    );

    // ── 7. 主题 ──
    console.log('\n【主题】');
    const magBg = await evaluate(cdp, sessionId, `getComputedStyle(document.body).backgroundColor`);
    await click(cdp, sessionId, 'theme-night');
    await sleep(350);
    const nightBg = await evaluate(cdp, sessionId, `getComputedStyle(document.body).backgroundColor`);
    check('切换夜间后背景色改变', magBg !== nightBg, `${magBg} → ${nightBg}`);

    const nightAttr = await evaluate(
      cdp,
      sessionId,
      `document.documentElement.getAttribute('data-theme')`,
    );
    check('data-theme 属性为 night', nightAttr === 'night', String(nightAttr));

    await shot(cdp, sessionId, 'typo-night-settings');

    const nightReader = await openSampleDoc(cdp, sessionId);
    check('换了夜间主题后仍能打开阅读页', nightReader === true);
    await shot(cdp, sessionId, 'typo-night-reader');

    // 回到杂志日间
    await gotoAndWait(cdp, sessionId, server.url + '#/settings', 'theme-magazine');
    await click(cdp, sessionId, 'theme-magazine');
    await sleep(350);
    await openSampleDoc(cdp, sessionId);
    await shot(cdp, sessionId, 'typo-magazine-reader');

    // ── 8. 字号极值截图（阅读页） ──
    await gotoAndWait(cdp, sessionId, server.url + '#/settings', 'type-scale-decrease');
    await clickToEdge(cdp, sessionId, 'type-scale-decrease', 10);
    await openSampleDoc(cdp, sessionId);
    await shot(cdp, sessionId, 'typo-scale-min');

    await gotoAndWait(cdp, sessionId, server.url + '#/settings', 'type-scale-increase');
    await clickToEdge(cdp, sessionId, 'type-scale-increase', 10);
    await openSampleDoc(cdp, sessionId);
    await shot(cdp, sessionId, 'typo-scale-max');

    console.log('\n  截图：artifacts/screenshots/typo-*.png');
  } finally {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    await server.close();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log('');
  if (failed.length > 0) {
    console.error(`✗ 排版可调性验证失败：${failed.length}/${checks.length}`);
    for (const f of failed) console.error(`  - ${f.name}${f.detail ? `：${f.detail}` : ''}`);
    process.exit(1);
  }
  console.log(`✓ 排版可调性验证通过：${checks.length}/${checks.length}`);
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
