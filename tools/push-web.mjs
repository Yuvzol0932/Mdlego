#!/usr/bin/env node
/**
 * 把构建产物推送到 Android 工程的 assets 目录。
 *
 * 为什么不用 `npx cap sync`：
 *   cap sync 会顺带执行 cap copy + cap update，update 阶段会尝试覆盖
 *   android/ 下的原生工程文件，在有自定义原生代码时反而危险。
 *   这里只做一件事：把 www/ 原样镜像到 assets/public/。
 */
import { cpSync, rmSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'www');
const DEST = join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'public');

if (!existsSync(SRC)) {
  console.error('✗ 未找到 www/，请先运行 npm run build');
  process.exit(1);
}

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
cpSync(SRC, DEST, { recursive: true });

/** 递归统计文件数与总字节。 */
function stat(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      const inner = stat(full);
      files += inner.files;
      bytes += inner.bytes;
    } else {
      files++;
      bytes += statSync(full).size;
    }
  }
  return { files, bytes };
}

const s = stat(DEST);
console.log(`✓ 已推送 Web 产物：${s.files} 个文件，${(s.bytes / 1024).toFixed(1)} KB`);
console.log(`  → ${DEST}`);
