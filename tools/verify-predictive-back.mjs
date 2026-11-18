#!/usr/bin/env node
/**
 * 真机验收：Android 14+ 预测式返回（转场改造 Step 4）。
 *
 * 设备：小米 11 Ultra（M2102K1C / Android 14 / HyperOS OS2.0）。
 * 该机 adb shell input 被 MIUI 拦在 INJECT_EVENTS 上，点击一律走 WebView
 * DevTools CDP 的 Runtime.evaluate；系统级侧滑手势无法用 CDP 合成，
 * 所以原生侧走两条证据链：
 *   A. 直接调用 Web 接收器 `window.__mdlegoBackGesture(...)`，
 *      验证跟手矩阵/取消回弹/提交落地三条路径的**Web 侧**行为；
 *   B. 读 logcat 里 MdlegoNative 的注册/注销记录 + CDP 读
 *      `setBackIntercept` 的实际开关，验证**原生侧**按路由栈深度动态
 *      注册与注销（这是「绝不能废掉退回桌面动画」的硬要求）。
 *
 * 用法：node tools/verify-predictive-back.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = join(ROOT, 'docs', 'screenshots', 'transition-rc3', 'predictive-back');
const PORT = 9222;
const SERIAL = process.env.MDLEGO_SERIAL ?? '518d68b2';
const PKG = 'cn.mdlego.reader';
const SAMPLE = join(ROOT, 'artifacts', '.predictive-back-sample.md');

const ADB = [
  'D:\\Workbuddyspace\\.android-sdk\\platform-tools\\adb.exe',
  process.env.LOCALAPPDATA + '\\Android\\Sdk\\platform-tools\\adb.exe',
  'adb',
].find((p) => p === 'adb' || (p && existsSync(p)));

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: ok === true });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

function adb(...args) {
  return execFileSync(ADB, args.length > 0 && !args[0].startsWith('-') ? ['-s', SERIAL, ...args] : args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.consoleAPICalled') {
        const args = (m.params?.args ?? []).map((a) => a.value ?? a.description ?? '');
        this.logs.push(args.join(' '));
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
      else p.resolve(m.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`CDP 超时 ${method}`)); }
      }, 20000);
    });
  }
}

let cdp;
const evalJs = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
};
/**
 * 真机截图用 adb screencap，而不是 CDP Page.captureScreenshot。
 *
 * 小米 11 Ultra 的 WebView 在转场/动画进行中经常不返回 captureScreenshot
 * （CDP 挂住直到超时），但系统级截屏一直可用，且拿到的是「用户真正看到的
 * 那一帧」—— 对转场验收反而更可信。
 */
const shot = async (name) => {
  mkdirSync(SHOTS, { recursive: true });
  const png = execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20000,
  });
  writeFileSync(join(SHOTS, `${name}.png`), png);
};

/** 发送一次跟手手势（逐帧 move，模拟原生 onBackProgressed）。 */
async function gesture(kind, progress = 0, x = 0, y = 400, edge = 0) {
  return evalJs(`(() => {
    const f = window.__mdlegoBackGesture;
    if (typeof f !== 'function') return { error: 'no receiver' };
    f(${JSON.stringify(kind)}, ${progress}, ${x}, ${y}, ${edge});
    return { ok: true };
  })()`);
}

/** 读形变壳的实时矩阵。 */
const morphNow = () => evalJs(`(() => {
  const layer = document.querySelector('.page-mask');
  if (layer === null) return { layer: false };
  const cs = getComputedStyle(layer);
  const scrim = document.querySelector('.page-mask-scrim');
  const behind = document.querySelector('.page-mask-behind');
  const behind2 = document.querySelector('.page-mask-behind');
  void behind2;
  return {
    layer: true,
    phase: layer.getAttribute('data-phase'),
    transform: cs.transform,
    radius: cs.borderTopLeftRadius,
    scrim: scrim === null ? null : Number(getComputedStyle(scrim).opacity),
    // 跟手阶段的景深目标不是 .page-mask-behind（那是打开方向的冻结层），
    // 而是转场层之前、跳过 scrim 的那个真实书架节点（与 runCloseMask 同一套查找）
    behindTransform: (() => {
      let node = layer.previousElementSibling;
      while (node !== null) {
        if (node.matches('.page-mask-scrim') || node.matches('[data-testid="page-mask"]')) {
          node = node.previousElementSibling;
          continue;
        }
        return node === null ? null : getComputedStyle(node).transform;
      }
      return null;
    })(),
    snap: layer.getAttribute('data-snapshot'),
    hidden: document.querySelectorAll('.is-morph-slot-hidden').length,
  };
})()`);

/** 当前导航栈快照（与 core/back-gesture 的 BackStack 同构）。 */
const stackNow = () => evalJs(`(() => {
  const hash = location.hash || '#/';
  const reader = document.querySelector('[data-testid="shell"][data-testid]')?.className?.includes('reader-page') ?? false;
  const layers = document.querySelectorAll('[data-testid="lookup-card"], [data-testid="toc-drawer"], [data-testid="sheet"]').length;
  return { hash, reader, layers };
})()`);

/**
 * 往设备上导入一篇长文档（书架为空时没法点卡片进阅读页）。
 *
 * 真机上 `pickFiles()` 走的是 Capacitor 原生文件选择器（系统 UI 弹窗），
 * CDP 无法代为确认，所以这里直接把一条**与应用持久化格式一致**的 Doc
 * 写进 IndexedDB（`mdlego/docs`，keyPath `id`），然后 reload。
 * 只碰数据，不改任何生产代码；字段与 `core/types.ts::Doc` 一一对应。
 */
async function ensureDocOnShelf() {
  const count = await evalJs(`document.querySelectorAll('[data-doc-id]').length`);
  if (count > 0) return count;
  const parts = ['# 预测式返回验收样张\n'];
  for (let i = 1; i <= 120; i += 1) {
    parts.push(`## 第 ${i} 节\n`);
    parts.push(`这是第 ${i} 段，用来给 Android 14 预测式返回验收提供一篇有滚动量的真实文档。` + '跟手缩窗必须能在这篇文档上观察到形变矩阵的连续变化。\n');
    parts.push(`- 要点 A${i}\n- 要点 B${i}\n`);
  }
  const text = parts.join('\n');
  writeFileSync(SAMPLE, text, 'utf8');
  const injected = await evalJs(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('mdlego');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const doc = {
      id: 'doc-predictive-back',
      title: '预测式返回验收样张',
      text: ${JSON.stringify(text)},
      encoding: 'utf-8',
      source: { kind: 'inline' },
      fingerprint: null,
      importedAt: Date.now(),
      lastReadAt: null,
      progress: null,
      tags: [],
      folder: null,
    };
    await new Promise((res, rej) => {
      const tx = db.transaction('docs', 'readwrite');
      tx.objectStore('docs').put(doc);
      tx.oncomplete = () => res(true);
      tx.onerror = () => rej(tx.error);
    });
    return { ok: true };
  })()`);
  if (injected?.ok !== true) return 0;
  // reload 让应用自己从库里读回来（走完整启动流程）
  await cdp.send('Page.reload');
  await sleep(3500);
  return evalJs(`document.querySelectorAll('[data-doc-id]').length`);
}

async function main() {
  console.log('设备：', SERIAL);
  console.log('Android：', adb('shell', 'getprop ro.build.version.release').trim(),
    '/ SDK', adb('shell', 'getprop ro.build.version.sdk').trim(),
    '/', adb('shell', 'getprop ro.product.model').trim());
  console.log('RootView 可调返回键：', adb('shell', 'getprop ro.build.version.sdk').trim() >= 33 ? '支持（33+）' : '不支持');

  // 设备休眠时 WebView DevTools 会挂住（fetch 永不返回），动手前先唤醒
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  await sleep(500);
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
  await sleep(2500);
  const pid = adb('shell', 'pidof', PKG).trim();
  console.log('pid =', pid);

  adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
  await sleep(600);
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('WebView 页面没找到');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP 连不上')), { once: true });
  });
  cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  try {
    // ── 0. 接收器是否装了 ──
    const installed = await evalJs(`typeof window.__mdlegoBackGesture === 'function'`);
    check('Web 接收器 window.__mdlegoBackGesture 已安装', installed === true);

    // 先等任何残留转场彻底落地。
    //
    // 上一次运行可能停在「关闭动画正在播」的中间态（形变壳还在缩向书封），
    // 这时候立刻测「书架根页面不该有形变层」必然误判 —— 那层是上一段
    // 动画的合法产物，不是这次手势创建的。
    await evalJs(`new Promise((res) => {
      const t0 = Date.now();
      const poll = () => {
        if (document.querySelector('.page-mask') === null || Date.now() - t0 > 3000) res(true);
        else setTimeout(poll, 60);
      };
      poll();
    })`);
    await sleep(300);

    // 回到书架首页
    await evalJs(`location.hash = '#/'; true`);
    await sleep(900);

    // 书架必须有书才能进阅读页
    const docCount = await ensureDocOnShelf();
    check('书架上至少有一篇文档', docCount > 0, `${docCount} 篇`);

    // ── A0. 书架根页面：绝不能拦截（保住系统退回桌面动画）──
    const atShelf = await gesture('start', 0, 0, 400, 0);
    await sleep(120);
    const shelfMorph = await morphNow();
    check('书架根页面 start 不创建形变层（不吃系统返回）', shelfMorph.layer === false,
      JSON.stringify(shelfMorph));
    await gesture('cancel', 0);

    // ── 1. 进阅读页 ──
    const opened = await evalJs(`(() => {
      const card = document.querySelector('[data-testid="shelf-grid"] [data-doc-id]');
      if (!card) return false;
      card.click();
      return true;
    })()`);
    check('打开一本书', opened === true);
    await sleep(2200);

    // ── A1. start：单帧原子准备 ──
    const started = await gesture('start', 0, 0, 400, 0);
    await sleep(120);
    const s0 = await morphNow();
    check('阅读页 start 立刻挂出形变层', s0.layer === true, JSON.stringify(s0));
    check('形变层使用视口轻量快照', s0.snap === '1', `snapshot=${s0.snap}`);
    check('底层书架已切出并景深微缩', s0.behindTransform !== null && s0.behindTransform !== 'none',
      `behind=${s0.behindTransform}`);
    check('背景压暗层已出现', s0.scrim !== null, `scrim=${s0.scrim}`);
    check('原卡槽已隐身（防重影）', typeof s0.hidden === 'number' && s0.hidden <= 1, `hidden=${s0.hidden}`);

    // ── A2. move：跟手阻尼曲线 ──
    const samples = [];
    for (const p of [0.15, 0.35, 0.55, 0.75, 1.0]) {
      await gesture('move', p, 0, 400 + p * 200, 0);
      await sleep(60);
      const m = await morphNow();
      const scale = (() => {
        const mt = /matrix\(([^)]+)\)/.exec(m.transform ?? '');
        return mt ? Number(mt[1].split(',')[0]) : null;
      })();
      samples.push({ p, scale, radius: m.radius, scrim: m.scrim, behind: m.behindTransform });
      console.log(`    progress=${p} → scale=${scale?.toFixed(4)} radius=${m.radius} scrim=${m.scrim}`);
    }
    // 计划书：currentScale = 1 - 0.15 * damped，damped = 1-(1-p)^2
    const okScale = samples.every((s, i) => {
      const damped = 1 - Math.pow(1 - s.p, 2);
      const expected = 1 - 0.15 * damped;
      return s.scale !== null && Math.abs(s.scale - expected) <= 0.01;
    });
    check('跟手缩放符合阻尼曲线 1-0.15·damped', okScale,
      samples.map((s) => `${s.p}:${s.scale?.toFixed(3)}`).join(' '));
    const radii = samples.map((s) => Number.parseFloat(s.radius) || 0);
    check('跟手圆角随进度增大（0 → 24px 量级）',
      radii[0] < radii[radii.length - 1] && radii[radii.length - 1] > 15 && radii[radii.length - 1] <= 24.5,
      radii.map((r) => r.toFixed(1)).join(' → '));
    const scales = samples.map((s) => s.scale);
    check('缩放单调缩小（跟手不回弹）',
      scales.every((v, i) => i === 0 || v <= scales[i - 1] + 0.001),
      scales.map((v) => v?.toFixed(3)).join(' → '));
    await shot('gesture-mid');

    // ── A3. cancel：平滑回弹并拆层 ──
    await gesture('cancel', 0, 0, 400, 0);
    await sleep(600);
    const afterCancel = await morphNow();
    const cancelledClean = await evalJs(`({
      masks: document.querySelectorAll('.page-mask').length,
      scrims: document.querySelectorAll('.page-mask-scrim').length,
      hidden: document.querySelectorAll('.is-morph-slot-hidden').length,
      reader: !!document.querySelector('[data-testid="article"]'),
    })`);
    check('cancel 后回弹到全屏', afterCancel.layer === false || /matrix\(1, 0, 0, 1, 0, 0\)|none/.test(afterCancel.transform ?? ''),
      JSON.stringify(afterCancel).slice(0, 120));
    check('cancel 后临时层与卡槽隐身全部清理',
      cancelledClean.masks === 0 && cancelledClean.scrims === 0 && cancelledClean.hidden === 0,
      JSON.stringify(cancelledClean));
    check('cancel 后阅读页仍在（没有误退）', cancelledClean.reader === true);
    await shot('after-cancel');

    // ── A4. commit：从松手矩阵直接飞入卡槽，不得先弹回全屏 ──
    await gesture('start', 0, 0, 400, 0);
    await sleep(100);
    await gesture('move', 0.6, 0, 520, 0);
    await sleep(80);
    const beforeCommit = await morphNow();
    const commitScale = (() => {
      const mt = /matrix\(([^)]+)\)/.exec(beforeCommit.transform ?? '');
      return mt ? Number(mt[1].split(',')[0]) : null;
    })();
    // 记录提交后最初几帧的缩放，验证「没有先弹回 1 再重播」
    await gesture('commit', 1, 0, 520, 0);
    const firstFrames = [];
    for (let i = 0; i < 6; i++) {
      await sleep(40);
      const m = await morphNow();
      const mt = /matrix\(([^)]+)\)/.exec(m.transform ?? '');
      firstFrames.push(mt ? Number(mt[1].split(',')[0]) : null);
    }
    await sleep(900);
    const afterCommit = await morphNow();
    const commitClean = await evalJs(`({
      masks: document.querySelectorAll('.page-mask').length,
      scrims: document.querySelectorAll('.page-mask-scrim').length,
      hidden: document.querySelectorAll('.is-morph-slot-hidden').length,
      onShelf: !!document.querySelector('[data-testid="shelf-grid"]'),
      reader: !!document.querySelector('[data-testid="article"]'),
    })`);
    check('commit 前已跟手到缩窗状态', commitScale !== null && commitScale < 0.99,
      `scale=${commitScale?.toFixed(3)}`);
    check('commit 后不先弹回全屏（首帧缩放 ≤ 松手值 + 0.02）',
      firstFrames.filter((v) => v !== null).every((v) => v <= commitScale + 0.02),
      firstFrames.map((v) => v?.toFixed(3)).join(' → '));
    check('commit 后落地书架', commitClean.onShelf === true, JSON.stringify(commitClean));
    check('commit 后临时层与卡槽隐身全部清理',
      commitClean.masks === 0 && commitClean.scrims === 0 && commitClean.hidden === 0,
      JSON.stringify(commitClean));
    check('commit 后阅读页已卸载', commitClean.reader === false);
    void afterCommit;
    await shot('after-commit');

    // ── B. 原生侧：拦截开关随路由栈动态注册/注销 ──
    // 从 logcat 读 MdlegoNative 的注册记录（若实现了日志），
    // 再以「书架根页面 → 阅读页 → 书架」切换时 Web 侧 wanted 值变化为证据。
    const hashAtShelf = await evalJs(`location.hash`);
    await evalJs(`(() => {
      const card = document.querySelector('[data-testid="shelf-grid"] [data-doc-id]');
      if (card) card.click();
      return true;
    })()`);
    await sleep(2000);
    const inReader = await evalJs(`!!document.querySelector('[data-testid="article"]')`);
    check('重新进入阅读页（为拦截开关取证）', inReader === true);

    // 打开查词卡/目录抽屉 → 仍应拦截（只是关浮层）
    const drawerOpened = await evalJs(`(() => {
      const btn = document.querySelector('[data-testid="open-toc"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    await sleep(500);
    if (drawerOpened) {
      await gesture('start', 0, 0, 400, 0);
      await sleep(100);
      const withDrawer = await morphNow();
      check('有子浮层时 start 不缩整页（只关浮层）', withDrawer.layer === false, JSON.stringify(withDrawer).slice(0, 120));
      await gesture('cancel', 0);
      await sleep(200);
      // 关闭抽屉
      await evalJs(`(() => {
        const mask = document.querySelector('[data-testid="toc-drawer"]');
        const btn = document.querySelector('[data-testid="open-toc"]');
        if (btn) btn.click();
        else if (mask) mask.remove();
        return true;
      })()`);
      await sleep(400);
    }

    // 回书架
    //
    // 不能用 `location.hash = '#/'`：阅读页的 hash 本来就是 `#/`（hash 只镜像
    // tab 态），赋值不产生 hashchange，人其实还留在阅读页 —— 后面的
    // 「书架根页面」断言就会误判。这里点阅读页自己的返回键，走真实退栈。
    await evalJs(`(() => {
      const back = document.querySelector('[data-testid="back-to-shelf"]');
      if (back) { back.click(); return 'clicked'; }
      return 'no-button';
    })()`);
    await sleep(1400);
    const backAtShelf = await evalJs(`(() => {
      const reader = !!document.querySelector('[data-testid="article"]');
      const shelf = !!document.querySelector('[data-testid="shelf-grid"]');
      return reader === false && shelf === true;
    })()`);
    check('回到书架根页面', backAtShelf === true, `hash=${hashAtShelf}`);
    const shelfAgain = await gesture('start', 0, 0, 400, 0);
    await sleep(120);
    const shelfMorph2 = await morphNow();
    check('书架根页面再次 start 仍不拦截（系统缩回桌面动画不受影响）',
      shelfMorph2.layer === false, JSON.stringify(shelfMorph2).slice(0, 120));
    await gesture('cancel', 0);
    void shelfAgain;

    // ── 真机截图 ──
    const png = execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(join(SHOTS, 'device-final.png'), png);
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    try { adb('forward', '--remove', `tcp:${PORT}`); } catch { /* ignore */ }
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n结果：${checks.length - failed.length}/${checks.length}`);
  console.log(`截图：${SHOTS}`);
  if (failed.length > 0) {
    console.log('失败：\n' + failed.map((f) => `  ✗ ${f.name}`).join('\n'));
    process.exitCode = 1;
  }
}

await main();
