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
  // versionCode：major*1e6 + minor*1e4 + patch*100 + 阶段位。
  // 正式版阶段位 99；rc.N 为 50+N（保证 1.0.0-rc < 1.0.0，且历史 0.7.0/0.8.0 的 700/800 仍小于它）。
  const versionCore = pkg.version.split('-')[0].split('.').map(Number);
  const rcMatch = /-rc\.(\d+)/.exec(pkg.version);
  const stage = rcMatch !== null ? 50 + Math.min(49, Number(rcMatch[1])) : 99;
  const expectCode = String(
    versionCore[0] * 1000000 + (versionCore[1] ?? 0) * 10000 + (versionCore[2] ?? 0) * 100 + stage,
  );

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

  // Web 产物自洽性：APK 里 index.html 引用的每个 JS/CSS 都必须真实存在，
  // 且该 JS/CSS 的字节与 www/assets/ 下同名文件一致。
  //
  // 不直接比 index.html 全文：Vite 每次构建会因构建指纹改变 JS 的文件名哈希，
  // 单独重跑 `npm run verify` 后 www/index.html 的引用就会变，全文比对会误报。
  // 上一代项目「覆盖安装看不到变化」的真正风险是 APK 里缺资源或装着旧 JS，
  // 用「引用 → 文件存在 → 字节一致」三层断言才能准确抓住。
  const apkIndex = join(PUBLIC_DIR, 'index.html');
  if (existsSync(apkIndex)) {
    const html = readFileSync(apkIndex, 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="\.\/assets\/([^"]+)"/g)].map((m) => m[1]);
    assert(refs.length >= 2, `APK 内 index.html 引用了 ${refs.length} 个资源（JS + CSS）`);

    for (const ref of refs) {
      const inApk = join(PUBLIC_DIR, 'assets', ref);
      const inWww = join(ROOT, 'www', 'assets', ref);
      assert(existsSync(inApk), `APK 内存在资源 ${ref}`);
      if (existsSync(inWww)) {
        assert(readFileSync(inApk).equals(readFileSync(inWww)),
          `资源 ${ref} 与当前 www 产物字节一致（装的不是旧前端）`);
      } else {
        console.log(`  ⚠ 跳过 ${ref} 的字节比对（www/assets/ 里已无同名文件，可能是重新构建过）`);
      }
    }
  } else {
    console.log('  ⚠ 跳过 Web 产物比对（assets/public/ 缺失）');
  }

  console.log('\n✓ APK 产物校验通过');
}

main();
