#!/usr/bin/env node
/**
 * 打包 CSS 审计（rc.3 B 项）。
 *
 * 背景：Vite 8 用 Lightning CSS 压缩 CSS，会**丢弃/改写**某些声明。
 * 已实测：`.a{left:50%;translate:-50% 0;transform:none}` → `.a{left:50%;transform:none}`，
 * 独立变换属性 translate 被整条丢掉（开发服务器正常，打包后加号右偏半个身位）。
 *
 * 本脚本逐条列出源码里「风险属性」的声明，并对照 www/assets/*.css：
 *   - 产物里该属性一个都没有 → DROPPED（失败）
 *   - 数量对不上            → 数量不一致（失败，列出源码位置）
 *   - 数量一致              → 保留
 *
 * 用法：node tools/audit-built-css.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'web', 'src', 'styles');
const WWW = join(ROOT, 'www');

/** 必须逐个确认的风险声明（属性名 → 是否属于「独立变换属性」，后者出现即高危）。 */
const RISK = [
  { prop: 'translate', note: '独立变换：Lightning CSS 会整条丢弃' },
  { prop: 'scale', note: '独立变换' },
  { prop: 'rotate', note: '独立变换' },
  { prop: 'animation-timeline', note: '滚动驱动动画' },
  { prop: 'animation-range', note: '滚动驱动动画' },
  { prop: 'view-transition-name', note: 'View Transitions（rc.3 将移除）' },
  { prop: 'clip-path', note: '遮罩转场' },
  { prop: 'scroll-snap-stop', note: '轮播吸附' },
  { prop: 'margin-inline', note: '逻辑属性居中' },
  { prop: 'backdrop-filter', note: '玻璃模糊' },
];

const cssFiles = readdirSync(SRC).filter((f) => f.endsWith('.css')).sort();
const srcDecls = [];
for (const file of cssFiles) {
  const lines = readFileSync(join(SRC, file), 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = line.match(/^\s*([a-z-]+)\s*:\s*([^;{}]+);?\s*$/i);
    if (!m) return;
    const prop = m[1].toLowerCase();
    if (!RISK.some((r) => r.prop === prop)) return;
    srcDecls.push({ file, line: i + 1, prop, value: m[2].trim() });
  });
}

const builtFiles = readdirSync(join(WWW, 'assets')).filter((f) => f.endsWith('.css'));
if (builtFiles.length === 0) {
  console.error('✗ 未找到 www/assets/*.css，请先 npm run build');
  process.exit(1);
}
const built = builtFiles.map((f) => readFileSync(join(WWW, 'assets', f), 'utf8')).join('\n');

const countBuilt = (prop) => {
  const re = new RegExp(`(?:^|[;{])\\s*${prop.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\s*:`, 'gi');
  return (built.match(re) ?? []).length;
};

console.log(`源码：web/src/styles/*.css（${cssFiles.length} 个文件）`);
console.log(`产物：www/assets/*.css（${builtFiles.map((f) => basename(f)).join(', ')}）\n`);
console.log('属性'.padEnd(22) + '源码'.padEnd(6) + '产物'.padEnd(6) + '判定');
console.log('-'.repeat(64));

let failed = 0;
for (const { prop, note } of RISK) {
  const list = srcDecls.filter((d) => d.prop === prop);
  if (list.length === 0) {
    console.log(`${prop.padEnd(22)}${'0'.padEnd(6)}${String(countBuilt(prop)).padEnd(6)}✓ 源码未使用`);
    continue;
  }
  const nBuilt = countBuilt(prop);
  const verdict = nBuilt === 0 ? '✗ DROPPED（产物里没有）' : nBuilt !== list.length ? `✗ 数量不一致（${note}）` : `✓ 保留（${list.length} 处）`;
  if (nBuilt !== list.length) failed += 1;
  console.log(`${prop.padEnd(22)}${String(list.length).padEnd(6)}${String(nBuilt).padEnd(6)}${verdict}`);
}

console.log('\n逐条声明：');
for (const d of srcDecls) {
  console.log(`  ${d.file}:${d.line}  ${d.prop}: ${d.value}`);
}
if (failed > 0) {
  console.log(`\n✗ ${failed} 个属性在产物中被丢弃/改写（见上）`);
  process.exitCode = 1;
} else {
  console.log('\n✓ 风险声明在产物中全部保留');
}
