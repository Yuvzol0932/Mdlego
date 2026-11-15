#!/usr/bin/env node
/**
 * 真机/模拟器验证：系统「打开 / 分享」导入链路。
 *
 * 断言的是用户真正看得见的东西 —— 书架上的文档卡片，而不是内部调试对象。
 * 通过 adb forward 连上 App 的 WebView CDP，读真实 DOM。
 *
 * 四个场景，每个都从 pm clear 后的空书架开始（地面真相）：
 *   1. view    带 URI 读授权的 ACTION_VIEW        → 书架出现 1 篇
 *   2. resend  同一进程再次分享同一文件          → 仍 1 篇（去重 + onNewIntent 订阅生效）
 *   3. send    带授权的 ACTION_SEND              → 书架出现 1 篇
 *   4. retry   先无授权（失败可见）再带授权      → 失败时书架空且有提示，重试后 1 篇
 *
 * 场景 4 专门回归一个真实缺陷：旧实现「取出 URI 即清空」，
 * 一次权限失败会永久吞掉这份分享，用户再点「打开」也不会有反应。
 *
 * 用法：node tools/verify-share.mjs [view|resend|send|retry|all]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const ARTIFACTS = join(ROOT, 'artifacts', 'screenshots');
const PKG = 'cn.mdlego.reader';
const PORT = 9340;
const DEVICE_FILE = '/sdcard/Download/mdlego-share-check.md';
const CONTENT_URI =
  'content://com.android.externalstorage.documents/document/primary%3ADownload%2Fmdlego-share-check.md';
const EXPECTED_TITLE = '系统分享验证文档';
const GRANT_READ = '0x1'; // FLAG_GRANT_READ_URI_PERMISSION
const SAMPLE = `# ${EXPECTED_TITLE}

这是一篇通过系统「打开 / 分享」投递进墨读的测试文档。

## 第二节

用来确认正文完整落库，而不只是标题进来了。
`;

function findAdb() {
  const candidates = [
    process.env.LOCALAPPDATA + '\\Android\\Sdk\\platform-tools\\adb.exe',
    'C:\\platform-tools\\adb.exe',
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return 'adb';
}
const ADB = findAdb();

/** 文本输出的 adb 调用（吞掉 stderr 噪音，失败时由调用方看异常）。 */
function adb(...args) {
  return execFileSync(ADB, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
/** 二进制输出的 adb 调用（截图必须用这个，不能按 utf8 解码）。 */
function adbBuf(...args) {
  return execFileSync(ADB, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
}

function assert(condition, message) {
  if (!condition) throw new Error(`✗ ${message}`);
  console.log(`  ✓ ${message}`);
}

function screenshot(name) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const file = join(ARTIFACTS, `m2-share-${name}.png`);
  const png = adbBuf('exec-out', 'screencap', '-p');
  writeFileSync(file, png);
  console.log(`    截图 ${file} (${(png.length / 1024).toFixed(0)} KB)`);
}

/** 极简 CDP 客户端，只用到 Runtime.evaluate。 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve: res } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        res(msg);
      }
    });
  }
  send(method, params = {}) {
    const msgId = ++this.id;
    this.ws.send(JSON.stringify({ id: msgId, method, params }));
    return new Promise((res) => this.pending.set(msgId, { resolve: res }));
  }
  async eval(expression) {
    const msg = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (msg.result?.exceptionDetails) {
      throw new Error(`页面脚本异常：${msg.result.exceptionDetails.text}`);
    }
    return msg.result?.result?.value;
  }
  close() { this.ws.close(); }
}

/** App 冷启动后 WebView 的调试 socket 要过几秒才出现，轮询连接。 */
async function connectCdp() {
  for (let i = 0; i < 25; i++) {
    const pid = adb('shell', 'pidof', PKG).trim();
    if (pid) {
      try { adb('forward', '--remove', `tcp:${PORT}`); } catch { /* 尚无 forward */ }
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
      } catch { /* socket 还没起来，继续等 */ }
    }
    await sleep(1000);
  }
  throw new Error('连不上 App WebView 的 CDP（请确认装的是 debug 包且 WebView 可调试）');
}

/** 读真实 DOM：书架卡片数、标题、toast、空状态。 */
const PROBE = `(function(){
  const items = [...document.querySelectorAll('[data-testid="doc-item"]')];
  const toast = document.querySelector('[data-testid="toast"]');
  return JSON.stringify({
    docCount: items.length,
    titles: items.map(n => (n.querySelector('.doc-item__title') || {}).textContent || ''),
    toast: toast ? toast.textContent : '',
    empty: !!document.querySelector('[data-testid="shelf-empty"]'),
    hash: location.hash
  });
})()`;

async function probe(cdp) {
  const raw = await cdp.eval(PROBE);
  return JSON.parse(raw);
}

/**
 * 等导入真正落地再断言。
 *
 * 冷启动后 CDP 可能比 300ms 的分享消费更早连上，此时读到的是空 DOM，
 * 会被误判成「导入失败」。轮询到出现文档或 toast 为止，最多 6 秒。
 */
async function waitForImport(cdp) {
  let last = null;
  for (let i = 0; i < 30; i++) {
    last = await probe(cdp);
    if (last.docCount > 0 || last.toast.length > 0) return last;
    await sleep(200);
  }
  return last;
}

/** 重置到干净的空书架。 */
function resetApp() {
  adb('shell', 'pm', 'clear', PKG);
  console.log('  · pm clear（清空 IndexedDB，保证地面真相）');
}

/** 推送测试文档到设备。 */
function pushTestFile() {
  const tmp = join(ROOT, 'artifacts', '.share-check.md');
  writeFileSync(tmp, SAMPLE, 'utf8');
  adb('push', tmp, DEVICE_FILE);
  // 让 MediaStore / ExternalStorageProvider 能查到这个文件
  adb('shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
    '-d', `file://${DEVICE_FILE}`);
}

/** 带 URI 读授权的 ACTION_VIEW（模拟文件管理器「用墨读打开」）。 */
function fireView(granted) {
  const args = ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW',
    '-d', CONTENT_URI, '-t', 'text/markdown'];
  if (granted) args.push('-f', GRANT_READ);
  args.push('-n', `${PKG}/.MainActivity`);
  adb(...args);
}

/**
 * 带 URI 读授权的 ACTION_SEND（模拟「分享到墨读」）。
 *
 * 注意：am 命令行的 -f FLAG_GRANT_READ_URI_PERMISSION 只对 intent 的 data URI
 * 授权，对 EXTRA_STREAM 里的 Uri 不授权（Android 5.0+ 还要 ClipData）。
 * 真实分享由发送方正确授权；这里同时用 -d 指向同一 Uri，
 * 让命令行也能把读授权落到该 Uri 上，从而测到产品逻辑而非 adb 限制。
 */
function fireSend() {
  adb('shell', 'am', 'start', '-a', 'android.intent.action.SEND',
    '-d', CONTENT_URI,
    '-t', 'text/markdown',
    '--eu', 'android.intent.extra.STREAM', CONTENT_URI,
    '-f', GRANT_READ,
    '-n', `${PKG}/.MainActivity`);
}

/** 等应用把导入跑完（300ms 延迟 + 原生读取 + IndexedDB 落库）。 */
const SETTLE_MS = 3200;

async function caseView() {
  console.log('\n[1] view —— 带授权的 ACTION_VIEW');
  resetApp();
  pushTestFile();
  fireView(true);
  await sleep(SETTLE_MS);
  const cdp = await connectCdp();
  const s = await waitForImport(cdp);
  console.log(`    实测：docCount=${s.docCount} titles=${JSON.stringify(s.titles)} toast="${s.toast}"`);
  assert(s.docCount === 1, '书架出现 1 篇文档（系统「打开」导入成功）');
  assert(s.titles[0] === EXPECTED_TITLE, `标题正确：${EXPECTED_TITLE}`);
  screenshot('view');
  return cdp;
}

async function caseResend(cdp) {
  console.log('\n[2] resend —— 同一进程再次分享同一文件');
  fireView(true); // App 在前台 → onNewIntent → subscribeToShares
  await sleep(SETTLE_MS);
  const s = await waitForImport(cdp);
  console.log(`    实测：docCount=${s.docCount} toast="${s.toast}"`);
  assert(s.docCount === 1, '仍只有 1 篇（内容去重 + onNewIntent 订阅生效，没有重复导入）');
  screenshot('resend');
}

async function caseSend() {
  console.log('\n[3] send —— 带授权的 ACTION_SEND');
  resetApp();
  pushTestFile();
  fireSend();
  await sleep(SETTLE_MS);
  const cdp = await connectCdp();
  const s = await waitForImport(cdp);
  console.log(`    实测：docCount=${s.docCount} titles=${JSON.stringify(s.titles)} toast="${s.toast}"`);
  assert(s.docCount === 1, '书架出现 1 篇文档（系统「分享」导入成功）');
  assert(s.titles[0] === EXPECTED_TITLE, `标题正确：${EXPECTED_TITLE}`);
  screenshot('send');
  cdp.close();
}

async function caseRetry() {
  console.log('\n[4] retry —— 先无授权失败，再带授权重试（回归「URI 被吞」缺陷）');
  resetApp();
  pushTestFile();

  // 第一次：不带读授权，模拟权限被拒
  fireView(false);
  await sleep(SETTLE_MS);
  const cdp = await connectCdp();
  const failed = await waitForImport(cdp);
  console.log(`    失败态实测：docCount=${failed.docCount} empty=${failed.empty} toast="${failed.toast}"`);
  assert(failed.docCount === 0, '权限被拒时书架保持为空（没有半吊子数据）');
  assert(failed.empty === true, '空书架提示仍在');
  assert(failed.toast.length > 0, `失败给出可见提示，而不是静默无反应："${failed.toast}"`);
  screenshot('retry-denied');

  // 第二次：同一进程带授权重试。旧实现此时 pendingUris 已被清空 → 永远失败。
  fireView(true);
  await sleep(SETTLE_MS);
  const retried = await waitForImport(cdp);
  console.log(`    重试实测：docCount=${retried.docCount} titles=${JSON.stringify(retried.titles)}`);
  assert(retried.docCount === 1, '重试后导入成功（证明失败时 URI 被保留，没有被「取出即清空」吞掉）');
  assert(retried.titles[0] === EXPECTED_TITLE, `标题正确：${EXPECTED_TITLE}`);
  screenshot('retry-ok');
  cdp.close();
}

async function main() {
  const which = process.argv[2] ?? 'all';
  const devices = adb('devices');
  if (!/device\s*$/m.test(devices.replace('List of devices attached', ''))) {
    console.error('✗ 没有可用的 Android 设备/模拟器');
    process.exit(1);
  }
  console.log(`设备：${devices.trim().split('\n').slice(1).join(' | ')}`);
  console.log(`目标：${PKG}  ·  测试文件：${DEVICE_FILE}`);

  let passed = 0;
  const total = which === 'all' ? 4 : 1;

  if (which === 'all' || which === 'view') {
    const cdp = await caseView();
    if (which === 'all') await caseResend(cdp);
    cdp.close();
    passed += which === 'all' ? 2 : 1;
  }
  if (which === 'all' || which === 'send') { await caseSend(); passed++; }
  if (which === 'all' || which === 'retry') { await caseRetry(); passed++; }

  console.log(`\n✓ 系统「打开 / 分享」验证通过：${passed}/${total} 场景`);
}

main().catch((error) => {
  console.error(`\n✗ 验证失败：${error.message}`);
  process.exit(1);
});
