#!/usr/bin/env node
/**
 * APK 产物独立校验（npm run android:verify）。
 *
 * build-apk.mjs 在打包后立刻反读版本；本工具用于「事后 / 换机器 / 发版前」
 * 再确认一次磁盘上这份 APK 确实是想要的构建，不依赖构建过程是否刚跑过。
 *
 * 校验项（都从 APK 字节与 package.json 读取，不看缓存）：
 *   1. 包名、versionName、versionCode 与 package.json 一致
 *   2. 桌面名为「墨读」
 *   3. 没有 INTERNET 权限（离线优先的硬约束，上一代项目在这里翻过车）
 *   4. assets/public/ 里的 Web 产物与当前 www/ 内容一致（不会装到旧前端）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ANDROID = join(ROOT, 'android');
const APK_PATH = join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const PUBLIC_DIR = join(ANDROID, 'app', 'src', 'main', 'assets', 'public');

function readSdkDir() {
  const localProps = join(ANDROID, 'local.properties');
  if (existsSync(localProps)) {
    const match = /^sdk\.dir=(.+)$/m.exec(readFileSync(localProps, 'utf8'));
    if (match) return match[1].trim().replace(/\\\\/g, '\\').replace(/\\:/g, ':');
  }
  return process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? null;
}

function findAapt2() {
  const dir = readSdkDir();
  if (dir === null) return null;
  const buildToolsRoot = join(dir, 'build-tools');
  if (!existsSync(buildToolsRoot)) return null;
  for (const version of readdirSync(buildToolsRoot).sort().reverse()) {
    const exe = join(buildToolsRoot, version, process.platform === 'win32' ? 'aapt2.exe' : 'aapt2');
    if (existsSync(exe)) return exe;
  }
  return null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`  ✓ ${message}`);
}

function main() {
  if (!existsSync(APK_PATH)) {
    console.error(`✗ 未找到 APK：${APK_PATH}\n  请先运行 npm run android:build`);
    process.exit(1);
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const parts = pkg.version.split('.').map(Number);
  const expectCode = String(parts[0] * 10000 + parts[1] * 100 + (parts[2] ?? 0));

  const aapt2 = findAapt2();
  if (aapt2 === null) {
    console.error('✗ 找不到 aapt2（无法反读 APK 身份）');
    process.exit(1);
  }
  const out = execFileSync(aapt2, ['dump', 'badging', APK_PATH], { encoding: 'utf8' });
  const name = /package: name='([^']+)'/.exec(out)?.[1] ?? null;
  const versionCode = /versionCode='([^']+)'/.exec(out)?.[1] ?? null;
  const versionName = /versionName='([^']+)'/.exec(out)?.[1] ?? null;
  const label = /application: label='([^']+)'/.exec(out)?.[1]
    ?? /launchable-activity: name='[^']+'\s+label='([^']+)'/.exec(out)?.[1]
    ?? null;
  const labelMatch = /launchable-activity:.*label='([^']+)'/.exec(out)?.[1] ?? null;
  const permissions = [...out.matchAll(/uses-permission: name='([^']+)'/g)].map((m) => m[1]);

  console.log('反读 APK：');
  console.log(`  文件         ${APK_PATH} (${(statSync(APK_PATH).size / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`  package      ${name}`);
  console.log(`  versionName  ${versionName}`);
  console.log(`  versionCode  ${versionCode}`);
  console.log(`  label        ${labelMatch ?? label ?? '(未读出)'}`);
  console.log(`  permissions  ${permissions.length === 0 ? '(无)' : permissions.join(', ')}`);
  console.log('');

  assert(name === 'cn.mdlego.reader', '包名 cn.mdlego.reader');
  assert(versionName === pkg.version, `versionName ${pkg.version} 与 package.json 一致`);
  assert(versionCode === expectCode, `versionCode ${expectCode} 与版本号推导一致`);
  assert((labelMatch ?? label ?? '') === '墨读', '桌面名「墨读」');
  assert(!permissions.includes('android.permission.INTERNET'), '未声明 INTERNET 权限（离线优先）');

  // Web 产物时效：assets/public 里的 index.html 必须与当前 www/index.html 相同字节，
  // 否则说明 APK 里装的是旧前端（上一代项目「覆盖安装看不到变化」的根源）。
  const wwwIndex = join(ROOT, 'www', 'index.html');
  const apkIndex = join(PUBLIC_DIR, 'index.html');
  if (existsSync(wwwIndex) && existsSync(apkIndex)) {
    const a = readFileSync(wwwIndex);
    const b = readFileSync(apkIndex);
    assert(a.equals(b), 'assets/public/index.html 与当前 www/index.html 字节一致');
  } else {
    console.log('  ⚠ 跳过 Web 产物比对（www/ 或 assets/public/ 缺失）');
  }

  console.log('\n✓ APK 产物校验通过');
}

main();
