#!/usr/bin/env node
/**
 * 阶段 C 验收 —— 真实 Chrome（CDP）逐主题截图 + 断言。
 *
 * 流程（每步都是真实浏览器链路，不 mock）：
 *   干净起点（清 localStorage / 删 IndexedDB）→ 空书架截图
 *   → 注入设置（玻璃材质 + 衬线 + 视觉档位）+ 写入 6 篇夹具
 *   → 对 warm-night / warm-paper 两个主题依次：
 *       书架 → 书架列表（看菜单是否实现）→ 打开文档滚 600px 截全页
 *       → 排版面板 → 搜索 tab → 统计 tab → 设置页
 *
 * 断言模型（关键）：
 *   · 元素存在时：断言失败 → 计入失败，脚本 exit 1。
 *   · 元素还不存在（Lead 正在并行落地 C1–C6）：只记 `⚠ 尚未实现: xxx`，不抛异常。
 *     等 C 阶段全部落地后重跑，警告数必须为 0。
 *
 * 截图写到 docs/screenshots/C/。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { serveStatic } from './serve.mjs';
import { FIXTURE_DOCS } from './fixtures/docs.mjs';
import { seedDocs } from './seed-c.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const BUILD_DIR = join(ROOT, 'www');
const SHOTS = join(ROOT, 'docs', 'screenshots', 'C');
const CDP_PORT = 9335;
/** 小米 14 Pro 逻辑尺寸 + DPR 2 + 触摸模拟。 */
const VIEWPORT = { width: 393, height: 873, deviceScaleFactor: 2, mobile: true };

const THEMES = ['warm-night', 'warm-paper'];
const SETTINGS_KEY = 'mdlego:settings';

/** 注入的完整设置信封（schemaVersion 2，与 web/src/data/settings-store.ts 对齐）。 */
const SETTINGS = {
  accent: 'theme',
  material: 'glass',
  glassLevel: 2,
  motion: 'full',
  materialHinted: true,
  typeScale: 3,
  lineScale: 3,
  paraScale: 2,
  fontFamily: 'serif',
  focusMode: false,
  lookupEnabled: true,
};

/** Chrome 可执行文件候选（与 shot-kit 一致，路径统一用正斜杠）。 */
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe` : null,
];

// ─────────────────────────────────────────────
// 极简 CDP 客户端（Node 原生 WebSocket，零依赖）
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// 断言与警告统计
// ─────────────────────────────────────────────

const stats = { pass: 0, fail: 0, warn: 0 };
const failures = [];
const warnings = [];
const warnedKeys = new Set();

function pass(name, detail = '') {
  stats.pass += 1;
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail = '') {
  stats.fail += 1;
  failures.push(`${name}${detail ? `：${detail}` : ''}`);
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 记录一个「还没实现」的能力；同名只提示一次，避免两个主题刷屏。 */
function missing(label) {
  if (warnedKeys.has(label)) return;
  warnedKeys.add(label);
  stats.warn += 1;
  warnings.push(label);
  console.log(`  ⚠ 尚未实现: ${label}`);
}

function info(message) {
  console.log(`  ℹ ${message}`);
}

// ─────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────

async function main() {
  const chrome = CHROME_CANDIDATES.find((p) => p !== null && existsSync(p));
  if (chrome === undefined) {
    console.error('✗ 未找到 Chrome');
    process.exit(1);
  }

  console.log('构建阶段 C 验收产物（vite build → www）…');
  execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'ignore', shell: true });
  mkdirSync(SHOTS, { recursive: true });

  const server = await serveStatic(BUILD_DIR);
  const proc = spawn(
    chrome,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--user-data-dir=' + join(ROOT, 'artifacts', '.chrome-c'),
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    // ── 连接 Chrome ──
    let wsUrl = null;
    for (let i = 0; i < 60 && wsUrl === null; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
        if (res.ok) wsUrl = (await res.json()).webSocketDebuggerUrl;
      } catch {
        /* 端口还没起来 */
      }
      if (wsUrl === null) await sleep(250);
    }
    if (wsUrl === null) throw new Error('Chrome 调试端口未就绪');

    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });
    const cdp = new Cdp(ws);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: sid } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sid);
    await cdp.send('Runtime.enable', {}, sid);
    await cdp.send('DOM.enable', {}, sid);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { ...VIEWPORT, screenWidth: VIEWPORT.width, screenHeight: VIEWPORT.height },
      sid,
    );
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sid);

    // ── 未捕获页面错误：整个会话累计，逐个页面检查增量 ──
    const pageErrors = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        const details = msg.params.exceptionDetails;
        const text = details.exception?.description ?? details.text ?? '(未知错误)';
        pageErrors.push(String(text).split('\n')[0].slice(0, 200));
      }
    });
    let errorCursor = 0;

    // ── 页面操作原语 ──
    const ev = async (expression) => {
      const r = await cdp.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        sid,
      );
      if (r.exceptionDetails) {
        const detail = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
        throw new Error(`页面脚本出错：${detail}`);
      }
      return r.result.value;
    };

    const exists = (testId) => ev(`!!document.querySelector('[data-testid="${testId}"]')`);

    const clickId = async (testId, waitMs = 350) => {
      const ok = await ev(
        `(() => { const e = document.querySelector('[data-testid="${testId}"]'); if (!e) return false; e.click(); return true; })()`,
      );
      if (ok === true) await sleep(waitMs);
      return ok === true;
    };

    const themeAttr = () => ev(`document.documentElement.getAttribute('data-theme')`);

    /**
     * 菜单项 testid：DECISION 文档写的是 shelf-view-list，
     * 但当前菜单层统一渲染成 menu-<id>（menu-shelf-view-list，Lead 的冒烟脚本也用它）。
     * 两种都认，谁先出现用谁，并把实际名字记进日志，避免两种命名悄悄分叉。
     */
    const waitForMenuTestId = async (testId, timeoutMs = 1500) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await exists(testId)) return testId;
        if (await exists(`menu-${testId}`)) return `menu-${testId}`;
        await sleep(120);
      }
      return null;
    };

    const glassCount = () =>
      ev(
        `(() => { let n = 0; for (const e of document.querySelectorAll('*')) { const v = getComputedStyle(e).backdropFilter; if (v && v !== 'none') n++; } return n; })()`,
      );

    const tabbarRect = () =>
      ev(
        `(() => { const t = document.querySelector('[data-testid="tabbar"]'); if (!t) return null; const r = t.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, innerHeight: window.innerHeight }; })()`,
      );

    const shot = async (name, full = false) => {
      const params = { format: 'png', captureBeyondViewport: full };
      if (full) {
        const metrics = await cdp.send('Page.getLayoutMetrics', {}, sid);
        const contentHeight = Math.ceil(
          metrics.cssContentSize?.height ?? metrics.contentSize.height,
        );
        params.clip = { x: 0, y: 0, width: VIEWPORT.width, height: contentHeight, scale: 1 };
      }
      const r = await cdp.send('Page.captureScreenshot', params, sid);
      writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
      console.log(`  📸 ${name}.png`);
    };

    // ── 断言原语 ──

    /** 每页通用断言：无横向溢出 + 玻璃层 ≤ 3。 */
    async function assertPageInvariants(label) {
      const m = await ev(
        `(() => { const de = document.documentElement; let glass = 0; for (const e of document.querySelectorAll('*')) { const v = getComputedStyle(e).backdropFilter; if (v && v !== 'none') glass++; } return { scrollWidth: de.scrollWidth, innerWidth: window.innerWidth, glass }; })()`,
      );
      if (m.scrollWidth <= m.innerWidth + 1) {
        pass(`${label}：无横向溢出`, `scrollWidth=${m.scrollWidth} ≤ ${m.innerWidth}+1`);
      } else {
        fail(`${label}：横向溢出`, `scrollWidth=${m.scrollWidth} > ${m.innerWidth}+1`);
      }
      if (m.glass <= 3) {
        pass(`${label}：玻璃层数 ≤ 3`, `${m.glass} 层`);
      } else {
        fail(`${label}：玻璃层数超过 3`, `${m.glass} 层`);
      }
    }

    /** 检查自上次游标以来有没有新的未捕获错误；把游标推到最新。 */
    function assertNoNewErrors(label) {
      const fresh = pageErrors.slice(errorCursor);
      errorCursor = pageErrors.length;
      if (fresh.length === 0) {
        pass(`${label}：无未捕获页面错误`);
      } else {
        fail(`${label}：有未捕获页面错误`, `${fresh.length} 条 · ${fresh[0]}`);
      }
    }

    /** tabbar 在书架 / 搜索 / 统计页必须存在且底边在视口内。 */
    let tabbarImplemented = false;
    async function assertTabbarOnTabPage(label) {
      const rect = await tabbarRect();
      if (rect === null) {
        missing('tabbar');
        return;
      }
      tabbarImplemented = true;
      const inViewport = rect.bottom <= rect.innerHeight + 2 && rect.bottom > 0 && rect.height > 0;
      const detail = `bottom=${rect.bottom.toFixed(1)} innerHeight=${rect.innerHeight} height=${rect.height.toFixed(1)}`;
      if (inViewport) pass(`${label}：tabbar 底边在视口内`, detail);
      else fail(`${label}：tabbar 底边超出视口`, detail);
    }

    /** 阅读页：必须有 reader-bar / reader-progress，且不能出现 tabbar。 */
    async function assertReaderChrome(label) {
      if (await exists('reader-bar')) pass(`${label}：有 reader-bar`);
      else missing('reader-bar');

      if (await exists('reader-progress')) pass(`${label}：有 reader-progress`);
      else missing('reader-progress');

      if (!tabbarImplemented) return; // C1 整体还没实现时，已在书架页统一提示过
      if ((await tabbarRect()) === null) pass(`${label}：阅读页没有 tabbar`);
      else fail(`${label}：阅读页不应出现 tabbar`);
    }

    /** 回到书架：优先点返回，实在不行整页导航（hash 只有 #/ 一种形状）。 */
    const onShelf = async () =>
      (await exists('shelf')) || (await exists('doc-item')) || (await exists('shelf-empty'));

    async function gotoShelf() {
      for (const testId of ['back-to-shelf', 'reader-back', 'nav-back']) {
        if (await exists(testId)) {
          await clickId(testId, 700);
          break;
        }
      }
      if (!(await onShelf())) {
        await cdp.send('Page.navigate', { url: server.url }, sid);
        await sleep(1400);
      }
    }

    /** 写入设置 + 整页导航，保证每轮主题都从书架页开始。 */
    async function setTheme(theme) {
      const envelope = { schemaVersion: 2, settings: { ...SETTINGS, theme } };
      // 清掉设置以外的 localStorage（列表视图偏好、浮层开关等），
      // 让两个主题从完全相同的初始状态开始，截图才能互相对比。
      await ev(
        `(() => {
          for (const key of Object.keys(localStorage)) {
            if (key !== ${JSON.stringify(SETTINGS_KEY)}) localStorage.removeItem(key);
          }
          localStorage.setItem(${JSON.stringify(SETTINGS_KEY)}, ${JSON.stringify(JSON.stringify(envelope))});
          return true;
        })()`,
      );
      await cdp.send('Page.navigate', { url: server.url }, sid);
      await sleep(1300);
      // 上一轮打开文档会把 lastReadAt / progress 写成真实值；重写一次夹具，
      // 让两个主题的书架元信息（几天前、继续阅读）保持一致，截图才可横向对比。
      await seedDocs(cdp, sid, FIXTURE_DOCS);
      await cdp.send('Page.reload', {}, sid);
      await sleep(1600);
    }

    /** 打开第一篇文档并滚动 600px（返回实际滚动方式，供日志用）。 */
    async function openFirstDocAndScroll() {
      if (!(await exists('doc-item'))) return null;
      if (!(await clickId('doc-item', 900))) return { mode: 'click-failed', y: 0 };
      const mode = await ev(
        `(() => {
          window.scrollTo(0, 600);
          if (window.scrollY > 0) return { mode: 'window', y: window.scrollY };
          const candidates = [...document.querySelectorAll('*')];
          const scrollable = candidates.find((e) => {
            const s = getComputedStyle(e);
            return /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 100;
          });
          if (scrollable) { scrollable.scrollTop = 600; return { mode: 'inner', y: scrollable.scrollTop }; }
          return { mode: 'none', y: 0 };
        })()`,
      );
      await sleep(450);
      return mode;
    }

    // ── 1. 干净起点：空书架 ──
    console.log('\n【空书架】');
    await cdp.send('Page.navigate', { url: server.url }, sid);
    await sleep(1000);
    await ev(
      `(() => {
        localStorage.clear();
        return new Promise((res) => {
          const req = indexedDB.deleteDatabase('mdlego');
          req.onsuccess = req.onerror = req.onblocked = () => res(true);
        });
      })()`,
    );
    await cdp.send('Page.reload', {}, sid);
    await sleep(1600);

    const appMounted = await ev(`document.querySelector('[data-testid="app-root"]')?.childElementCount > 0`);
    if (appMounted === true) pass('应用挂载');
    else fail('应用挂载', 'app-root 为空');
    if (await exists('shelf-empty')) pass('空书架显示 shelf-empty');
    else missing('shelf-empty');

    await shot('c-shelf-empty');
    await assertPageInvariants('空书架');
    assertNoNewErrors('空书架');

    // ── 2. 注入设置 + 夹具 ──
    console.log('\n【注入设置与夹具】');
    const initialEnvelope = { schemaVersion: 2, settings: { ...SETTINGS, theme: 'warm-night' } };
    await ev(
      `localStorage.setItem(${JSON.stringify(SETTINGS_KEY)}, ${JSON.stringify(JSON.stringify(initialEnvelope))}); true`,
    );
    const storedRaw = await ev(`localStorage.getItem(${JSON.stringify(SETTINGS_KEY)})`);
    if (typeof storedRaw === 'string' && storedRaw.includes('schemaVersion')) {
      pass('设置信封已写入 localStorage', SETTINGS_KEY);
    } else {
      fail('设置信封已写入 localStorage', '读回为空');
    }

    const seed = await seedDocs(cdp, sid, FIXTURE_DOCS);
    if (seed.docs === FIXTURE_DOCS.length) {
      pass('夹具文档写入 IndexedDB', `${seed.docs} 篇`);
    } else {
      fail('夹具文档写入 IndexedDB', `期望 ${FIXTURE_DOCS.length} 篇，实际 ${seed.docs} 篇`);
    }
    if (seed.hadSessionsStore) {
      info(`sessions 表存在，写入 ${seed.sessions} 条 7 天阅读会话`);
    } else {
      info('sessions 表不存在（C6 尚未建表），跳过 7 天阅读会话');
    }
    if (seed.sessionsError !== null) {
      info(`sessions 写入失败（不影响 C1–C5 截图）：${seed.sessionsError}`);
    }

    await cdp.send('Page.reload', {}, sid);
    await sleep(1800);
    const docCount = await ev(`document.querySelectorAll('[data-testid="doc-item"]').length`);
    if (docCount >= FIXTURE_DOCS.length) {
      pass('书架载入全部夹具', `${docCount} 篇`);
    } else {
      fail('书架载入全部夹具', `期望 ≥ ${FIXTURE_DOCS.length}，实际 ${docCount}`);
    }

    // ── 3. 逐主题截图与断言 ──
    for (const theme of THEMES) {
      console.log(`\n【主题 ${theme}】`);
      await setTheme(theme);

      const appliedTheme = await themeAttr();
      if (appliedTheme === theme) pass(`${theme}：data-theme 生效`);
      else fail(`${theme}：data-theme 未生效`, `实际 ${String(appliedTheme)}`);

      // ── 书架 ──
      console.log('  · 书架');
      await shot(`c-shelf-${theme}`);
      await assertPageInvariants(`书架(${theme})`);
      await assertTabbarOnTabPage(`书架(${theme})`);
      assertNoNewErrors(`书架(${theme})`);

      // ── 书架列表视图（C2 的「更多」菜单）──
      console.log('  · 书架列表');
      if (await exists('shelf-more')) {
        await clickId('shelf-more', 250);
        const viewListId = await waitForMenuTestId('shelf-view-list', 1500);
        if (viewListId !== null) {
          if (viewListId !== 'shelf-view-list') {
            info(`菜单项实际 testid 为 ${viewListId}（DECISION 文档写的是 shelf-view-list，工具两者都兼容）`);
          }
          if (await clickId(viewListId, 700)) {
            await shot(`c-shelf-list-${theme}`);
            await assertPageInvariants(`书架列表(${theme})`);
            await assertTabbarOnTabPage(`书架列表(${theme})`);
            assertNoNewErrors(`书架列表(${theme})`);
          } else {
            missing('shelf-view-list 无法点击');
          }
        } else {
          missing('shelf-view-list');
        }
        // 菜单可能还开着：整页导航回书架，保证后面的点击不被浮层挡住
        await cdp.send('Page.navigate', { url: server.url }, sid);
        await sleep(1300);
      } else {
        missing('shelf-more');
      }

      // ── 阅读页（全页截图）──
      console.log('  · 阅读页');
      const scroll = await openFirstDocAndScroll();
      if (scroll === null) {
        missing('doc-item');
      } else if (scroll.mode === 'click-failed') {
        missing('doc-item 无法点击');
      } else {
        if (scroll.mode === 'window') info(`阅读页滚动：window.scrollTo(0, ${scroll.y})`);
        else if (scroll.mode === 'inner') info(`阅读页滚动：内部滚动容器 scrollTop=${scroll.y}`);
        else info('阅读页滚动 600px 未生效（可能改成了外壳固定高度 + 内部滚动，稍后改造时再处理）');

        // 滚动 600px 用来验证「顶栏随滚动收放」真的触发过；截设计图时回到页首，
        // 否则全页截图会把 sticky 顶栏/固定底栏画在滚动偏移处（看起来像错位）。
        await ev(`window.scrollTo(0, 0); true`);
        await sleep(320);
        await shot(`c-reader-${theme}`, false);
        await assertPageInvariants(`阅读页(${theme})`);
        await assertReaderChrome(`阅读页(${theme})`);
        assertNoNewErrors(`阅读页(${theme})`);

        // ── 排版面板 ──
        console.log('  · 排版面板');
        if (await exists('open-typeset')) {
          if (await clickId('open-typeset', 700)) {
            await shot(`c-reader-typeset-${theme}`);
            await assertPageInvariants(`排版面板(${theme})`);
            assertNoNewErrors(`排版面板(${theme})`);
          } else {
            missing('open-typeset 无法点击');
          }
        } else {
          missing('open-typeset');
        }

        // 阅读页没有 tabbar，回书架再进搜索 / 统计
        await gotoShelf();
      }

      // ── 搜索 tab ──
      console.log('  · 搜索页');
      if (await exists('tab-search')) {
        if (await clickId('tab-search', 700)) {
          await shot(`c-search-${theme}`);
          await assertPageInvariants(`搜索页(${theme})`);
          await assertTabbarOnTabPage(`搜索页(${theme})`);
          assertNoNewErrors(`搜索页(${theme})`);
        } else {
          missing('tab-search 无法点击');
        }
      } else {
        missing('tab-search');
      }

      // ── 统计 tab ──
      console.log('  · 统计页');
      if (await exists('tab-stats')) {
        if (await clickId('tab-stats', 700)) {
          await shot(`c-stats-${theme}`);
          await assertPageInvariants(`统计页(${theme})`);
          await assertTabbarOnTabPage(`统计页(${theme})`);
          assertNoNewErrors(`统计页(${theme})`);
        } else {
          missing('tab-stats 无法点击');
        }
      } else {
        missing('tab-stats');
      }

      // ── 设置页（深链）──
      console.log('  · 设置页');
      await ev(`location.hash = '#/settings'; true`);
      await sleep(900);
      await shot(`c-settings-${theme}`);
      await assertPageInvariants(`设置页(${theme})`);
      assertNoNewErrors(`设置页(${theme})`);
    }

    // ── 4. 收尾：整场错误基线 ──
    console.log('\n【收尾】');
    if (pageErrors.length === 0) {
      pass('整场无未捕获页面错误');
    } else {
      fail('整场无未捕获页面错误', `${pageErrors.length} 条 · ${pageErrors[0]}`);
    }
    errorCursor = pageErrors.length;
  } finally {
    try {
      proc.kill();
    } catch {
      /* 忽略清理失败 */
    }
    await server.close();
  }

  // ── 汇总 ──
  console.log('\n────────────────────────────');
  console.log(`断言：通过 ${stats.pass} 项 · 失败 ${stats.fail} 项 · 警告 ${stats.warn} 项`);
  console.log(`截图目录：${SHOTS}`);
  if (warnings.length > 0) {
    console.log(`\n尚未实现（${warnings.length} 项，C1–C6 落地后应清零）：`);
    for (const w of warnings) console.log(`  ⚠ ${w}`);
  }
  if (failures.length > 0) {
    console.error('\n失败项：');
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error(`\n✗ 阶段 C 验收失败：${failures.length} 项断言未通过`);
    process.exit(1);
  }
  console.log('\n✓ 阶段 C 已实现部分的断言全部通过');
}

main().catch((error) => {
  console.error('✗ 脚本异常：', error);
  process.exit(1);
});
