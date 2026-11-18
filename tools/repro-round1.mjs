#!/usr/bin/env node
/**
 * 第 1 轮缺陷复现/验收脚本（rc.2 修复用）。
 *
 * 与 smoke-chrome 的区别：
 *   - 全部用**真实触摸事件**（CDP Input.dispatchTouchEvent），不用 element.click()
 *   - 在动画**进行中**读数/抓帧，而不是只看结束状态
 *   - 每个 #N 对应任务书里的一个缺陷：修前运行必须 ✗，修后必须 ✓
 *
 * 用法：
 *   npm run build && node tools/repro-round1.mjs --out=before
 *   node tools/repro-round1.mjs --only=3,5 --out=after
 *
 * 退出码：任一断言失败 → 1（修前应返回 1，这就是修前证据）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { serveStatic } from './serve.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DIST_INDEX = join(ROOT, 'www', 'index.html');
const CDP_PORT = 9451;
const VIEWPORT = { width: 393, height: 873, deviceScaleFactor: 3, mobile: true };

const argv = process.argv.slice(2);
const onlyArg = argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map((s) => s.trim())) : null;
const outArg = argv.find((a) => a.startsWith('--out='));
const OUT = outArg ? outArg.slice('--out='.length) : 'run';
const SHOTS = join(ROOT, 'docs', 'screenshots', 'fix-round1', OUT);

const SAMPLE_MD = join(ROOT, 'artifacts', '.repro-round1.md');
const SAMPLE = `# 词根 -spect- 速查

来自拉丁语 specere，表示「看」。这一篇用来做真机/触摸复现的样本文档。

## 词族

| 单词 | 词性 | 释义 |
| --- | --- | --- |
| inspect | v. | 检查，仔细看 |
| retrospect | n. | 回顾，回想 |
| prospect | n. | 前景，展望 |
| spectator | n. | 观众 |

## 长难句

> It is the interaction between the two that gives rise to the phenomenon.

主干是 \`It is ... that ...\` 强调句。

- [x] 拆分主干与修饰成分
- [ ] 标记三个并列的介词短语

## 段落

阅读是为了遇见更大的世界。把每一段都写长一点，让阅读页可以滚动，
这样「向下滚动后点一下屏幕」的沉浸模式缺陷才能被复现出来。

第二段继续填充文字，保证滚动区域足够高。墨读是离线 Markdown 阅读器，
强调排版的呼吸感与翻页时的顺滑。

第三段用于测试空白处点击是否被残留选区吞掉。点击屏幕左边距或段落之间的
空白区域，应当切换沉浸模式（显示/隐藏顶栏底栏）。

\`\`\`ts
const roots = ['spect', 'spic'];
\`\`\`

## 结论

先复现，再修；修前证据必须留在仓库里。
`;

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (p && existsSync(p)) return p;
  return null;
}

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
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch { /* 未就绪 */ }
    await sleep(200);
  }
  throw new Error('Chrome 调试端口未就绪');
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: ok === true, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

let cdp;
let sid;

async function evaluate(expression) {
  const result = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    sid,
  );
  if (result.exceptionDetails) {
    const d = result.exceptionDetails;
    throw new Error(`页面脚本出错：${d.exception?.description ?? d.text}`);
  }
  return result.result.value;
}

async function shot(name) {
  const res = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sid);
  mkdirSync(SHOTS, { recursive: true });
  const file = join(SHOTS, `${name}.png`);
  writeFileSync(file, Buffer.from(res.data, 'base64'));
  return file;
}

/** 真实触摸：点一下（touchStart → touchEnd）。 */
async function tap(x, y) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
  }, sid);
  await sleep(16);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sid);
}

/** 找到元素中心并真触摸点击。 */
async function tapSelector(selector) {
  const rect = await evaluate(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  })()`);
  if (!rect) throw new Error(`找不到元素：${selector}`);
  await tap(rect.x, rect.y);
  return rect;
}

async function waitFor(selector, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
    await sleep(120);
  }
  return false;
}

/** 重新回到书架（如果在别的页）。 */
async function backToShelf() {
  for (let i = 0; i < 6; i += 1) {
    const onShelf = await evaluate(`!!document.querySelector('[data-testid="shelf"], [data-testid="shelf-empty"], [data-testid="shelf-hero"]')`);
    if (onShelf) return true;
    const state = await evaluate(`({
      reader: !!document.querySelector('[data-testid="back-to-shelf"]'),
      layer: !!document.querySelector('.sheet-layer, .menu-layer, [data-testid="marks-layer"]'),
      tab: !!document.querySelector('[data-testid="tab-shelf"]'),
    })`);
    if (state.layer) {
      await evaluate(`(() => {
        const btn = document.querySelector('.sheet-layer [data-testid$="-close"], .menu-scrim, .marks-close, [data-testid="typeset-close"]');
        if (btn) btn.click(); else document.body.click();
        return true;
      })()`);
    } else if (state.reader) {
      await evaluate(`document.querySelector('[data-testid="back-to-shelf"]').click()`);
    } else if (state.tab) {
      await evaluate(`document.querySelector('[data-testid="tab-shelf"]').click()`);
    }
    await sleep(500);
  }
  return evaluate(`!!document.querySelector('[data-testid="shelf"], [data-testid="shelf-empty"], [data-testid="shelf-hero"]')`);
}

async function goto(selector) {
  await tapSelector(selector);
  await sleep(500);
}

/** 把应用恢复到「书架上有一篇既在继续阅读、又在网格里」的状态。 */
async function ensureLibrary() {
  await backToShelf();
  const docs = await evaluate(`document.querySelectorAll('[data-testid="doc-item"]').length`);
  if (docs === 0) {
    await goto('[data-testid="import-file"]');
    await sleep(300);
    const { root } = await cdp.send('DOM.getDocument', {}, sid);
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' }, sid);
    if (!nodeId) throw new Error('应用未创建文件输入框');
    await cdp.send('DOM.setFileInputFiles', { files: [SAMPLE_MD], nodeId }, sid);
    await sleep(1500);
    await cdp.send('Page.reload', {}, sid);
    await sleep(1800);
  }
  // 打开再返回：产生 lastReadAt 与进度 → 继续阅读 + 网格同时出现同一篇
  if (!(await evaluate(`!!document.querySelector('[data-testid="continue-open"]')`))) {
    await tapSelector('[data-testid="doc-item"] .book-card__title');
    await sleep(900);
    const back = await evaluate(`!!document.querySelector('[data-testid="back-to-shelf"]')`);
    if (back) {
      await tapSelector('[data-testid="back-to-shelf"]');
      await sleep(900);
    }
  }
  return evaluate(`({
    covers: [...document.querySelectorAll('[data-cover-doc]')].map(e => e.getAttribute('data-cover-doc')),
    grid: document.querySelectorAll('[data-testid="doc-item"]').length,
    continueOpen: !!document.querySelector('[data-testid="continue-open"]'),
  })`);
}

// ── #1 双封面同时在飞 ────────────────────────────────────────
async function scenario1() {
  console.log('\n#1 打开书籍：共享矩形是否取对了封面');
  await ensureLibrary();
  const info = await evaluate(`(() => {
    const docId = document.querySelector('[data-cover-doc]')?.getAttribute('data-cover-doc') ?? null;
    return {
      docId,
      sameDocCovers: [...document.querySelectorAll('[data-cover-doc]')]
        .filter(e => e.getAttribute('data-cover-doc') === docId).length,
      gridCard: !!document.querySelector('[data-testid="doc-item"] .book-card__title'),
      gridCoverRect: (() => {
        const c = document.querySelector('[data-testid="doc-item"] [data-cover-doc]');
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      })(),
    };
  })()`);
  check('#1 前置：同一本书同时出现在「继续阅读」与网格', info.sameDocCovers >= 2, `同 docId 封面 ${info.sameDocCovers} 个`);

  // 记录转场命名：拦截 setProperty('view-transition-name')
  await evaluate(`(() => {
    window.__vt = [];
    const proto = CSSStyleDeclaration.prototype;
    if (!proto.__vtPatched) {
      const orig = proto.setProperty;
      proto.setProperty = function (name, value, priority) {
        const out = orig.call(this, name, value, priority);
        if (name === 'view-transition-name') {
          let owner = null;
          for (const el of document.querySelectorAll('*')) if (el.style === this) { owner = el; break; }
          const card = owner?.closest('[data-doc-id]') ?? null;
          const r = owner?.getBoundingClientRect?.() ?? null;
          const cr = card?.getBoundingClientRect?.() ?? null;
          window.__vt.push({
            value,
            tag: owner?.tagName ?? null,
            cls: String(owner?.className ?? ''),
            coverDoc: owner?.getAttribute?.('data-cover-doc') ?? null,
            inClickedCard: card !== null,
            cardDoc: card?.getAttribute('data-doc-id') ?? null,
            rect: r ? { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null,
            cardRect: cr ? { l: Math.round(cr.left), t: Math.round(cr.top), w: Math.round(cr.width), h: Math.round(cr.height) } : null,
          });
        }
        return out;
      };
      proto.__vtPatched = true;
    }
    return true;
  })()`);

  // 真触摸点「网格卡片的标题区域」
  const titleRect = await evaluate(`(() => {
    const t = document.querySelector('[data-testid="doc-item"] .book-card__title');
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 };
  })()`);
  if (!titleRect) throw new Error('#1 找不到网格卡片标题');
  await tap(titleRect.x, titleRect.y);
  await sleep(80);
  const frames = [];
  for (const delay of [0, 80, 80]) {
    if (delay) await sleep(delay);
    frames.push(await shot(`01-transition-${80 * (frames.length + 1)}ms`));
  }
  const vt = await evaluate(`window.__vt ?? []`);
  const covers = vt.filter((v) => v.coverDoc !== null);
  const namesInClicked = covers.filter((v) => v.inClickedCard && v.cardDoc === info.docId);
  check('#1 转场只命名 ≤1 个封面', covers.length <= 1, `命名封面 ${covers.length} 个：${covers.map((c) => c.cls).join(' / ') || '(无)'}`);
  check('#1 命名的封面在被点卡片内',
    covers.length === 0 || namesInClicked.length === covers.length,
    covers.length === 0 ? '(未做共享矩形)' : covers.map((c) => `${c.cls}${c.inClickedCard ? ' 卡内' : ' 卡外'} @${c.rect?.l},${c.rect?.t} ${c.rect?.w}x${c.rect?.h}`).join(' / '));
  const gridCoverRect = info.gridCoverRect;
  check('#1 共享矩形起点=被点卡片里的那张封面',
    covers.length === 0 || (covers[0].rect !== null && gridCoverRect !== null
      && Math.abs(covers[0].rect.l - gridCoverRect.l) <= 2 && Math.abs(covers[0].rect.t - gridCoverRect.t) <= 2),
    covers.length === 0 ? '(未做共享矩形)'
      : `命名封面 ${covers[0].rect?.l},${covers[0].rect?.t} vs 网格卡片封面 ${gridCoverRect?.l},${gridCoverRect?.t}`);
  check('#1 转场进行中已抓 3 帧', frames.length === 3, frames.map((f) => f.split(/[\\/]/).pop()).join(', '));

  // 返回路径
  await waitFor('[data-testid="back-to-shelf"]');
  await evaluate(`window.__vt = []`);
  await tapSelector('[data-testid="back-to-shelf"]');
  await sleep(400);
  const backVt = await evaluate(`window.__vt ?? []`);
  const backCovers = backVt.filter((v) => v.coverDoc !== null);
  check('#1 返回时命名的封面也在书架内（非继续阅读以外的错误封面）',
    backCovers.length <= 1 && backCovers.every((c) => c.inClickedCard || c.cls.includes('cover')),
    backCovers.map((c) => `${c.cls}${c.inClickedCard ? ' 卡内' : ' 卡外'}`).join(' / ') || '(无)');
  await sleep(600);
}

// ── #2 设置页字号层级与分段控件换行 ─────────────────────────
async function scenario2() {
  console.log('\n#2 设置页层级与分段控件排版');
  await ensureLibrary();
  await goto('[data-testid="tab-settings"]');
  await sleep(500);

  const hierarchy = await evaluate(`(() => {
    const out = [];
    for (const sec of document.querySelectorAll('.settings-section')) {
      const title = sec.querySelector('.settings-section__title');
      const label = sec.querySelector('.settings-row__label');
      if (!title || !label) continue;
      const ts = parseFloat(getComputedStyle(title).fontSize);
      const ls = parseFloat(getComputedStyle(label).fontSize);
      out.push({
        section: (title.textContent ?? '').trim(),
        titlePx: ts,
        labelPx: ls,
        titleColor: getComputedStyle(title).color,
        labelColor: getComputedStyle(label).color,
        iconPx: parseFloat(getComputedStyle(title.querySelector('.icon') ?? title).width) || 0,
      });
    }
    return out;
  })()`);
  console.log('    分区字号：' + hierarchy.map((h) => `${h.section} ${h.titlePx}/${h.labelPx}px`).join('，'));
  check('#2 每个分区标题字号 > 其下设置项标题',
    hierarchy.length > 0 && hierarchy.every((h) => h.titlePx > h.labelPx),
    hierarchy.filter((h) => h.titlePx <= h.labelPx).map((h) => h.section).join(',') || '全部通过');

  // 分段控件：每段文字必须只占一行（Range.getClientRects 行数 = 1）
  const segLines = await evaluate(`(() => {
    const bad = [];
    const all = [];
    for (const item of document.querySelectorAll('.ui-seg__item')) {
      const text = [...item.childNodes].find(n => n.nodeType === 3 && (n.textContent ?? '').trim());
      let lines = 1;
      if (text) {
        const range = document.createRange();
        range.selectNodeContents(text);
        lines = range.getClientRects().length;
      }
      const r = item.getBoundingClientRect();
      all.push({ label: (item.textContent ?? '').trim(), lines, h: Math.round(r.height), w: Math.round(r.width) });
      if (lines > 1) bad.push(item.textContent.trim() + ' (' + lines + ' 行)');
    }
    return { all, bad };
  })()`);
  check('#2 分段控件文字不被挤成竖排/多行',
    segLines.all.length > 0 && segLines.bad.length === 0,
    segLines.bad.join('，') || `${segLines.all.length} 段全部单行`);

  await shot('02-settings');
  await evaluate(`scrollTo(0, 0)`);
  await sleep(300);

  // 其它页面：标题不得比正文还小（任务书 #2 第 3 条）
  const audit = async (label, rootSelector) => evaluate(`(() => {
    const root = ${JSON.stringify(rootSelector)} ? document.querySelector(${JSON.stringify(rootSelector)}) : document.body;
    if (!root) return { maxHead: 0, maxBody: 0, headItems: [], bodyItems: [], missing: true };
    const heads = [...root.querySelectorAll('h1, h2, h3, [class*="__title"], [class*="section-title"], .sheet-panel__title')]
      .filter(e => (e.textContent ?? '').trim().length > 0 && e.getClientRects().length > 0);
    const body = [...root.querySelectorAll('p, [class*="__desc"], [class*="__label"], [class*="sheet-row__label"]')]
      .filter(e => (e.textContent ?? '').trim().length > 4 && e.getClientRects().length > 0);
    const desc = (arr) => arr
      .map((e) => ({ px: parseFloat(getComputedStyle(e).fontSize), cls: String(e.className || e.tagName).slice(0, 30) }))
      .sort((a, b) => b.px - a.px).slice(0, 4);
    const maxHead = Math.max(0, ...heads.map(e => parseFloat(getComputedStyle(e).fontSize)));
    const maxBody = Math.max(0, ...body.map(e => parseFloat(getComputedStyle(e).fontSize)));
    return { maxHead, maxBody, headItems: desc(heads), bodyItems: desc(body) };
  })()`).then((r) => ({ label, ...r }));

  const pages = [];
  await goto('[data-testid="tab-stats"]');
  await sleep(600);
  pages.push(await audit('统计页'));
  await shot('02-stats');
  await goto('[data-testid="tab-search"]');
  await sleep(700);
  pages.push(await audit('搜索页'));
  await shot('02-search');
  const backOk = await backToShelf();
  const pageInfo = await evaluate(`({
    text: (document.body.innerText || '').slice(0, 50),
    grid: !!document.querySelector('[data-testid="doc-item"]'),
    tabbar: !!document.querySelector('[data-testid="tabbar"]'),
  })`);
  if (!pageInfo.grid) throw new Error('#2 没回到书架：' + JSON.stringify({ backOk, ...pageInfo }));
  await tapSelector('[data-testid="doc-item"]');
  await sleep(900);
  await evaluate(`document.querySelector('[data-testid="reader-more"]').click()`);
  await sleep(400);
  await evaluate(`document.querySelector('[data-testid="open-editor"]').click()`);
  await sleep(900);
  pages.push(await audit('编辑页'));
  await shot('02-editor');
  await evaluate(`document.querySelector('[data-testid="editor-back"]')?.click()`);
  await sleep(700);
  await backToShelf();
  await goto('[data-testid="tab-settings"]');
  await sleep(500);
  await evaluate(`document.querySelector('[data-testid="settings-wordbook-open"]').click()`);
  await sleep(800);
  pages.push(await audit('生词本', '[data-testid="wordbook-sheet"]'));
  await shot('02-wordbook');
  await evaluate(`document.querySelector('[data-testid="wordbook-close"], .sheet-layer [data-testid$="-close"]')?.click()`);
  await sleep(500);
  await backToShelf();
  await tapSelector('[data-testid="doc-item"]');
  await sleep(900);
  await evaluate(`document.querySelector('[data-testid="open-typeset"]').click()`);
  await sleep(700);
  pages.push(await audit('排版面板', '[data-testid="typeset-sheet"]'));
  await evaluate(`document.querySelector('[data-testid="typeset-close"]')?.click()`);
  await sleep(400);
  await backToShelf();

  console.log('    其它页字号：' + pages.map((p) => `${p.label} 标题${p.maxHead}/正文${p.maxBody}`).join('，'));
  check('#2 其它页标题字号不小于正文',
    pages.length >= 5 && pages.every((p) => p.missing !== true && p.maxHead >= p.maxBody - 0.5),
    pages.filter((p) => p.maxHead < p.maxBody - 0.5).map((p) => p.label).join(',') || '全部通过');
  await backToShelf();
}

// ── #3 阅读页点击被吞 ──────────────────────────────────────
async function scenario3() {
  console.log('\n#3 阅读页空白处点击是否一次生效');
  await ensureLibrary();
  await tapSelector('[data-testid="doc-item"]');
  await sleep(1000);
  if (!(await waitFor('[data-testid="article"]'))) throw new Error('#3 阅读页没打开');

  // 真实滚轮滚到中部：让「滚动自动收放」把顶栏收起
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: 200, y: 420, deltaX: 0, deltaY: 900,
  }, sid);
  await sleep(700);
  const before = await evaluate(`(() => {
    const page = document.querySelector('.reader-page');
    return { bars: page?.getAttribute('data-bars'), immersive: page?.getAttribute('data-immersive'), y: Math.round(scrollY) };
  })()`);
  check('#3 前置：滚动后顶栏已自动收起', before.bars === 'hidden', `bars=${before.bars} y=${before.y}`);

  // 点到正文左侧空白处（真实触摸）
  // 选一个确定的「正文空白点」：左内边距、屏幕纵向 55% 处（顶栏只有 103px 高）
  const spot = await evaluate(`(() => {
    const x = 5;
    const y = Math.round(innerHeight * 0.55);
    const el = document.elementFromPoint(x, y);
    return { x, y, hitCls: String(el?.className ?? ''), hitTag: el?.tagName ?? null, vh: innerHeight };
  })()`);
  await evaluate(`(() => {
    window.__clicks = 0;
    const main = document.querySelector('[data-testid="article"]')?.parentElement ?? document.body;
    main.addEventListener('click', () => { window.__clicks += 1; }, true);
    return true;
  })()`);
  await tap(spot.x, spot.y);
  await sleep(120);
  const afterFirst = await evaluate(`document.querySelector('.reader-page')?.getAttribute('data-bars')`);
  check('#3 滚动后第一次点击就让顶栏出现', afterFirst === 'shown', `data-bars=${afterFirst}`);
  await shot('03-immersive-first-tap');

  await tap(spot.x, spot.y);
  await sleep(160);
  const afterSecond = await evaluate(`(() => {
    const page = document.querySelector('.reader-page');
    return {
      bars: page?.getAttribute('data-bars'),
      immersive: page?.getAttribute('data-immersive'),
      clicks: window.__clicks,
      hit: (document.elementFromPoint(${spot.x}, ${spot.y})?.className ?? '') + '|' + document.elementFromPoint(${spot.x}, ${spot.y})?.tagName,
    };
  })()`);
  check('#3 第二次点击把顶栏收起', afterSecond.bars === 'hidden', `data-bars=${afterSecond.bars} immersive=${afterSecond.immersive} clicks=${afterSecond.clicks} 命中=${afterSecond.hit}`);

  // 残留选区（工具条已消失）时点击不能被吞
  // 先真实收起工具条（pointerdown 外部 → onOutsideDown 清 activeToolbar），
  // 再放回一个 Range（不派发 selectionchange，因此不会重新弹工具条）。
  await evaluate(`(() => {
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, capture: true }));
    return true;
  })()`);
  await sleep(150);
  await evaluate(`(() => {
    const p = document.querySelector('[data-testid="article"] p');
    if (!p || !p.firstChild) return false;
    const range = document.createRange();
    range.setStart(p.firstChild, 0);
    range.setEnd(p.firstChild, Math.min(6, p.firstChild.textContent.length));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  })()`);
  const barsBeforeSelectionTap = await evaluate(`document.querySelector('.reader-page')?.getAttribute('data-bars')`);
  await tap(spot.x, spot.y);
  await sleep(150);
  const afterSelectionTap = await evaluate(`(() => ({
    bars: document.querySelector('.reader-page')?.getAttribute('data-bars'),
    selLen: getSelection()?.toString().length ?? 0,
  }))()`);
  check('#3 残留选区+点击：先清选区，再切换沉浸',
    afterSelectionTap.bars !== barsBeforeSelectionTap && afterSelectionTap.selLen === 0,
    `bars ${barsBeforeSelectionTap}→${afterSelectionTap.bars}，选区残留 ${afterSelectionTap.selLen} 字符`);
  await shot('03-selection-residual-tap');

  await evaluate(`getSelection()?.removeAllRanges()`);
  await backToShelf();
}

// ── #4 横幅滑动时相邻卡片粘连 ───────────────────────────────
async function scenario4() {
  console.log('\n#4 横幅轮播：卡片间隙与实时圆点');
  await ensureLibrary();
  const layout = await evaluate(`(() => {
    const track = document.querySelector('.hero__track');
    const slides = [...document.querySelectorAll('.hero-slide')];
    if (!track || slides.length < 2) return null;
    const gapCss = getComputedStyle(track).columnGap || getComputedStyle(track).gap;
    const rects = slides.map(s => s.getBoundingClientRect());
    return {
      gapCss,
      gaps: rects.slice(1).map((r, i) => Math.round(r.left - rects[i].right)),
      width: Math.round(rects[0].width),
    };
  })()`);
  check('#4 前置：横幅至少两张可滑动', layout !== null, layout ? `gap=${layout.gapCss} 宽=${layout.width}` : '(不足两张)');
  check('#4 相邻卡片之间有可见间隙', layout !== null && layout.gaps.every((g) => g >= 8),
    layout ? `实际间隙 ${layout.gaps.join(',')}px` : '');
  const snap = await evaluate(`(() => {
    const s = [...document.querySelectorAll('.hero-slide')];
    return { stops: s.map((e) => getComputedStyle(e).scrollSnapStop), active: document.querySelector('.hero__dot.is-active') !== null };
  })()`);
  check('#4 每张卡片 scroll-snap-stop: always', snap.stops.length > 0 && snap.stops.every((v) => v === 'always'), snap.stops.join(','));
  check('#4 静止时当前分页点是拉长胶囊', snap.active === true, `is-active ${snap.active}`);

  // 真实触摸拖动到一半停住，抓帧看缝隙
  const trackRect = await evaluate(`(() => {
    const t = document.querySelector('.hero__track');
    const r = t.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
  })()`);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: trackRect.x + 120, y: trackRect.y, id: 1, force: 1 }],
  }, sid);
  for (const dx of [40, 80, 120]) {
    await sleep(60);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: trackRect.x + 120 - dx, y: trackRect.y, id: 1, force: 1 }],
    }, sid);
  }
  await sleep(120);
  const mid = await evaluate(`(() => {
    const track = document.querySelector('.hero__track');
    const slides = [...document.querySelectorAll('.hero-slide')];
    const rects = slides.map(s => s.getBoundingClientRect());
    const active = Math.round(track.scrollLeft / (rects[0]?.width || 1));
    const dots = [...document.querySelectorAll('.hero__dot')];
    const styles = slides.slice(0, 3).map(s => {
      const cs = getComputedStyle(s);
      return { opacity: Number(cs.opacity), transform: cs.transform };
    });
    return {
      scrollLeft: Math.round(track.scrollLeft),
      active,
      dotActive: dots.findIndex(d => d.getAttribute('aria-selected') === 'true'),
      gaps: rects.slice(1).map((r, i) => Math.round(r.left - rects[i].right)),
      styles,
    };
  })()`);
  await shot('04-hero-drag-mid');
  check('#4 拖动到一半时两张卡片仍有缝隙', mid.gaps.every((g) => g >= 8), `拖动中隙 ${mid.gaps.join(',')}px`);
  check('#4 拖动中分页点实时跟随', mid.dotActive === mid.active, `滚动 ${mid.scrollLeft}px → 索引 ${mid.active}，圆点 ${mid.dotActive}`);
  check('#4 非当前卡片有缩放/变淡', mid.styles.slice(1).some((s) => s.opacity < 0.95 || s.transform !== 'none'),
    JSON.stringify(mid.styles.slice(0, 3)));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sid);
  await sleep(600);
  await shot('04-hero-after');
}

// ── #5 加号按下横向扭动 ─────────────────────────────────────
async function scenario5() {
  console.log('\n#5 「＋」按钮按压是否横向跳');
  await ensureLibrary();
  const before = await evaluate(`(() => {
    const e = document.querySelector('[data-testid="import-file"]');
    const r = e.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, transform: getComputedStyle(e).transform };
  })()`);
  await shot('05-plus-idle');

  // 真机触摸按住（headless 下 :active 由 CSS.forcePseudoState 精确模拟，见下）
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: before.cx, y: before.cy, id: 1, force: 1 }],
  }, sid);
  await sleep(360);
  const touchActive = await evaluate(`document.querySelector('[data-testid="import-file"]').matches(':active')`);
  await shot('05-plus-touch-pressed');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }, sid);
  await sleep(300);

  // 精确按压态：CSS.forcePseudoState 强制 :active，读到的是真实级联结果
  await cdp.send('DOM.enable', {}, sid);
  await cdp.send('CSS.enable', {}, sid);
  const { root } = await cdp.send('DOM.getDocument', {}, sid);
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid="import-file"]' }, sid);
  await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['active'] }, sid);
  await sleep(240);
  const pressed = await evaluate(`(() => {
    const e = document.querySelector('[data-testid="import-file"]');
    const r = e.getBoundingClientRect();
    return { cx: r.left + r.width / 2, w: r.width, transform: getComputedStyle(e).transform, active: e.matches(':active') };
  })()`);
  await shot('05-plus-pressed');
  await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }, sid);
  await sleep(400);
  const after = await evaluate(`(() => {
    const e = document.querySelector('[data-testid="import-file"]');
    const r = e.getBoundingClientRect();
    return { cx: r.left + r.width / 2 };
  })()`);
  await shot('05-plus-released');

  check('#5 按住时中心点 x 不位移（<0.5px）', Math.abs(pressed.cx - before.cx) < 0.5,
    `按下前 ${before.cx.toFixed(1)} → 按住 ${pressed.cx.toFixed(1)}（Δ${(pressed.cx - before.cx).toFixed(1)}px）${touchActive ? ' · 触摸态已触发' : ''}`);
  check('#5 按住时宽度约为 94%', Math.abs(pressed.w / before.w - 0.94) < 0.03,
    `${before.w.toFixed(1)} → ${pressed.w.toFixed(1)}（${(pressed.w / before.w * 100).toFixed(1)}%）`);
  check('#5 松手后回到原位',
    Math.abs(after.cx - before.cx) < 0.5, `松手 ${after.cx.toFixed(1)} vs ${before.cx.toFixed(1)}`);
  check('#5 按压态确实生效（不是空测）', pressed.active === true && pressed.transform !== before.transform,
    `:active=${pressed.active} transform ${before.transform} → ${pressed.transform}`);

  // 全仓审计：静止时带 transform 位移/居中、又带 ui-press 的元素
  const audit = await evaluate(`(() => {
    const bad = [];
    for (const e of document.querySelectorAll('.ui-press')) {
      const t = getComputedStyle(e).transform;
      if (t && t !== 'none' && !t.startsWith('matrix(1, 0, 0, 1')) {
        bad.push((e.className || e.tagName) + ' → ' + t);
      }
    }
    return bad;
  })()`);
  check('#5 其它 ui-press 元素不靠 transform 定位', audit.length === 0, audit.join(' | ') || '无');
}

// ── #6 排版面板 × 与顶栏玻璃 ────────────────────────────────
async function scenario6() {
  console.log('\n#6 P2：排版面板关闭键位置 / 阅读页顶部玻璃带');
  await ensureLibrary();
  await tapSelector('[data-testid="doc-item"]');
  await sleep(900);

  // (a) 顶栏在 scrollY=0 时应当透明
  await evaluate(`scrollTo(0, 0)`);
  await sleep(400);
  const topbar = await evaluate(`(() => {
    const h = document.querySelector('.appbar');
    const cs = getComputedStyle(h);
    return {
      bg: cs.backgroundColor,
      blur: cs.backdropFilter,
      dataScrolled: h.getAttribute('data-scrolled'),
    };
  })()`);
  const alpha = (() => {
    const m = topbar.bg.match(/rgba?\(([^)]+)\)/);
    if (!m) return -1;
    const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
    return parts.length === 4 ? parts[3] : 1;
  })();
  check('#6 阅读页在顶部时顶栏完全透明', alpha === 0 && (topbar.blur === 'none' || topbar.blur === ''),
    `bg=${topbar.bg} blur=${topbar.blur} data-scrolled=${topbar.dataScrolled}`);
  await shot('06-reader-top-transparent');

  // 滚动后应出现玻璃
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 420, deltaX: 0, deltaY: 300 }, sid);
  await sleep(500);
  const scrolled = await evaluate(`(() => {
    const h = document.querySelector('.appbar');
    const cs = getComputedStyle(h);
    return { bg: cs.backgroundColor, blur: cs.backdropFilter };
  })()`);
  check('#6 滚动后顶栏淡入玻璃', scrolled.blur !== 'none' && scrolled.bg !== 'rgba(0, 0, 0, 0)',
    `bg=${scrolled.bg} blur=${scrolled.blur}`);

  // (b) 排版面板关闭键必须贴在面板内，不能飘到屏幕顶部
  // 先把顶栏恢复到可见（顶部），否则 Aa 按钮停在 translate 后的事件区外
  await evaluate(`scrollTo(0, 0)`);
  await sleep(400);
  await tapSelector('[data-testid="open-typeset"]');
  await sleep(700);
  const panel = await evaluate(`(() => {
    const sheet = document.querySelector('.sheet-panel');
    const close = document.querySelector('[data-testid="typeset-close"]');
    if (!sheet || !close) return null;
    const s = sheet.getBoundingClientRect();
    const c = close.getBoundingClientRect();
    return {
      sheetTop: Math.round(s.top), sheetH: Math.round(s.height),
      closeTop: Math.round(c.top), closeBottom: Math.round(c.bottom),
      inside: c.top >= s.top - 8 && c.bottom <= s.bottom + 8,
    };
  })()`);
  check('#6 排版面板关闭键贴在面板内（不浮到屏幕顶部）', panel !== null && panel.inside === true,
    panel === null ? '(找不到面板/关闭键)' : `面板 ${panel.sheetTop}~${panel.sheetTop + panel.sheetH}，关闭键 ${panel.closeTop}~${panel.closeBottom}`);
  await shot('06-typeset-panel');
  await evaluate(`document.querySelector('[data-testid="typeset-close"]')?.click()`);
  await sleep(400);
  await backToShelf();
}

async function main() {
  if (!existsSync(DIST_INDEX)) {
    console.error('✗ 未找到 www/index.html，请先运行 npm run build');
    process.exit(1);
  }
  const chrome = findChrome();
  if (!chrome) {
    console.error('✗ 未找到 Chrome');
    process.exit(1);
  }
  writeFileSync(SAMPLE_MD, SAMPLE, 'utf8');
  mkdirSync(SHOTS, { recursive: true });

  const server = await serveStatic(join(ROOT, 'www'));
  const proc = spawn(chrome, [
    `--remote-debugging-port=${CDP_PORT}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    '--user-data-dir=' + join(ROOT, 'artifacts', '.chrome-repro-profile'),
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    const wsUrl = await connect(CDP_PORT);
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });
    cdp = new Cdp(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sid = attached.sessionId;

    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Runtime.enable', {}, sid);
    await cdp.send('DOM.enable', {}, sid);
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, screenWidth: VIEWPORT.width, screenHeight: VIEWPORT.height }, sid);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sid);

    await cdp.send('Page.navigate', { url: server.url }, sid);
    await sleep(900);
    await evaluate(`(() => {
      localStorage.clear();
      return new Promise((res) => {
        const r = indexedDB.deleteDatabase('mdlego');
        r.onsuccess = r.onerror = r.onblocked = () => res(true);
      });
    })()`);
    await cdp.send('Page.reload', {}, sid);
    await sleep(1800);

    const scenes = { 1: scenario1, 2: scenario2, 3: scenario3, 4: scenario4, 5: scenario5, 6: scenario6 };
    for (const [n, fn] of Object.entries(scenes)) {
      if (ONLY && !ONLY.has(n)) continue;
      try {
        await fn();
      } catch (error) {
        check(`#${n} 场景执行`, false, String(error.message).slice(0, 200));
      }
    }

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
    if (failed.length > 0) {
      console.log('失败项：\n' + failed.map((f) => `  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`).join('\n'));
      console.log(`截图：${SHOTS}`);
      process.exitCode = 1;
    } else {
      console.log(`截图：${SHOTS}`);
    }
  } finally {
    try { proc.kill(); } catch { /* 进程已退出 */ }
    await server.close();
  }
}

await main();
