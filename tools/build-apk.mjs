#!/usr/bin/env node
/**
 * 构建 APK 并在打包后反读校验。
 *
 * 为什么不用 gradlew：
 *   gradlew 会按 gradle-wrapper.properties 去下载发行包，
 *   而本机 ~/.gradle/wrapper/dists 里已经有一份完整的 8.14.3。
 *   直接调用本地已有发行包可以省掉整次下载（也避免网络抖动导致构建失败）。
 *   若本地没有，则回退到 gradlew。
 *
 * 校验（docs/CONVENTIONS.md §6）：
 *   打包后用 aapt2 dump badging 反读 APK 的 versionName / versionCode，
 *   与 package.json 对比；不一致立即失败，避免「装错包」。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ANDROID = join(ROOT, 'android');
const SDK_DIR = readSdkDir();
const APK_PATH = join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');

/** 从 android/local.properties 读取 sdk.dir。 */
function readSdkDir() {
  const localProps = join(ANDROID, 'local.properties');
  if (existsSync(localProps)) {
    const match = /^sdk\.dir=(.+)$/m.exec(readFileSync(localProps, 'utf8'));
    if (match) return match[1].trim().replace(/\\\\/g, '\\').replace(/\\:/g, ':');
  }
  if (process.env.ANDROID_SDK_ROOT) return process.env.ANDROID_SDK_ROOT;
  if (process.env.ANDROID_HOME) return process.env.ANDROID_HOME;
  return null;
}

/** 找到本地已缓存的 Gradle 发行包。 */
function findCachedGradle() {
  const home = process.env.GRADLE_USER_HOME ?? join(process.env.USERPROFILE ?? '', '.gradle');
  const dists = join(home, 'wrapper', 'dists');
  if (!existsSync(dists)) return null;

  const candidates = [];
  for (const distName of readdirSync(dists)) {
    if (!distName.startsWith('gradle-')) continue;
    const distRoot = join(dists, distName);
    for (const hashDir of readdirSync(distRoot)) {
      const inner = join(distRoot, hashDir);
      if (!statSync(inner).isDirectory()) continue;
      for (const versionDir of readdirSync(inner)) {
        if (!versionDir.startsWith('gradle-')) continue;
        const bin = join(inner, versionDir, 'bin', 'gradle.bat');
        if (existsSync(bin)) candidates.push({ version: versionDir, bin });
      }
    }
  }

  // 优先 8.14.x
  candidates.sort((a, b) => (b.version.includes('8.14') ? 1 : 0) - (a.version.includes('8.14') ? 1 : 0));
  return candidates[0] ?? null;
}

/** 用 aapt2 反读 APK 的版本信息。 */
function readApkBadging(apkPath) {
  if (SDK_DIR === null) return null;
  const buildToolsRoot = join(SDK_DIR, 'build-tools');
  if (!existsSync(buildToolsRoot)) return null;

  const versions = readdirSync(buildToolsRoot).sort().reverse();
  for (const version of versions) {
    const aapt2 = join(buildToolsRoot, version, 'aapt2.exe');
    if (!existsSync(aapt2)) continue;
    const out = execFileSync(aapt2, ['dump', 'badging', apkPath], { encoding: 'utf8' });
    const name = /package: name='([^']+)'/.exec(out)?.[1] ?? null;
    const versionCode = /versionCode='([^']+)'/.exec(out)?.[1] ?? null;
    const versionName = /versionName='([^']+)'/.exec(out)?.[1] ?? null;
    return { name, versionCode, versionName, aapt2, raw: out };
  }
  return null;
}

function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  // versionCode：major*1e6 + minor*1e4 + patch*100 + 阶段位。
  // 正式版阶段位 99；rc.N 为 50+N（保证 1.0.0-rc < 1.0.0，且历史 0.7.0/0.8.0 的 700/800 仍小于它）。
  const versionCore = pkg.version.split('-')[0].split('.').map(Number);
  const rcMatch = /-rc\.(\d+)/.exec(pkg.version);
  const stage = rcMatch !== null ? 50 + Math.min(49, Number(rcMatch[1])) : 99;
  const expectCode = String(
    versionCore[0] * 1000000 + (versionCore[1] ?? 0) * 10000 + (versionCore[2] ?? 0) * 100 + stage,
  );

  const cached = findCachedGradle();
  const isWin = process.platform === 'win32';
  let cmd;
  let args;

  if (cached !== null) {
    console.log(`使用本地缓存的 ${cached.version}`);
    cmd = cached.bin;
    args = ['clean', 'assembleDebug', '--no-daemon', '--console=plain'];
  } else {
    console.log('本地无缓存 Gradle，回退到 gradlew（可能需要下载）');
    cmd = isWin ? join(ANDROID, 'gradlew.bat') : join(ANDROID, 'gradlew');
    args = ['clean', 'assembleDebug', '--no-daemon', '--console=plain'];
  }

  const result = spawnSync(cmd, args, {
    cwd: ANDROID,
    stdio: 'inherit',
    env: { ...process.env, JAVA_HOME: process.env.JAVA_HOME ?? 'D:\\Tools\\jdk21' },
    shell: isWin,
  });

  if (result.status !== 0) {
    console.error('\n✗ Gradle 构建失败');
    process.exit(1);
  }

  if (!existsSync(APK_PATH)) {
    console.error(`\n✗ 未找到产物：${APK_PATH}`);
    process.exit(1);
  }

  const size = statSync(APK_PATH).size;
  console.log(`\n✓ 构建成功：${(size / 1024 / 1024).toFixed(2)} MB`);

  // ── 反读校验：确保装进去的就是刚构建的 ──
  const badging = readApkBadging(APK_PATH);
  if (badging === null) {
    console.warn('⚠ 无法读取 APK 版本信息（缺少 aapt2），跳过反读校验');
    process.exit(0);
  }

  console.log('\n反读 APK：');
  console.log(`  package      ${badging.name}`);
  console.log(`  versionName  ${badging.versionName}`);
  console.log(`  versionCode  ${badging.versionCode}`);

  const problems = [];
  if (badging.name !== 'cn.mdlego.reader') problems.push(`包名不符：${badging.name}`);
  if (badging.versionName !== pkg.version) {
    problems.push(`versionName 不符：APK=${badging.versionName} package.json=${pkg.version}`);
  }
  if (badging.versionCode !== expectCode) {
    problems.push(`versionCode 不符：APK=${badging.versionCode} 期望=${expectCode}`);
  }

  if (problems.length > 0) {
    console.error('\n✗ 反读校验失败：');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log(`\n✓ 反读校验通过：版本 ${pkg.version}（${expectCode}）与 package.json 一致`);
  console.log(`  产物：${APK_PATH}`);
}

main();
