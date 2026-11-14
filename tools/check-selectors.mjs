#!/usr/bin/env node
/**
 * 选择器集中检查。
 *
 * 视图层之外的代码不得用裸 CSS 选择器（querySelector('#…') / querySelector('.…')）找节点。
 * 统一改用 [data-testid="…"]，这样改样式/结构不会打断测试与逻辑。
 *
 * 规则见 docs/CONVENTIONS.md §4。
 */
import ts from 'typescript';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'web', 'src');

/** 允许使用裸选择器的目录（视图层本身负责把 DOM 结构翻译成语义）。 */
const ALLOWED_LAYERS = new Set(['views']);

/** 允许使用裸选择器的函数名（DOM 工具函数）。 */
const ALLOWED_CALLS = new Set(['querySelectorAll']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function layerOf(file) {
  const rel = relative(SRC, file).split(sep);
  return rel.length > 1 ? rel[0] : null;
}

const violations = [];

for (const file of walk(SRC)) {
  const layer = layerOf(file);
  if (layer !== null && ALLOWED_LAYERS.has(layer)) continue;

  const source = ts.createSourceFile(
    file,
    ts.sys.readFile(file) ?? '',
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );

  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (method === 'querySelector' || method === 'querySelectorAll') {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          const sel = arg.text.trim();
          const isBare = /^[#.]/.test(sel) || /^[a-z]+$/i.test(sel);
          if (isBare) {
            violations.push({
              file: relative(ROOT, file),
              line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
              message: `裸选择器 "${sel}"；请改用 [data-testid="…"]`,
            });
          }
        }
      }
      void ALLOWED_CALLS;
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
}

if (violations.length > 0) {
  console.error(`\n✗ 选择器集中检查失败：${violations.length} 处\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.message}`);
  }
  console.error('\n  规则见 docs/CONVENTIONS.md §4\n');
  process.exit(1);
}

console.log('✓ 选择器集中检查通过');
