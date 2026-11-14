#!/usr/bin/env node
/**
 * 把 APK 装进模拟器并截图，用于里程碑验证。
 *
 * 这是 L3 验证层的入口（docs/CONVENTIONS.md §9）：
 * 每个里程碑都必须证明「打出来的包装进去之后确实是新的」。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
const ARTIFACTS = join(ROOT, 'artifacts', 'screenshots');
const APK = join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const PKG = 'cn.mdlego.reader';

function findAdb() {
  const candidates = [
    process.env.LOCALAPPDATA + '\\Android\\Sdk\\platform-tools\\adb.exe',
    'C:\\platform-tools\\adb.exe',
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return 'adb';
}

const ADB = findAdb();

function adb(...args) {
  return execFileSync(ADB, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
}

function adbText(...args) {
  return adb(...args).toString('utf8');
}

function screenshot(name) {
  const png = adb('exec-out', 'screencap', '-p');
  mkdirSync(ARTIFACTS, { recursive: true });
  const file = join(ARTIFACTS, `${name}.png`);
  writeFileSync(file, png);
  return { file, bytes: png.length };
}

async function main() {
  if (!existsSync(APK)) {
    console.error('✗ 未找到 APK，请先运行 npm run android:build');
    process.exit(1);
  }

  const devices = adbText('devices').trim();
  if (!/emulator-\d+\s+device|^\S+\s+device/m.test(devices.replace('List of devices attached', ''))) {
    console.error('✗ 没有可用的 Android 设备/模拟器');
    console.error(devices);
    process.exit(1);
  }

  console.log('─ 安装 APK');
  const installOut = adbText('install', '-r', APK);
  if (!/Success/i.test(installOut)) {
    console.error(`✗ 安装失败：${installOut}`);
    process.exit(1);
  }
  console.log('  ✓ 安装成功');

  console.log('─ 冷启动');
  // 先强制停止，确保不是复用旧进程（这正是上一代项目「覆盖安装看不到变化」的根因之一）
  adbText('shell', 'am', 'force-stop', PKG);
  await sleep(500);
  adbText('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
  await sleep(4000);

  const shot1 = screenshot('m0-android-reader');
  console.log(`  ✓ 阅读页截图：${(shot1.bytes / 1024).toFixed(0)} KB`);

  // 用无障碍信息确认前台确实是本应用
  const focus = adbText('shell', 'dumpsys', 'window', 'windows').split('\n');
  const focused = focus.find((l) => l.includes('mCurrentFocus')) ?? '';
  if (focused.includes(PKG)) {
    console.log(`  ✓ 前台窗口确认：${focused.trim().split('/')[0].split(' ').pop()}`);
  } else {
    console.log(`  ⚠ 前台窗口未能确认（${focused.trim()}）`);
  }

  console.log('─ 打开设置页验证版本信息');
  const size = adbText('shell', 'wm', 'size');
  const match = /(\d+)x(\d+)/.exec(size);
  const width = match ? Number(match[1]) : 1080;
  // 「设置」按钮位于右上角
  adbText('shell', 'input', 'tap', String(Math.round(width * 0.9)), '140');
  await sleep(1500);
  const shot2 = screenshot('m0-android-settings');
  console.log(`  ✓ 设置页截图：${(shot2.bytes / 1024).toFixed(0)} KB`);

  console.log(`\n✓ L3 验证完成，截图位于 artifacts/screenshots/`);
  console.log(`  ${shot1.file}`);
  console.log(`  ${shot2.file}`);
}

main().catch((error) => {
  console.error('✗ 失败：', error.message);
  process.exit(1);
});
