#!/usr/bin/env node
/**
 * 查词弹层（lookup sheet）打包产物验收。
 *
 * 只用 `vite build` 的 www 产物（vite preview 提供），真触摸（CDP Input.dispatchTouchEvent）
 * 长按英文词，逐项断言：
 *   【1】把手是弹层第一个子元素、水平居中、距弹层顶部约 8px，且不在标题行里
 *   【2】底部弹层没有顶部安全区内边距（弹层上沿 → 标题行上沿 ≤ 28px）
 *   【3】标题行垂直居中；两个按钮视觉高度 36px、点击区 ≥ 44px
 *   【4】最大高度 min(60vh, 520px)；内容区可滚动 + 底部渐隐；底部内边距含 --safe-bottom
 *   【5】弹层背景延伸到底（弹层底 == 视口底），无「半裁圆角块」
 *   【6】被查词不被弹层遮住（必要时把正文滚到词位于弹层上方）
 *   【7】词性标签 / 中文标点 / 标准 IPA / 词形行
 *   【8】弹出只动 transform+opacity、遵守动效强度；把手与标题行都能下拉关闭
 *
 * 用法：
 *   npm run build
 *   node tools/verify-lookup-sheet.mjs                       # 日间主题断言
 *   node tools/verify-lookup-sheet.mjs --theme=warm-night    # 夜间主题
 *   node tools/verify-lookup-sheet.mjs --out=before          # 修前证据（截图存 before/）
 *
 * 安全区在无头浏览器里用 CSS 变量模拟（Android 真值由原生层注入 --android-safe-*）。
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const WWW = join(ROOT, 'www');
const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const OUT = argOf('out', 'after');
const THEME = argOf('theme', 'warm-paper');
const MOTION = argOf('motion', 'full');
const SHOTS = join(ROOT, 'docs', 'screenshots', 'lookup-sheet', OUT);
const PREVIEW_PORT = 4175;
const CDP_PORT = 9455;
const VIEWPORT = { width: 393, height: 873, deviceScaleFactor: 3, mobile: true };
/** 模拟真机安全区：状态栏 24px、手势条 34px。 */
const SAFE = { top: 24, bottom: 34 };
const SAMPLE = join(ROOT, 'artifacts', '.lookup-sample.md');

const SAMPLE_TEXT = `# 查词弹层样张

长按查词要能稳定命中英文词。为了验证「被查词是否会被弹层遮住」，
这一段故意写在文档靠后的位置，打开后先把它滚到屏幕下方再长按。

## 第一节

夜色像一张浸过水的宣纸，字迹慢慢洇开。阅读器把每一页都留在手边，
不催你往前，也不催你回头。

- [x] 打开文档
- [ ] 长按一个英文词

## 第二节

The prospect of discovering new phenomena persisted through the long winter.
真正的难点从来不是查到一个词，而是让这个词在阅读的节奏里不打断你。
弹层出现的位置、标题行的呼吸、释义的标点，都会影响这一秒的注意力。

### 长词条样张

下面这一行里有一个释义很长的词 incitative，用来验证 60vh 上限真的会触发滚动，
以及底部渐隐在滚到底之后会不会淡出（内容不足一屏时不该有「下面还有」的暗示）。

## 第三节

继续写一些填充段落，保证正文高度超过两屏，长按目标可以被滚到屏幕下方。
阅读是一件很慢的事，慢到可以听见纸页翻动的声音。窗外有风，屋里有灯。
把手机横过来又竖回去，文字仍然待在原来的位置，这就是好的阅读器。

最后一小段收尾。`;

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
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* 未就绪 */
    }
    await sleep(250);
  }
  return false;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
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
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`CDP 超时：${method}`));
        }
      }, 20000);
    });
  }
}

let cdp;
let sid;

const evalJs = async (expression) => {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    sid,
  );
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r.result?.value;
};

const shot = async (name) => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, `${THEME}-${name}.png`), Buffer.from(r.data, 'base64'));
};

const touch = async (type, x, y) => {
  const points =
    type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points }, sid);
};

const tap = async (x, y) => {
  await touch('touchStart', x, y);
  await sleep(16);
  await touch('touchEnd');
};

/**
 * 真触摸长按一个词并打开查词弹层。
 *
 * 现行产品（阶段 E2 起）的长按是「弹选区工具条」，查词是工具条上的一个按钮，
 * 所以真实用户路径是两步：长按取词 → 点工具条「查词」。两步都用真触摸。
 */
const longPress = async (x, y) => {
  const attempt = async () => {
    await touch('touchStart', x, y);
    await sleep(700);
    await touch('touchEnd');
    await sleep(450);
    const btn = await centerOf('[data-testid="mark-lookup"]');
    if (btn === null) return false;
    await tap(btn.x, btn.y);
    await sleep(500);
    return (await evalJs(`!!document.querySelector('.lookup-panel')`)) === true;
  };
  if (await attempt()) return true;
  // 第一次没成（工具条没出现或点偏）：关掉可能残留的浮层再试一次
  await evalJs(`(() => {
    const bar = document.querySelector('[data-testid="mark-toolbar"]');
    if (bar) bar.remove();
    return true;
  })()`);
  await sleep(150);
  return attempt();
};

const resetEmulation = async () => {
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    {
      ...VIEWPORT,
      screenWidth: VIEWPORT.width,
      screenHeight: VIEWPORT.height,
    },
    sid,
  );
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sid);
  await sleep(100);
};

/** 在正文里找第一个完整英文词，返回可点击坐标与矩形（找不到返回 null）。 */
const findWord = (word) =>
  evalJs(`(() => {
    const article = document.querySelector('[data-testid="article"]');
    if (!article) return null;
    const re = new RegExp('\\\\b' + ${JSON.stringify('')} + '${word}' + '\\\\b');
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) !== null) {
      const m = re.exec(node.data);
      if (!m) continue;
      const range = document.createRange();
      range.setStart(node, m.index);
      range.setEnd(node, m.index + ${word.length});
      const rect = range.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      const hit = { x: rect.left + Math.min(rect.width / 2, 12), y: rect.top + rect.height / 2 };
      window.__lookupWord = { word: ${JSON.stringify(word)}, rect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } };
      return { x: hit.x, y: hit.y, top: rect.top, bottom: rect.bottom };
    }
    return null;
  })()`);

/** 把目标词滚到视口指定比例处（模拟「词会被弹层遮住」的初始位置）。 */
const placeWordAt = async (word, ratio) => {
  for (let i = 0; i < 4; i += 1) {
    const found = await findWord(word);
    if (found === null) return null;
    const target = Math.round(VIEWPORT.height * ratio);
    const delta = found.top - target;
    if (Math.abs(delta) < 4) return found;
    await evalJs(`scrollBy(0, ${Math.round(delta)}); window.dispatchEvent(new Event('scroll')); true`);
    await sleep(250);
  }
  return findWord(word);
};

/**
 * 取一个释义足够长的词（incitative，ECDICT 里 16 行）验证滚动与渐隐。
 *
 * 注意：不能用「往文章里 append 一个 <p>」的办法造词 —— 选区取词依赖
 * render.blockTexts 的块索引，临时插入的段落不在索引里，取词会静默失败。
 * 所以这个词写在样张正文里（见 SAMPLE_TEXT 的「长词条样张」小节）。
 */
const placeWordInLongEntry = async (word) => placeWordAt(word, 0.5);

const MEASURE = `(() => {
  const q = (s) => document.querySelector(s);
  const rect = (e) => {
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
  };
  const style = (e) => {
    if (!e) return null;
    const s = getComputedStyle(e);
    return { paddingTop: s.paddingTop, paddingBottom: s.paddingBottom, marginTop: s.marginTop, marginBottom: s.marginBottom, maxHeight: s.maxHeight, overflowY: s.overflowY, alignItems: s.alignItems, borderRadius: s.borderRadius, backgroundColor: s.backgroundColor, opacity: s.opacity, display: s.display };
  };
  const panel = q('[data-testid="lookup-card"] .lookup-panel');
  const root = q('[data-testid="lookup-card"]');
  const head = panel ? panel.querySelector('.drawer__head') : null;
  const handle = q('[data-testid="lookup-handle"]');
  const body = q('[data-testid="lookup-body"]');
  const save = q('[data-testid="lookup-save-word"]');
  const close = q('[data-testid="lookup-close"]');
  const fade = q('[data-testid="lookup-fade"]');
  const pseudo = (e, which) => {
    if (!e) return null;
    const s = getComputedStyle(e, which);
    return { top: s.top, right: s.right, bottom: s.bottom, left: s.left, content: s.content, position: s.position };
  };
  const anims = (e) => (e ? e.getAnimations().map((a) => ({
    name: a.animationName ?? null,
    duration: a.effect ? a.effect.getTiming().duration : null,
    keyframes: a.effect ? a.effect.getKeyframes().map((k) => ({ transform: k.transform ?? null, opacity: k.opacity ?? null })) : [],
  })) : []);
  return {
    viewport: { w: innerWidth, h: innerHeight },
    scrollY: Math.round(window.scrollY),
    panel: rect(panel),
    panelStyle: style(panel),
    panelFirstChild: panel ? { tag: panel.firstElementChild?.tagName ?? null, cls: panel.firstElementChild?.className ?? null, isHandle: panel.firstElementChild === handle } : null,
    panelChildren: panel ? [...panel.children].map((e) => ({ tag: e.tagName, cls: String(e.className) })) : [],
    head: rect(head),
    headStyle: style(head),
    headChildren: head ? [...head.children].map((e) => ({ tag: e.tagName, cls: String(e.className), text: (e.textContent ?? '').trim().slice(0, 16), rect: rect(e), style: style(e) })) : [],
    handle: rect(handle),
    handleStyle: style(handle),
    handleParent: handle ? String(handle.parentElement?.className ?? '') : null,
    save: { rect: rect(save), style: style(save), pseudo: pseudo(save, '::after') },
    close: { rect: rect(close), style: style(close), pseudo: pseudo(close, '::after') },
    body: { rect: rect(body), style: style(body), scrollHeight: body ? body.scrollHeight : null, clientHeight: body ? body.clientHeight : null },
    fade: { rect: rect(fade), style: style(fade) },
    root: rect(root),
    translation: {
      lines: [...document.querySelectorAll('[data-testid="lookup-translation"] > *')].map((e) => e.textContent ?? ''),
      posTags: [...document.querySelectorAll('[data-testid="lookup-translation"] .lookup__pos, [data-testid="lookup-pos"]')].map((e) => ({ text: e.textContent ?? '', cls: String(e.className), style: style(e) })),
    },
    phonetic: q('[data-testid="lookup-phonetic"]')?.textContent ?? null,
    lemma: q('[data-testid="lookup-lemma"], [data-testid="lookup-form"]')?.textContent ?? null,
    word: (() => {
      // 重新定位这个词：__lookupWord.rect 是「查找那一刻」的快照，
      // 弹层让位滚动之后它已经过期了，必须按当前布局重算。
      const stored = window.__lookupWord;
      if (!stored) return null;
      const article = document.querySelector('[data-testid="article"]');
      if (!article) return { ...stored, rect: null };
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode()) !== null) {
        const at = node.data.toLowerCase().indexOf(String(stored.word).toLowerCase());
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + stored.word.length);
        const r = range.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        return { ...stored, rect: { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height } };
      }
      return { ...stored, rect: null };
    })(),
    panelAnimations: anims(panel),
    bodyLastVisible: (() => {
      if (!body) return null;
      const b = body.getBoundingClientRect();
      const kids = [...body.querySelectorAll('.lookup__line, .lookup__phonetic, .lookup__rule, .lookup__lemma, [data-testid="lookup-form"], .lookup__pos')];
      const rounded = [...body.querySelectorAll('*')].filter((e) => {
        const s = getComputedStyle(e);
        const r = s.borderTopLeftRadius;
        return r !== '0px' && r !== '' && s.display !== 'inline';
      });
      const crossingOf = (list) => list
        .map((e) => ({ cls: String(e.className), r: e.getBoundingClientRect() }))
        .filter((x) => x.r.height > 0 && x.r.top < b.bottom - 1 && x.r.bottom > b.bottom + 2)
        .map((x) => ({ cls: x.cls, cut: Math.round(b.bottom - x.r.top), height: Math.round(x.r.height) }));
      return { kids: kids.length, crossing: crossingOf(kids), roundedCut: crossingOf(rounded) };
    })(),
    fadeVisible: (() => {
      const f = document.querySelector('[data-testid="lookup-fade"]');
      if (!f) return null;
      const scroll = f.parentElement;
      return {
        opacity: parseFloat(getComputedStyle(f).opacity),
        atEnd: scroll?.getAttribute('data-at-end') ?? null,
        scrollable: body ? body.scrollHeight > body.clientHeight + 2 : null,
      };
    })(),
  };
})()`;

const measure = () => evalJs(MEASURE);

/** 清空存储 + 导入样张 + 打开文档。 */
async function prepareDoc() {
  await evalJs(`(() => {
    localStorage.clear();
    return new Promise((res) => {
      const r = indexedDB.deleteDatabase('mdlego');
      r.onsuccess = r.onerror = r.onblocked = () => res(true);
    });
  })()`);
  await cdp.send('Page.reload', {}, sid);
  await sleep(1600);
  // 主题 / 动效（首帧内联脚本会读 localStorage，所以先写设置再 reload）
  await evalJs(`(() => {
    localStorage.setItem('mdlego:settings', JSON.stringify({ schemaVersion: 5, settings: { theme: ${JSON.stringify(THEME)}, motion: ${JSON.stringify(MOTION)} } }));
    return true;
  })()`);
  await cdp.send('Page.reload', {}, sid);
  await sleep(1600);
  // 导入样张
  writeFileSync(SAMPLE, SAMPLE_TEXT, 'utf8');
  const importBtn = await centerOf('[data-testid="import-file"]');
  if (importBtn !== null) await tap(importBtn.x, importBtn.y);
  await sleep(350);
  if ((await evalJs(`!!document.querySelector('input[type=file]')`)) !== true) {
    await evalJs(`document.querySelector('[data-testid="import-file"]').click()`);
    await sleep(350);
  }
  const { root } = await cdp.send('DOM.getDocument', {}, sid);
  const { nodeId } = await cdp.send(
    'DOM.querySelector',
    { nodeId: root.nodeId, selector: 'input[type=file]' },
    sid,
  );
  if (!nodeId) throw new Error('应用未创建文件输入框');
  await cdp.send('DOM.setFileInputFiles', { files: [SAMPLE], nodeId }, sid);
  await sleep(1500);
  await cdp.send('Page.reload', {}, sid);
  await sleep(1600);
  // 从书架打开样张
  const card = await evalJs(`(() => {
    const cards = [...document.querySelectorAll('[data-testid="shelf-grid"] .book-card__title')];
    const hit = cards.find((c) => (c.textContent ?? '').includes('查词弹层样张')) ?? cards[0];
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (card === null) throw new Error('书架没有卡片');
  await tap(card.x, card.y);
  await sleep(1400);
  // 等分片补挂完成（否则靠后的段落还没进 DOM，找不到词）
  await evalJs(`(async () => {
    const article = document.querySelector('[data-testid="article"]');
    if (!article) return false;
    for (let i = 0; i < 60; i += 1) {
      const ev = new Event('mdlego:mount-next', { cancelable: true });
      document.dispatchEvent(ev);
      if (!ev.defaultPrevented) break;
      await new Promise((r) => requestAnimationFrame(r));
    }
    return true;
  })()`);
  await sleep(300);
  // 注入安全区（模拟真机 --android-safe-*；Chrome 的 env() 恒为 0）
  await evalJs(`(() => {
    document.documentElement.style.setProperty('--android-safe-top', '${SAFE.top}px');
    document.documentElement.style.setProperty('--android-safe-bottom', '${SAFE.bottom}px');
    return true;
  })()`);
  await sleep(120);
}

const centerOf = (selector) =>
  evalJs(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);

/** 下拉手势：从 (x,y) 拖到 (x,y+dy)，返回拖动中的读数（transform 与 translateY）。 */
async function dragDown(from, dy, steps = 12) {
  await touch('touchStart', from.x, from.y);
  await sleep(30);
  let mid = null;
  for (let i = 1; i <= steps; i += 1) {
    await touch('touchMove', from.x, from.y + (dy * i) / steps);
    await sleep(24);
    if (i === Math.round(steps * 0.6)) {
      mid = await evalJs(`(() => {
        const p = document.querySelector('.lookup-panel');
        if (!p) return null;
        const t = getComputedStyle(p).transform;
        const m = /matrix\\(1, 0, 0, 1, 0, (-?[\\d.]+)\\)/.exec(t);
        return { raw: t, ty: m ? Math.abs(parseFloat(m[1])) : 0 };
      })()`);
    }
  }
  return mid;
}

async function slideUp(x, y) {
  await touch('touchMove', x, y);
  await sleep(16);
  await touch('touchEnd');
}

/**
 * 极简静态服务器（只读，缺失即 404）。
 *
 * 为什么不用 `vite preview`：它对不存在的路径会回落成 index.html（SPA fallback），
 * 于是 /dict/d_pr.tsv（产物里只有 .tsv.gz）返回 200 + HTML，
 * 查词层按 TSV 解析出空表，所有词都变成「未收录」—— 探针会把产品缺陷误判成词库问题。
 * 装机后 WebView 读 assets 是文件语义（缺失就是缺失），这里与真机行为对齐。
 */
function startStaticServer(port) {
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.tsv': 'text/tab-separated-values; charset=utf-8',
    '.gz': 'application/gzip',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.txt': 'text/plain; charset=utf-8',
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    let file = join(WWW, decodeURIComponent(url.pathname));
    if (url.pathname === '/' || url.pathname.endsWith('/')) file = join(file, 'index.html');
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((res) => server.listen(port, '127.0.0.1', () => res(server)));
}

async function main() {
  if (CHROME === undefined) throw new Error('找不到 Chrome');
  const server = await startStaticServer(PREVIEW_PORT);
  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      '--headless=new',
      '--no-first-run',
      '--overscroll-history-navigation=0',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      `--user-data-dir=${join(ROOT, 'artifacts', '.chrome-lookup-profile')}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    if ((await waitUrl(`http://127.0.0.1:${PREVIEW_PORT}/`)) !== true) {
      throw new Error('vite preview 未就绪');
    }
    await waitUrl(`http://127.0.0.1:${CDP_PORT}/json/version`);
    const wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json())
      .webSocketDebuggerUrl;
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });
    cdp = new Cdp(ws);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    for (const domain of ['Page.enable', 'Runtime.enable', 'DOM.enable']) {
      await cdp.send(domain, {}, sid);
    }
    await resetEmulation();
    await cdp.send(
      'Page.navigate',
      { url: `http://127.0.0.1:${PREVIEW_PORT}/` },
      sid,
    );
    await sleep(1600);

    console.log(`\n【查词弹层】theme=${THEME} motion=${MOTION} out=${OUT}`);
    await prepareDoc();

    // 初始状态：先截图（关闭态）
    await shot('0-closed-before-open');

    // ── 长按目标词：先放到屏幕下方 68% 处，验证「会不会被弹层遮住」 ──
    const placed = await placeWordAt('prospect', 0.68);
    if (placed === null) throw new Error('正文里找不到 prospect（分片没挂完？）');
    const beforeOpen = await measure();
    if (argOf('debug', '0') === '1') {
      const hit = await evalJs(`(() => {
        const e = document.elementFromPoint(${placed.x}, ${placed.y});
        return e === null ? null : { tag: e.tagName, cls: String(e.className), text: (e.textContent ?? '').slice(0, 24) };
      })()`);
      console.log('    debug: elementFromPoint →', JSON.stringify(hit));
      await evalJs(`(() => {
        window.__ev = [];
        const a = document.querySelector('[data-testid="article"]');
        for (const t of ['pointerdown', 'pointerup', 'pointercancel', 'contextmenu', 'touchstart', 'touchend']) {
          a.addEventListener(t, (e) => window.__ev.push(t + ':' + (e.pointerType ?? '')), true);
        }
        return true;
      })()`);
    }
    await longPress(placed.x, placed.y);
    if (argOf('debug', '0') === '1') {
      console.log('    debug: events →', await evalJs(`JSON.stringify(window.__ev ?? [])`));
      console.log('    debug: lookup nodes →', await evalJs(`JSON.stringify([...document.querySelectorAll('[data-testid^="lookup"]')].map((e) => e.getAttribute('data-testid') + '=' + (e.textContent ?? '').slice(0, 40)))`));
      console.log('    debug: selection →', await evalJs(`String(document.getSelection() ?? '')`));
      console.log('    debug: caret →', await evalJs(`(() => {
        const r = document.caretRangeFromPoint(${placed.x}, ${placed.y});
        if (r === null) return 'null';
        const n = r.startContainer;
        const t = n.nodeType === 3 ? n.data : '';
        return JSON.stringify({ type: n.nodeType, offset: r.startOffset, around: t.slice(Math.max(0, r.startOffset - 12), r.startOffset + 14) });
      })()`));
      console.log('    debug: dict resources →', await evalJs(`JSON.stringify(performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('dict')))`));
      console.log('    debug: settings →', await evalJs(`localStorage.getItem('mdlego:settings')`));
      await shot('debug-after-longpress');
    }
    const opened = await measure();
    if (opened.panel === null) throw new Error('长按后弹层没有出现');
    await shot('1-open');

    console.log('\n【1】把手位置');
    check('把手是弹层第一个子元素', opened.panelFirstChild?.isHandle === true, JSON.stringify(opened.panelFirstChild));
    check('把手不在标题行里', opened.handleParent?.includes('drawer__head') !== true, `parent=${opened.handleParent}`);
    check(
      '把手水平居中（|Δcx| ≤ 1px）',
      opened.handle !== null && Math.abs(opened.handle.cx - opened.panel.cx) <= 1,
      opened.handle ? `Δ=${(opened.handle.cx - opened.panel.cx).toFixed(2)}px` : 'no handle',
    );
    check(
      '把手距弹层顶部约 8px（6–10px）',
      opened.handle !== null && opened.handle.top - opened.panel.top >= 6 && opened.handle.top - opened.panel.top <= 10,
      opened.handle ? `${(opened.handle.top - opened.panel.top).toFixed(1)}px` : 'no handle',
    );
    check(
      '标题行只放「竖线 + 词 + 生词本 + 关闭」',
      opened.headChildren.length === 4 && !opened.headChildren.some((c) => String(c.cls).includes('sheet-panel__handle')),
      opened.headChildren.map((c) => c.text || c.cls).join(' | '),
    );

    console.log('\n【2】顶部空白');
    check('弹层 padding-top 为 0', opened.panelStyle?.paddingTop === '0px', `padding-top=${opened.panelStyle?.paddingTop}`);
    check(
      '弹层上沿 → 标题行上沿 ≤ 28px（含把手）',
      opened.head !== null && opened.head.top - opened.panel.top <= 28,
      opened.head ? `${(opened.head.top - opened.panel.top).toFixed(1)}px` : 'no head',
    );

    console.log('\n【3】标题行对齐 / 按钮尺寸');
    check('标题行 align-items: center', opened.headStyle?.alignItems === 'center', `align-items=${opened.headStyle?.alignItems}`);
    const saveH = opened.save.rect?.height ?? 0;
    const closeH = opened.close.rect?.height ?? 0;
    check('生词本按钮视觉高度 36px', Math.abs(saveH - 36) <= 1, `${saveH.toFixed(1)}px`);
    check('关闭按钮视觉高度 36px', Math.abs(closeH - 36) <= 1, `${closeH.toFixed(1)}px`);
    const hitSize = (btn) => {
      if (btn.rect === null) return 0;
      const inset = (v) => Math.abs(parseFloat(v ?? '0')) || 0;
      return btn.rect.height + inset(btn.pseudo?.top) + inset(btn.pseudo?.bottom);
    };
    check('生词本点击区 ≥ 44px', hitSize(opened.save) >= 44, `${hitSize(opened.save).toFixed(1)}px`);
    check('关闭点击区 ≥ 44px', hitSize(opened.close) >= 44, `${hitSize(opened.close).toFixed(1)}px`);

    console.log('\n【4】内容裁切');
    const expectMax = Math.min(Math.round(VIEWPORT.height * 0.6), 520);
    const maxH = parseFloat(opened.panelStyle?.maxHeight ?? '0');
    check(`最大高度 min(60vh,520px) ≈ ${expectMax}px`, Math.abs(maxH - expectMax) <= 1, `max-height=${opened.panelStyle?.maxHeight}`);
    check('内容区 overflow-y: auto', opened.body.style?.overflowY === 'auto', `overflow-y=${opened.body.style?.overflowY}`);
    check(
      '存在底部渐隐提示（内容可滚时可见）',
      opened.fade.rect !== null && (opened.fadeVisible?.scrollable === false || opened.fadeVisible?.opacity > 0),
      opened.fade.rect ? `opacity=${opened.fadeVisible?.opacity} scrollable=${opened.fadeVisible?.scrollable}` : 'missing',
    );
    // 内容滚到底后渐隐必须淡掉，否则会一直误导「下面还有」。
    // 这一步要换一个释义很长的词（incitative，ECDICT 里 16 行），
    // 所以放到【4】-【6】全部用 prospect 量完之后再做，避免把面板状态搅乱。
    const safeBottom = SAFE.bottom;
    const padBottom = parseFloat(opened.panelStyle?.paddingBottom ?? '0');
    check(`底部内边距含 --safe-bottom（≥ ${safeBottom}px）`, padBottom >= safeBottom, `${padBottom}px`);
    check(
      '没有被裁切一半的内容块',
      (opened.bodyLastVisible?.crossing ?? []).length === 0,
      JSON.stringify(opened.bodyLastVisible?.crossing ?? []),
    );
    check(
      '没有被裁切一半的圆角块',
      (opened.bodyLastVisible?.roundedCut ?? []).length === 0,
      JSON.stringify(opened.bodyLastVisible?.roundedCut ?? []),
    );

    console.log('\n【5】贴底 / 层级');
    check(
      '弹层底 == 视口底（不高于手势条）',
      opened.panel !== null && Math.abs(opened.panel.bottom - VIEWPORT.height) <= 1,
      opened.panel ? `bottom=${opened.panel.bottom.toFixed(1)} / vh=${VIEWPORT.height}` : 'no panel',
    );
    // 阅读底栏（z-index 40）不许压到弹层内容上：弹层矩形内命中的最上层必须是弹层自己
    const overlap = await evalJs(`(() => {
      const panel = document.querySelector('.lookup-panel');
      if (!panel) return null;
      const b = panel.getBoundingClientRect();
      const dock = document.querySelector('[data-testid="reader-dock"], .reader-dock');
      const samples = [];
      for (const ratio of [0.25, 0.5, 0.75, 0.95]) {
        const y = b.top + b.height * ratio;
        const hit = document.elementFromPoint(b.left + b.width / 2, y);
        samples.push({
          ratio,
          covered: hit !== null && panel.contains(hit),
          top: hit === null ? null : (hit.closest('.reader-dock') ? 'reader-dock' : hit.className || hit.tagName),
        });
      }
      const dockRect = dock ? dock.getBoundingClientRect() : null;
      return {
        samples,
        dockOverlapsPanel: dockRect !== null && b.bottom > dockRect.top && b.top < dockRect.bottom,
      };
    })()`);
    check(
      '阅读底栏不压在弹层内容上',
      overlap !== null && overlap.samples.every((s) => s.covered === true),
      JSON.stringify(overlap?.samples ?? null),
    );
    // 弹层背景要覆盖到屏幕最底：底部安全区范围内不能露出正文/底栏，
    // 也不能与手势条之间留出色带（bottomGap 必须是 0）。
    const backBottom = await evalJs(`(() => {
      const panel = document.querySelector('.lookup-panel');
      if (!panel) return null;
      const b = panel.getBoundingClientRect();
      const y = b.bottom - 2;
      const hit = document.elementFromPoint(b.left + b.width / 2, y);
      return {
        covered: hit !== null && (panel.contains(hit) || hit === panel),
        bottomGap: Math.round(innerHeight - b.bottom),
      };
    })()`);
    check(
      '弹层背景延伸到屏幕最底（手势条区域无空隙、无其它层透出）',
      backBottom !== null && backBottom.covered === true && backBottom.bottomGap <= 1,
      JSON.stringify(backBottom),
    );
    // 底部安全区范围内逐点取样：任何一点的最上层都必须是弹层（背景真的画到了底）
    const stripSamples = await evalJs(`(() => {
      const panel = document.querySelector('.lookup-panel');
      if (!panel) return null;
      const b = panel.getBoundingClientRect();
      const out = [];
      for (let y = b.bottom - ${SAFE.bottom} + 1; y < b.bottom; y += 8) {
        for (const x of [4, Math.round(innerWidth / 2), innerWidth - 5]) {
          const hit = document.elementFromPoint(x, y);
          out.push({ y: Math.round(y), x, ok: hit !== null && (hit === panel || panel.contains(hit)) });
        }
      }
      return { total: out.length, bad: out.filter((s) => !s.ok) };
    })()`);
    check(
      `底部安全区（${SAFE.bottom}px）内取样全是弹层`,
      stripSamples !== null && stripSamples.bad.length === 0,
      `${stripSamples?.total ?? 0} 点，异常 ${JSON.stringify(stripSamples?.bad ?? [])}`,
    );

    console.log('\n【6】被查词可见');
    const wordAfter = opened.word?.rect ?? null;
    check(
      '被查词在弹层上方可见',
      wordAfter !== null && opened.panel !== null && wordAfter.bottom < opened.panel.top - 4,
      wordAfter && opened.panel ? `word.bottom=${wordAfter.bottom.toFixed(0)} panel.top=${opened.panel.top.toFixed(0)}` : 'no word',
    );
    check(
      '为露出词而下滚（不跳回顶部）',
      opened.scrollY > beforeOpen.scrollY,
      `scrollY ${beforeOpen.scrollY} → ${opened.scrollY}`,
    );
    // 关闭后不要求恢复位置，但阅读进度不能被写错：词仍在视口内、页面没有跳走
    await tap(8, 8); // 点遮罩关闭（左上角一定在遮罩上）
    await sleep(500);
    const afterClose = await measure();
    check('点遮罩可关闭', afterClose.panel === null, afterClose.panel === null ? 'closed' : 'still open');
    check(
      '关闭后页面没有跳走（词仍在视口内）',
      (() => {
        const w = afterClose.word?.rect;
        return w !== null && w.top >= -4 && w.bottom <= VIEWPORT.height + 4;
      })(),
      JSON.stringify(afterClose.word?.rect ?? null),
    );
    check(
      '关闭后阅读进度与滚动位置一致（不早于顶部、不超底部）',
      afterClose.scrollY >= 0 && afterClose.scrollY < 100000,
      `scrollY=${afterClose.scrollY}`,
    );
    // 真正的「不错位进度」：落库的百分比必须与当前滚动位置算出来的一致。
    // 让位滚动是普通 window.scrollBy，会照常触发进度保存；这里核对落库值。
    const progress = await evalJs(`(async () => {
      const article = document.querySelector('[data-testid="article"]');
      if (!article) return null;
      const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
      const expected = Math.round((scrollY / max) * 100);
      // 等一帧，让 persistProgress 的节流写盘落地
      await new Promise((r) => setTimeout(r, 600));
      const dbs = await indexedDB.databases().catch(() => []);
      if (!dbs.some((d) => d.name === 'mdlego')) return { expected, stored: null, note: 'no-db' };
      const db = await new Promise((res, rej) => {
        const req = indexedDB.open('mdlego');
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      if (!db.objectStoreNames.contains('docs')) { db.close(); return { expected, stored: null, note: 'no-docs-store' }; }
      // 阅读进度存在 docs 表的 doc.progress 上（不是独立表）
      const rows = await new Promise((res, rej) => {
        const tx = db.transaction('docs', 'readonly');
        const req = tx.objectStore('docs').getAll();
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      db.close();
      return {
        expected,
        stored: rows.map((r) => ({ title: r.title ?? null, progress: r.progress ?? null })),
      };
    })()`);
    const storedRows = Array.isArray(progress?.stored) ? progress.stored : [];
    const current = storedRows.find((r) => r.progress !== null && typeof r.progress.percent === 'number');
    const storedPercent = current ? Number(current.progress.percent) : NaN;
    check(
      '让位滚动后落库的阅读进度与实际滚动位置一致（差 ≤ 2%）',
      progress !== null && Number.isFinite(storedPercent) && Math.abs(storedPercent - progress.expected) <= 2,
      `expected=${progress?.expected}% stored=${Number.isFinite(storedPercent) ? `${storedPercent}%` : JSON.stringify(progress?.stored ?? null).slice(0, 160)}`,
    );
    await shot('2-closed');

    // ── 长词条：验证 60vh 真的会触发滚动、渐隐随滚到底淡出 ──
    console.log('\n【4b】长词条滚动与渐隐');
    const longPlaced = await placeWordInLongEntry('incitative');
    if (longPlaced !== null) {
      await longPress(longPlaced.x, longPlaced.y);
      const faded = await evalJs(`(() => {
        const body = document.querySelector('[data-testid="lookup-body"]');
        const fade = document.querySelector('[data-testid="lookup-fade"]');
        if (!body || !fade) return null;
        const scrollable = body.scrollHeight > body.clientHeight + 2;
        const atTop = parseFloat(getComputedStyle(fade).opacity);
        body.scrollTop = body.scrollHeight;
        body.dispatchEvent(new Event('scroll'));
        // 渐隐淡出有 --motion-fade-dur（220ms）过渡，等它跑完再读
        const settle = ${MOTION === 'off' || MOTION === 'simple' ? 60 : 400};
        return new Promise((res) => setTimeout(() => res({
          scrollable,
          opacityAtTop: atTop,
          opacityAtEnd: parseFloat(getComputedStyle(fade).opacity),
          atEnd: fade.parentElement?.getAttribute('data-at-end') ?? null,
        }), settle));
      })()`);
      check('长词条可滚动（60vh 生效）', faded !== null && faded.scrollable === true, JSON.stringify(faded));
      check(
        '可滚时渐隐可见、滚到底后淡出',
        faded !== null && faded.opacityAtTop > 0.5 && faded.opacityAtEnd < 0.05,
        `top=${faded?.opacityAtTop} end=${faded?.opacityAtEnd} atEnd=${faded?.atEnd}`,
      );
      await shot('4b-long-entry-scrolled');
      await tap(8, 8);
      await sleep(400);
    } else {
      check('长词条可滚动（60vh 生效）', false, '样张里找不到 incitative');
      check('可滚时渐隐可见、滚到底后淡出', false, '同上');
    }

    // ── 【7】释义排版：重新长按 prospect ──
    console.log('\n【7】释义排版');
    const rePlaced = await placeWordAt('prospect', 0.5);
    if (rePlaced === null) throw new Error('找不到 prospect');
    await longPress(rePlaced.x, rePlaced.y);
    const typo = await measure();
    if (typo.panel === null) throw new Error('第二次长按没弹出');
    const posTexts = typo.translation.posTags.map((t) => t.text.trim());
    check(
      '词性渲染为标签（n. / vt. / vi.）',
      posTexts.length > 0 && posTexts.some((t) => /^[a-z]+\.$/i.test(t)),
      posTexts.join(',') || `lines=${typo.translation.lines.join(' / ')}`,
    );
    check(
      '释义使用中文标点（，/；）',
      typo.translation.lines.some((l) => /[，；]/.test(l)) && !typo.translation.lines.some((l) => /[一-龥], [一-龥]/.test(l)),
      typo.translation.lines.join(' / '),
    );
    check(
      '音标转标准 IPA（ˈ 而不是 ASCII 撇号）',
      typeof typo.phonetic === 'string' && typo.phonetic.includes('ˈ') && !typo.phonetic.includes("'"),
      String(typo.phonetic),
    );
    check('音标里不残留 ECDICT 非标准字符（ә → ə）', !String(typo.phonetic ?? '').includes('ә'), String(typo.phonetic));
    await shot('3-typography');

    // 词形行：persisted → persist（lemma 索引有这条）
    await tap(8, 8);
    await sleep(400);
    const lemmaPlaced = await placeWordAt('persisted', 0.5);
    if (lemmaPlaced === null) throw new Error('找不到 persisted');
    await longPress(lemmaPlaced.x, lemmaPlaced.y);
    const lemmaView = await measure();
    check(
      '变形词显示词形/原形行',
      typeof lemmaView.lemma === 'string' && lemmaView.lemma.includes('persist'),
      String(lemmaView.lemma ?? 'null'),
    );
    await tap(8, 8);
    await sleep(400);

    // ── 【8】手势 + 动效 ──
    console.log('\n【8】手势与动效');
    const dragPlaced = await placeWordAt('prospect', 0.5);
    await longPress(dragPlaced.x, dragPlaced.y);
    const motionView = await measure();
    if (motionView.panel === null) throw new Error('第三次长按没弹出');
    const panelAnims = motionView.panelAnimations;
    const kf = panelAnims.flatMap((a) => a.keyframes);
    check(
      '弹出动画使用 transform + opacity',
      kf.length > 0 && kf.some((k) => (k.transform ?? '').length > 0) && kf.some((k) => (k.opacity ?? '').length > 0),
      JSON.stringify(panelAnims.map((a) => a.name)),
    );
    if (MOTION === 'off') {
      check('动效关：动画时长归零', panelAnims.every((a) => a.duration <= 1), JSON.stringify(panelAnims.map((a) => a.duration)));
    }

    const handleCenter = motionView.handle === null ? null : { x: motionView.handle.cx, y: motionView.handle.cy };
    let midTransform = null;
    if (handleCenter !== null) {
      midTransform = await dragDown(handleCenter, 160);
      await shot('4-drag-half');
      await slideUp(handleCenter.x, handleCenter.y + 160);
      await sleep(450);
    }
    const afterHandleDrag = await measure();
    check(
      '把手下拉跟手（拖动中 translateY > 0）',
      midTransform !== null && midTransform.ty > 8,
      midTransform === null ? 'no reading' : `translateY=${midTransform.ty.toFixed(1)}px (${midTransform.raw})`,
    );
    check('把手下拉过半后松手关闭', afterHandleDrag.panel === null, afterHandleDrag.panel === null ? 'closed' : 'still open');

    // 标题行下拉关闭
    const headPlaced = await placeWordAt('prospect', 0.5);
    await longPress(headPlaced.x, headPlaced.y);
    const headView = await measure();
    if (headView.panel === null) throw new Error('第四次长按没弹出');
    const headCenter = headView.head === null ? null : { x: headView.head.cx, y: headView.head.cy };
    if (headCenter !== null) {
      await dragDown(headCenter, 180);
      await slideUp(headCenter.x, headCenter.y + 180);
      await sleep(450);
    }
    const afterHeadDrag = await measure();
    check('标题行下拉也能关闭', afterHeadDrag.panel === null, afterHeadDrag.panel === null ? 'closed' : 'still open');

    // 关闭态截图（最终）
    await shot('5-closed-final');
  } finally {
    server.close();
    chrome.kill();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${'─'.repeat(56)}`);
  console.log(`${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length > 0) {
    console.log('未通过：');
    for (const f of failed) console.log(`  ✗ ${f.name}`);
    process.exitCode = 1;
  }
  console.log(`截图：docs/screenshots/lookup-sheet/${OUT}/`);
}

await main();
