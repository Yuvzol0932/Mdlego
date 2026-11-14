#!/usr/bin/env node
/**
 * 状态可变性检查。
 *
 * 视图层与 UI 层不得直接给 state 字段赋值，所有变更必须走 dispatch(action)。
 *
 * 规则见 docs/CONVENTIONS.md §3。
 */
import ts from 'typescript';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'web', 'src');

/** 受管层的目录名。这些目录里的代码不得直接改 state。 */
const GUARDED_LAYERS = new Set(['views', 'ui']);

/** state 变量名约定。 */
const STATE_NAMES = new Set(['state', 'S', 'appState']);

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
  if (layer === null || !GUARDED_LAYERS.has(layer)) continue;

  const source = ts.createSourceFile(
    file,
    ts.sys.readFile(file) ?? '',
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );

  const visit = (node) => {
    // state.foo = ...  /  state.foo.bar = ...
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const isAssign =
        op === ts.SyntaxKind.EqualsToken ||
        (op >= ts.SyntaxKind.PlusEqualsToken && op <= ts.SyntaxKind.BarBarEqualsToken);
      if (isAssign) {
        const root = leftmostIdentifier(node.left);
        if (root !== null && STATE_NAMES.has(root.text)) {
          violations.push({
            file: relative(ROOT, file),
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            message: `禁止直接赋值 "${root.text}.…"；请 dispatch(action)`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
}

/** 取出赋值目标最左端的标识符。 */
function leftmostIdentifier(node) {
  if (ts.isIdentifier(node)) return node;
  if (ts.isPropertyAccessExpression(node)) return leftmostIdentifier(node.expression);
  if (ts.isElementAccessExpression(node)) return leftmostIdentifier(node.expression);
  return null;
}

if (violations.length > 0) {
  console.error(`\n✗ 状态可变性检查失败：${violations.length} 处违规\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.message}\n`);
  }
  console.error('  规则见 docs/CONVENTIONS.md §3\n');
  process.exit(1);
}

console.log('✓ 状态可变性检查通过');
