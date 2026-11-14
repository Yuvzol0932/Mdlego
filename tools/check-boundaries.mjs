#!/usr/bin/env node
/**
 * 依赖单向检查。
 *
 * 用 TypeScript 编译器 API 解析真实的 import 图（不是正则猜），
 * 违规即退出码 1。
 *
 * 规则见 docs/CONVENTIONS.md §2。
 */
import ts from 'typescript';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SRC = join(ROOT, 'web', 'src');

/** 禁止规则：from 层 不得 import to 层。 */
const FORBIDDEN = [
  { from: 'core', to: ['data', 'views', 'ui', 'state'], why: 'core 必须是纯逻辑，不得依赖上层' },
  { from: 'data', to: ['views', 'ui', 'state'], why: 'data 是 IO 边界，不得依赖表现层' },
  { from: 'ui', to: ['views', 'data'], why: 'ui 不得直接读写数据或组织页面' },
];

/** 即使 import 了这些模块，也禁止使用的全局名。 */
const FORBIDDEN_GLOBALS = [
  { layer: ['views', 'ui'], names: ['indexedDB', 'localStorage', 'sessionStorage'], why: 'IO 必须经过 data/ 层' },
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** 从文件路径推断所属层，如 web/src/core/x.ts → "core"。 */
function layerOf(file) {
  const rel = relative(SRC, file).split(sep);
  return rel.length > 1 ? rel[0] : null;
}

/** 把 import 的模块说明符解析成目标层。 */
function targetLayer(spec, fromFile) {
  if (!spec.startsWith('.')) return null;
  const abs = resolve(fromFile, '..', spec);
  const rel = relative(SRC, abs).split(sep);
  return rel.length > 1 ? rel[0] : null;
}

const violations = [];
const files = walk(SRC);

for (const file of files) {
  const layer = layerOf(file);
  if (layer === null) continue;

  const source = ts.createSourceFile(
    file,
    ts.sys.readFile(file) ?? '',
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );

  const report = (node, message) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    violations.push({
      file: relative(ROOT, file),
      line: line + 1,
      message,
    });
  };

  const visit = (node) => {
    // import ... from '...'
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const to = targetLayer(spec, file);
      for (const rule of FORBIDDEN) {
        if (rule.from !== layer) continue;
        if (to !== null && rule.to.includes(to)) {
          report(node, `禁止 import "${to}" 层（${rule.why}）：${spec}`);
        }
      }
    }

    // 动态 import('...')
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) {
        const to = targetLayer(arg.text, file);
        for (const rule of FORBIDDEN) {
          if (rule.from !== layer) continue;
          if (to !== null && rule.to.includes(to)) {
            report(node, `禁止动态 import "${to}" 层（${rule.why}）：${arg.text}`);
          }
        }
      }
    }

    // 禁止的全局对象
    for (const rule of FORBIDDEN_GLOBALS) {
      if (!rule.layer.includes(layer)) continue;
      if (ts.isIdentifier(node) && rule.names.includes(node.text)) {
        // 排除属性名位置（如 obj.indexedDB）
        const parent = node.parent;
        const isPropertyName =
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node);
        if (!isPropertyName) report(node, `禁止在此层使用全局 "${node.text}"（${rule.why}）`);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
}

if (violations.length > 0) {
  console.error(`\n✗ 依赖单向检查失败：${violations.length} 处违规\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.message}\n`);
  }
  console.error('  规则见 docs/CONVENTIONS.md §2\n');
  process.exit(1);
}

console.log(`✓ 依赖单向检查通过（扫描 ${files.length} 个文件）`);
