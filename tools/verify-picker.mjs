#!/usr/bin/env node
/**
 * 真机/模拟器验证：App 内「导入文档」（SAF 文件选择器）+ 状态栏安全区。
 *
 * 用户反馈的两件事，一条条证：
 *   1. 点屏幕中间「导入文档」→ 选 70 多 KB 的 MD → 卡死无反应
 *      本工具真的用 adb 点 +，真的在 DocumentsUI 里选文件，
 *      然后读 WebView 真实 DOM 断言书架出现，而不是看调试变量。
 *   2. 顶栏 / 搜索框顶到状态栏
 *      读原生注入的 --android-safe-top，再用 getBoundingClientRect()
 *      断言 appbar 与搜索输入框的 top  >= 状态栏高度。
 *
 * 用法：node tools/verify-picker.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const ARTIFACTS = join(ROOT, 'artifacts', 'screenshots');
const PKG = 'cn.mdlego.reader';
const PORT = 9342;
const BIG_NAME = 'mdlego-picker-70k.md';
const DEVICE_FILE = `/sdcard/Download/${BIG_NAME}`;
const EXPECTED_TITLE = 'App 内导入大文件验证';

function findAdb() {
  const c = process.env.LOCALAPPDATA + '\\Android\\Sdk\\platform-tools\\adb.exe';
  return existsSync(c) ? c : 'adb';
}
const ADB = findAdb();
const adb = (...args) => execFileSync(ADB, args, {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});
const adbBuf = (...args) => execFileSync(ADB, args, {
  encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
});

function assert(condition, message) {
  if (!condition) throw new Error(`✗ ${message}`);
  console.log(`  ✓ ${message}`);
}
function screenshot(name) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const file = join(ARTIFACTS, `m2-picker-${name}.png`);
  const png = adbBuf('exec-out', 'screencap', '-p');
  writeFileSync(file, png);
  console.log(`    截图 ${file} (${(png.length / 1024).toFixed(0)} KB)`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== undefined && this.pending.has(m.id)) {
        this.pending.get(m.id)(m); this.pending.delete(m.id);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res) => this.pending.set(id, res));
  }
  async eval(expression) {
    const m = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (m.result?.exceptionDetails) {
      throw new Error(`页面脚本异常：${m.result.exceptionDetails.text}`);
    }
    return m.result?.result?.value;
  }
  close() { this.ws.close(); }
}

async function connect() {
  for (let i = 0; i < 25; i++) {
    // 刚装完/刚 pm clear 时进程可能还没起来，pidof 会非零退出；
    // 这里吞掉异常继续轮询，别让它把整个验证打断。
    let pid = '';
    try { pid = adb('shell', 'pidof', PKG).trim(); } catch { /* 进程未就绪 */ }
    if (pid) {
      try { adb('forward', '--remove', `tcp:${PORT}`); } catch { /* none */ }
      try {
        adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, {
          signal: AbortSignal.timeout(3000),
        })).json();
        const page = list.find((t) => t.type === 'page');
        if (page?.webSocketDebuggerUrl) {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((res, rej) => {
            ws.addEventListener('open', res, { once: true });
            ws.addEventListener('error', rej, { once: true });
          });
          return new Cdp(ws);
        }
      } catch { /* socket 未就绪 */ }
    }
    await sleep(1000);
  }
  throw new Error('连不上 WebView CDP');
}

/** 造 70 多 KB 的中文 Markdown。 */
function makeBigFile() {
  const line = '这是一行用于验证 App 内导入大文件的中文文本，包含 **加粗**、`代码` 与常见标点。\n';
  const header = `# ${EXPECTED_TITLE}\n\n## 第一节\n\n- [x] 已读条目\n- [ ] 待读条目\n\n`;
  let body = '';
  while (Buffer.byteLength(header + body, 'utf8') < 76 * 1024) body += line;
  const text = header + body;
  const path = join(ROOT, 'artifacts', '.picker-70k.md');
  writeFileSync(path, text, 'utf8');
  return { path, bytes: Buffer.byteLength(text, 'utf8') };
}

const DOM = `(function(){
  const items = [...document.querySelectorAll('[data-testid="doc-item"]')];
  const toast = document.querySelector('[data-testid="toast"]');
  return JSON.stringify({
    docCount: items.length,
    titles: items.map(n => (n.querySelector('.doc-item__title')||{}).textContent||''),
    toast: toast ? toast.textContent : '',
    empty: !!document.querySelector('[data-testid="shelf-empty"]')
  });
})()`;

/** 安全区与元素位置：数值来自真实布局，不是代码推断。 */
const INSET_PROBE = `(function(){
  const cs = getComputedStyle(document.documentElement);
  const top = parseFloat(cs.getPropertyValue('--android-safe-top')) || 0;
  const bottom = parseFloat(cs.getPropertyValue('--android-safe-bottom')) || 0;
  const appbar = document.querySelector('.appbar');
  const shell = document.querySelector('.shell');
  const r = appbar ? appbar.getBoundingClientRect() : null;
  return JSON.stringify({
    injectedTop: top,
    injectedBottom: bottom,
    appbarTop: r ? r.top : null,
    shellPadTop: shell ? parseFloat(getComputedStyle(shell).paddingTop) : null,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio
  });
})()`;

/** 从地面真相开始：清空 App 数据 + 冷启动。 */
function coldStart() {
  adb('shell', 'pm', 'clear', PKG);
  adb('shell', 'am', 'force-stop', PKG);
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
}

/** 用 adb 点击屏幕坐标（真点，不是 JS 触发）。 */
function tap(x, y) { adb('shell', 'input', 'tap', String(x), String(y)); }

async function main() {
  const devices = adb('devices');
  if (!/device\s*$/m.test(devices.replace('List of devices attached', ''))) {
    console.error('✗ 没有可用的 Android 设备/模拟器');
    process.exit(1);
  }

  console.log('=== 准备 70+KB 测试文件 ===');
  const big = makeBigFile();
  adb('push', big.path, DEVICE_FILE);
  adb('shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
    '-d', `file://${DEVICE_FILE}`);
  console.log(`  · ${BIG_NAME}，${big.bytes} bytes`);

  console.log('\n=== 冷启动，读安全区 ===');
  coldStart();
  await sleep(4200);
  const cdp = await connect();
  const inset = JSON.parse(await cdp.eval(INSET_PROBE));
  console.log('  ', inset);
  assert(inset.injectedTop > 0, `原生注入了状态栏高度 --android-safe-top = ${inset.injectedTop}px`);
  assert(inset.appbarTop >= inset.injectedTop - 1,
    `顶栏 top=${inset.appbarTop}px 不侵入状态栏（${inset.injectedTop}px）`);
  screenshot('01-shelf-safe-area');

  console.log('\n=== 真实点击「导入文档」(+) ===');
  // FAB 在右下角：1080x2400 屏幕上约 (950, 2210)
  tap(950, 2210);
  await sleep(1800);
  screenshot('02-saf-open');
  // Android 17 的 dumpsys window 输出格式有变化，焦点行不一定带包名；
  // 用 uiautomator 的当前包名 + 界面根节点的 resource-id 判断更稳。
  let safOpen = false;
  try {
    adb('shell', 'uiautomator', 'dump', '/sdcard/window.xml');
    const xml = adb('shell', 'cat', '/sdcard/window.xml');
    safOpen = /com\.android\.documentsui|Recent files|android\.documentsui/.test(xml);
  } catch { /* 落到下面的断言失败 */ }
  console.log(`  DocumentsUI 界面已确认：${safOpen}`);
  assert(safOpen, '系统文件选择器（DocumentsUI）已打开');

  console.log('\n=== 在 SAF 里选 70KB 文件 ===');
  // 用 uiautomator dump 精确定位文件名节点，避免硬编码坐标。
  // 逐个 <node> 解析：找到 text 含目标文件名的节点，再取它的 bounds。
  let picked = false;
  try {
    adb('shell', 'uiautomator', 'dump', '/sdcard/window.xml');
    const xml = adb('shell', 'cat', '/sdcard/window.xml');
    const nodes = xml.split(/<node\s/).slice(1);
    for (const node of nodes) {
      if (!/text="[^"]*mdlego-picker-70k\.md[^"]*"/.test(node)) continue;
      const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
      if (!b) continue;
      const x1 = Number(b[1]), y1 = Number(b[2]), x2 = Number(b[3]), y2 = Number(b[4]);
      const cx = Math.round((x1 + x2) / 2), cy = Math.round((y1 + y2) / 2);
      tap(cx, cy);
      picked = true;
      console.log(`  · 命中文件节点 bounds=[${x1},${y1}][${x2},${y2}]，点击 (${cx}, ${cy})`);
      break;
    }
  } catch { /* dump 解析失败则回退坐标 */ }

  if (!picked) {
    // 回退：从截图看「最近」页首项约在 (400, 545)
    console.log('  · 未解析到文件节点，回退到列表首项坐标 (400, 545)');
    tap(400, 545);
  }
  await sleep(4000);
  screenshot('03-after-pick');

  console.log('\n=== 断言：书架出现 1 篇（不再卡死）===');
  const s = JSON.parse(await cdp.eval(DOM));
  console.log(`  DOM：docCount=${s.docCount} titles=${JSON.stringify(s.titles)} toast="${s.toast}"`);
  assert(s.docCount === 1, '选完 70KB 文件后书架出现 1 篇（回调生效，没有卡死）');
  assert(s.titles[0] === EXPECTED_TITLE, `标题正确：${EXPECTED_TITLE}`);

  console.log('\n=== 断言：搜索框不顶到状态栏 ===');
  // 打开文档 → 点搜索 → 量输入框位置
  await cdp.eval(`document.querySelector('[data-testid="doc-item"]').click()`);
  await sleep(1200);
  await cdp.eval(`document.querySelector('[data-testid="open-search"]').click()`);
  await sleep(800);
  const searchProbe = `(function(){
    const input = document.querySelector('[data-testid="search-input"]');
    const cs = getComputedStyle(document.documentElement);
    const top = parseFloat(cs.getPropertyValue('--android-safe-top')) || 0;
    const r = input ? input.getBoundingClientRect() : null;
    return JSON.stringify({ injectedTop: top, inputTop: r ? r.top : null });
  })()`;
  const sp = JSON.parse(await cdp.eval(searchProbe));
  console.log('  ', sp);
  assert(sp.injectedTop > 0, '搜索页同样读到了状态栏高度');
  assert(sp.inputTop >= sp.injectedTop - 1,
    `搜索框 top=${sp.inputTop}px 不侵入状态栏（${sp.injectedTop}px）`);
  screenshot('04-search-safe-area');

  cdp.close();
  console.log('\n✓ App 内导入 + 状态栏安全区验证通过');
}

main().catch((e) => { console.error(`\n✗ 验证失败：${e.message}`); process.exit(1); });
