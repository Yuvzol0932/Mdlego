#!/usr/bin/env node
/**
 * 离线词库构建 —— ECDICT → 分片 TSV + 词形索引。
 *
 * 数据源：https://github.com/skywind3000/ECDICT （MIT，Copyright (c) 2025 Linwei）
 * 方案与体积账见 docs/M5-DICT-PLAN.md。
 *
 * 产物（默认落 web/public/dict/，Vite publicDir 原样拷进 www/，
 * 最终进 android assets/public/dict/，前端用相对路径直接 fetch，零原生代码）：
 *   dict/d_<分片键>.tsv.gz   分片正文（gzip）：word ⇥ phonetic ⇥ translation
 *   dict/lemma.tsv.gz        词形索引（gzip）：变形词 ⇥ 原形
 *   （--format tsv 时输出未压缩的 .tsv，只在排障时用）
 *   dict/LICENSE-ECDICT.txt  MIT 许可全文（随词库一起分发）
 *
 * 用法：
 *   node tools/build-dict.mjs                  # 有缓存用缓存，没有就下载
 *   node tools/build-dict.mjs --csv <path>     # 用指定 CSV
 *   node tools/build-dict.mjs --out <dir>      # 指定输出目录
 *   node tools/build-dict.mjs --offline        # 只用缓存，禁网
 *
 * 设计取舍（都是量出来的，不是拍的）：
 *   - 只留「单个英文词 + 有中文释义」：401,614 条；词组多 366,450 行却用不上（方案 §1.4）
 *   - v1 用普通 TSV 而不是前缀增量编码：后者只省 7.2%，解析复杂度却上一个台阶（§3.1）
 *   - 分片键取小写前 2 字符，median 分片 2 KB，按需加载 1–3.5 ms（§2.4）
 *   - 产物一律 gzip：22.9 MB 原文 vs 8.8 MB 压缩。运行时用浏览器内置 DecompressionStream
 *     解压（Chrome 80+ 就有）；Capacitor 的 androidScheme 是 https、本地开发是 http://127.0.0.1，
 *     两者都是安全上下文，DecompressionStream 可用。
 *   - 词形索引只取 exchange 的 0:（「本词的 lemma 是谁」），1: 是形态码（s3/pd 之类），不是词
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_OUT = join(ROOT, 'web', 'public', 'dict');
// 缓存放系统临时目录：66 MB 的上游 CSV 不进仓库，也不需要在 .gitignore 里开洞
const CACHE_DIR = join(tmpdir(), 'mdlego-dict-cache');
const CACHE_CSV = join(CACHE_DIR, 'ecdict.csv');

const UPSTREAM_CSV = 'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv';

/**
 * 上游 ecdict.csv 的 sha256（2026-11-15 实测，本机 md5 231b274d84f74a8ceca152c574678198）。
 *
 * 上游是滚动更新的 master 分支，不钉死指纹就无法复现「401,614 条」这个验收数字。
 * 指纹对不上只警告不中断：词库仍可用，但要在报告里写明这次上游变了。
 */
const UPSTREAM_SHA256 = 'd1ecbdf9ee2b920afb6f430ca6b6bb9f559588cf0dff86e04bd255f9390843cc';

/** 分片文件名前缀与短词分片键（与 web/src/data/dict.ts 必须一致）。 */
const SHARD_PREFIX = 'd';
const SHORT_SHARD = '_';

/** 只留单个英文词（允许内部连字符与撇号），且必须有中文释义 —— 与方案 §1.4 的正则逐字一致。 */
const SINGLE_WORD = /^[A-Za-z][A-Za-z'\-]*$/;

/**
 * 归一化：与 web/src/data/dict.ts 的 normalizeWord 逐字一致。
 *
 * 上游有 `a'`、`a-` 这类首尾带标点的残片（分录残留）。它们照样进词库（方案的数字按
 * 401,614 条算），但**分片键与查词键都按归一化后的形态算**，所以不会出现
 * `d_a'.tsv.gz` 这种带引号的文件名，运行时也永远查得到它们（归一化后就是 `a`）。
 */
function normalizeWord(word) {
  return word.trim().toLowerCase().replace(/^[-'\u2019]+/, '').replace(/[-'\u2019]+$/, '');
}

/** 分片键：归一化后前 2 个字符；不足 2 个字符归 _ 组。 */
function shardKeyOf(lower) {
  const normalized = normalizeWord(lower);
  return normalized.length < 2 ? SHORT_SHARD : normalized.slice(0, 2);
}

function parseArgs(argv) {
  const options = { csv: null, out: DEFAULT_OUT, offline: false, format: 'gz' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--csv') options.csv = argv[++i];
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--offline') options.offline = true;
    else if (arg === '--format') options.format = argv[++i] === 'tsv' ? 'tsv' : 'gz';
  }
  return options;
}

function humanBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MiB';
}

/** 下载上游 CSV 到系统临时目录（不进仓库）。 */
async function downloadCsv(dest) {
  mkdirSync(CACHE_DIR, { recursive: true });
  console.log(`→ 下载 ${UPSTREAM_CSV}`);
  const response = await fetch(UPSTREAM_CSV);
  if (!response.ok || response.body === null) {
    throw new Error(`下载失败：HTTP ${String(response.status)}`);
  }
  await pipeline(response.body, createWriteStream(dest));
  console.log(`  已缓存 ${dest}（${humanBytes(statSync(dest).size)}）`);
}

/**
 * 逐行扫描 CSV，不把整张表建成数组。
 *
 * 上游 66 MB / 770,611 行；真建 770,611 个 13 元素数组会让堆飙到 GB 级，
 * 而这里每行处理完就可以丢掉，所以用回调式解析。
 * 上游只有引号包裹的单元格（释义里带逗号与换行），没有嵌套转义，状态机够用。
 */
function forEachCsvRow(text, onRow) {
  let row = [];
  let field = '';
  let inQuotes = false;
  const flushField = () => {
    row.push(field);
    field = '';
  };
  const flushRow = () => {
    flushField();
    onRow(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') flushField();
    else if (ch === '\n') flushRow();
    else if (ch !== '\r') field += ch;
  }
  if (field.length > 0 || row.length > 0) flushRow();
}

/**
 * 从 exchange 取「变形词 → 原形」。
 *
 * 只认 0:xxx —— 上游 README 里 0 是「lemma 原型」，如 insisted 的 exchange
 * 是 `0:insist/1:pd`，即 insisted 的原形是 insist。
 * 1: 后面跟的是形态码（p/d/i/3/r/t/s 的拼接），不是词，误当原形会把索引写坏。
 */
function lemmaOf(exchange) {
  if (!exchange) return null;
  for (const item of exchange.split('/')) {
    const sep = item.indexOf(':');
    if (sep < 0) continue;
    if (item.slice(0, sep).trim() !== '0') continue;
    const base = item.slice(sep + 1).trim().toLowerCase();
    if (base.length > 0) return base;
  }
  return null;
}

/** 把 MIT 许可全文随词库一起放进产物目录。 */
function copyLicense(outDir) {
  const src = join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'dict', 'LICENSE-ECDICT.txt');
  if (!existsSync(src)) {
    console.warn('  ⚠ 未找到 android/app/src/main/assets/dict/LICENSE-ECDICT.txt，跳过许可证复制');
    return;
  }
  const dest = join(outDir, 'LICENSE-ECDICT.txt');
  writeFileSync(dest, readFileSync(src));
  console.log('  许可证    → ' + dest);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  let csvPath = options.csv;
  if (csvPath === null) {
    if (!existsSync(CACHE_CSV)) {
      if (options.offline) throw new Error(`离线模式但缓存不存在：${CACHE_CSV}`);
      await downloadCsv(CACHE_CSV);
    }
    csvPath = CACHE_CSV;
  }
  if (!existsSync(csvPath)) throw new Error(`找不到 CSV：${csvPath}`);

  const buffer = readFileSync(csvPath);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const text = buffer.toString('utf8');
  console.log(`→ 输入 ${csvPath}`);
  console.log(`  ${humanBytes(buffer.length)}，sha256 ${sha256.slice(0, 16)}…`);
  if (options.csv === null && sha256 !== UPSTREAM_SHA256) {
    console.warn('  ⚠ 上游 CSV 指纹与脚本记录不一致：词条数可能不再是 401,614');
  }

  // ── 裁剪：单英文词 + 有中文释义，按小写词去重 ──
  const entries = new Map(); // 查词键（小写、归一化后去重前的原小写） → { word, phonetic, translation }
  const lemmaPairs = new Map(); // 变形词 → 原形
  let kept = 0;
  let droppedNoTranslation = 0;
  let droppedNotSingleWord = 0;
  let cols = null;

  forEachCsvRow(text, (row) => {
    if (cols === null) {
      const iWord = row.indexOf('word');
      const iPhonetic = row.indexOf('phonetic');
      const iTranslation = row.indexOf('translation');
      const iExchange = row.indexOf('exchange');
      if (iWord < 0 || iPhonetic < 0 || iTranslation < 0 || iExchange < 0) {
        throw new Error('CSV 表头不符合预期（缺 word/phonetic/translation/exchange）');
      }
      cols = { iWord, iPhonetic, iTranslation, iExchange };
      return;
    }

    const word = (row[cols.iWord] ?? '').trim();
    if (word.length === 0) return;
    const translation = (row[cols.iTranslation] ?? '').trim();
    if (translation.length === 0) {
      droppedNoTranslation++;
      return;
    }
    if (!SINGLE_WORD.test(word)) {
      droppedNotSingleWord++;
      return;
    }
    const lower = word.toLowerCase();
    const key = normalizeWord(word);
    if (key.length === 0 || entries.has(key)) return;
    entries.set(key, {
      word,
      phonetic: (row[cols.iPhonetic] ?? '').trim(),
      translation,
    });
    kept++;

    const base = lemmaOf(row[cols.iExchange] ?? '');
    if (base !== null && base !== key && !lemmaPairs.has(key)) lemmaPairs.set(key, normalizeWord(base));
  });

  console.log(
    `  保留 ${kept} 条单英文词；丢弃词组/非单词 ${droppedNotSingleWord} 行、无释义 ${droppedNoTranslation} 行`,
  );
  console.log(`  词形索引 ${lemmaPairs.size} 对`);

  // ── 分片 ──
  const EXT = options.format === 'tsv' ? 'tsv' : 'tsv.gz';
  const encodeBody = (body) =>
    options.format === 'tsv'
      ? Buffer.from(body, 'utf8')
      : gzipSync(Buffer.from(body, 'utf8'), { level: 9 });
  if (existsSync(options.out)) rmSync(options.out, { recursive: true, force: true });
  mkdirSync(options.out, { recursive: true });

  const shards = new Map();
  for (const [entryKey, entry] of entries) {
    const shard = shardKeyOf(entryKey);
    const bucket = shards.get(shard);
    if (bucket === undefined) shards.set(shard, [entry]);
    else bucket.push(entry);
  }

  let totalBytes = 0;
  const sizes = [];
  for (const key of [...shards.keys()].sort()) {
    const bucket = shards.get(key) ?? [];
    // 文件内按小写词排序：将来做前缀补全/二分查找不用重排
    bucket.sort((a, b) => (a.word.toLowerCase() < b.word.toLowerCase() ? -1 : 1));
    const body = bucket.map((e) => `${e.word}\t${e.phonetic}\t${e.translation}`).join('\n') + '\n';
    writeFileSync(join(options.out, `${SHARD_PREFIX}_${key}.${EXT}`), encodeBody(body));
    const bytes = Buffer.byteLength(body, 'utf8');
    totalBytes += bytes;
    sizes.push(bytes);
  }

  const lemmaText =
    [...lemmaPairs.keys()].sort().map((form) => `${form}\t${lemmaPairs.get(form)}`).join('\n') + '\n';
  writeFileSync(join(options.out, `lemma.${EXT}`), encodeBody(lemmaText));
  const lemmaBytes = Buffer.byteLength(lemmaText, 'utf8');

  copyLicense(options.out);

  sizes.sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)] ?? 0;
  const total = totalBytes + lemmaBytes;

  console.log(`\n✓ 词库已生成：${shards.size} 个分片 + 1 个词形索引`);
  console.log(`  分片正文  ${humanBytes(totalBytes)}`);
  console.log(`  词形索引  ${humanBytes(lemmaBytes)}`);
  console.log(`  合计      ${humanBytes(total)}（未压缩）`);
  let diskBytes = 0;
  for (const name of readdirSync(options.out)) diskBytes += statSync(join(options.out, name)).size;
  console.log(`  落盘      ${humanBytes(diskBytes)}（${EXT}，含许可全文）`);
  console.log(
    `  分片体积  min ${humanBytes(sizes[0] ?? 0)} / median ${humanBytes(median)} / max ${humanBytes(sizes[sizes.length - 1] ?? 0)}`,
  );
  console.log(`  → ${options.out}`);
}

main().catch((error) => {
  console.error('\n✗ 词库构建失败：' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
