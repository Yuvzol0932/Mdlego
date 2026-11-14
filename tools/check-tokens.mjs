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

if (violations.length > 0) {
  console.error(`\n✗ 设计令牌检查失败：${violations.length} 处硬编码色值\n`);
  for (const v of violations.slice(0, 40)) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.message}`);
  }
  if (violations.length > 40) console.error(`  …另有 ${violations.length - 40} 处`);
  console.error('\n  规则见 docs/CONVENTIONS.md §5\n');
  process.exit(1);
}

console.log('✓ 设计令牌检查通过');
