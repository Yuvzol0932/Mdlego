#!/usr/bin/env node
/**
 * 设计令牌单一来源检查。
 *
 * 颜色、字号、间距、圆角只允许定义在 tokens.css。
 * 其它 CSS 与 TS 文件中出现硬编码色值即违规。
 *
 * 规则见 docs/CONVENTIONS.md §5。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const WEB = join(ROOT, 'web');

/** 允许硬编码色值的文件（令牌定义处 + 图标 SVG）。 */
const ALLOWED = new Set(['src/styles/tokens.css']);

/** 十六进制色值：3/4/6/8 位。 */
const HEX_COLOR = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

/** 函数式颜色。 */
const FUNC_COLOR = /\b(?:rgb|rgba|hsl|hsla)\(/g;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(css|ts)$/.test(full) && !/\.test\.ts$/.test(full)) out.push(full);
  }
  return out;
}

const violations = [];

for (const file of walk(WEB)) {
  const rel = relative(WEB, file).replace(/\\/g, '/');
  if (ALLOWED.has(rel)) continue;
  // 主题文件与 tokens 同属令牌层
  if (rel.startsWith('src/styles/tokens')) continue;

  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r\n|\n/);

  lines.forEach((line, index) => {
    // 跳过纯注释行
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    // 允许 URL 片段里的 #
    const withoutUrls = line.replace(/url\([^)]*\)/g, '');

    for (const match of withoutUrls.matchAll(HEX_COLOR)) {
      violations.push({
        file: rel,
        line: index + 1,
        message: `硬编码色值 ${match[0]}；请改用 tokens.css 中的 var(--…)`,
      });
    }
    for (const match of withoutUrls.matchAll(FUNC_COLOR)) {
      violations.push({
        file: rel,
        line: index + 1,
        message: `硬编码颜色函数 ${match[0]}…；请改用 tokens.css 中的 var(--…)`,
      });
    }
  });
}

// ── 玻璃规则（阶段 B3）：backdrop-filter 只许出现在 glass.css，
//    且在 glass.css 里必须只出现在「材质=glass」的规则里 ——
//    这样「纯色 / 柔和半透明」档下整个应用没有任何 backdrop-filter。
/** 去掉 CSS 注释（不用正则，逐段找注释起止符）。 */
function stripCssComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('/*', i);
    if (open < 0) return out + text.slice(i);
    out += text.slice(i, open);
    const close = text.indexOf('*/', open + 2);
    i = close < 0 ? text.length : close + 2;
  }
  return out;
}

for (const file of walk(WEB)) {
  const rel = relative(WEB, file).split('\\').join('/');
  if (!rel.endsWith('.css')) continue;
  const text = readFileSync(file, 'utf8');
  if (!text.includes('backdrop-filter')) continue;
  if (rel !== 'src/styles/glass.css') {
    violations.push({ file: rel, line: 0, message: 'backdrop-filter 只允许写在 styles/glass.css' });
    continue;
  }
  // 最内层规则：选择器 { 声明 }（@supports 之类的外层包装不含声明，会被自然跳过）
  const code = stripCssComments(text);
  const ruleRe = new RegExp('([^{}]+)\\{([^{}]*)\\}', 'g');
  for (const rule of code.matchAll(ruleRe)) {
    const selector = rule[1] ?? '';
    const body = rule[2] ?? '';
    if (body.includes('backdrop-filter') && !selector.includes("[data-material='glass']")) {
      violations.push({
        file: rel,
        line: 0,
        message: 'backdrop-filter 必须限定在材质=glass 的选择器之下：' + selector.trim().slice(0, 60),
      });
    }
  }
}

if (violations.length > 0) {
  console.error(`\n✗ 设计令牌检查失败：${violations.length} 处违规\n`);
  for (const v of violations.slice(0, 40)) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.message}`);
  }
  if (violations.length > 40) console.error(`  …另有 ${violations.length - 40} 处`);
  console.error('\n  规则见 docs/CONVENTIONS.md §5\n');
  process.exit(1);
}

console.log('✓ 设计令牌检查通过');
