/**
 * 离线词库查询 —— data 层唯一的查词 IO 边界。
 *
 * 词库格式（由 tools/build-dict.mjs 生成，见 docs/M5-DICT-PLAN.md §3.1）：
 *   web/public/dict/d_<分片键>.tsv.gz  分片正文（gzip），每行 `word\tphonetic\ttranslation`
 *   web/public/dict/lemma.tsv.gz       变形词 → 原形索引（gzip）
 *
 * 为什么落盘用 gzip：22.9 MB 原文 vs 8.8 MB 压缩 —— 仓库体积按这个算。
 * 解压用浏览器内置 DecompressionStream（Chrome 80+ / Android WebView 都有），
 * 不引第三方库；读取端仍会先试 .tsv 再试 .tsv.gz，方便本地排障时直接放明文。
 *
 * 分片键 = 小写后前 2 个字符；不足 2 个字符的词归 `_` 组。
 * 分片按需加载、模块级常驻缓存：单分片桌面实测 1.1–3.5 ms，
 * 全量加载要 341 ms / 116.5 MB heap（实测否掉），所以不做全量。
 *
 * 为什么不放 views：views 不许碰 fetch；查词 IO 必须在这一层。
 * 为什么 core 里没有它：core 是纯逻辑，不许有 IO。规则还原的纯函数在 core/lemma.ts。
 */

import { lemmaCandidates } from '../core/lemma';
import type { DictEntry, LookupResult } from '../core/types';

/** 词库目录（相对应用根）。 */
const DICT_DIR = 'dict';

/** 分片文件名前缀。 */
const SHARD_PREFIX = 'd';

/** lemma 索引文件名主干（扩展名由加载器决定：.tsv / .tsv.gz）。 */
const LEMMA_STEM = 'lemma';

/** 不足 2 个字符的词所在的分片键。 */
const SHORT_WORD_SHARD = '_';

/** 一次查词的分段耗时（仅 debug 构建采集，见 docs/M5-DICT-PLAN.md §6.4）。 */
export interface DictPerfSample {
  readonly word: string;
  readonly shard: string;
  /** 冷：fetch + decode + parse。 */
  readonly cold: number;
  /** 热：纯 Map 查询。 */
  readonly hot: number;
}

declare global {
  interface Window {
    /** 仅 debug 构建存在；真机用 chrome://inspect 读取。 */
    __dictPerf?: DictPerfSample[];
  }
}

/** 分片加载器：把分片键变成解析好的词条表。测试可替换，避免依赖网络与磁盘。 */
export type ShardLoader = (shardKey: string) => Promise<Map<string, DictEntry>>;

/** lemma 索引加载器。 */
export type LemmaLoader = () => Promise<ReadonlyMap<string, string>>;

/** 归一化：小写、去掉首尾连字符与撇号（与 core/text.ts 的 wordAt 收尾规则一致）。 */
export function normalizeWord(word: string): string {
  return word
    .trim()
    .toLowerCase()
    .replace(/^[-'’]+/, '')
    .replace(/[-'’]+$/, '');
}

/** 分片键：小写后前 2 个字符；不足 2 个字符归 `_` 组。 */
export function shardKeyOf(word: string): string {
  const normalized = normalizeWord(word);
  if (normalized.length < 2) return SHORT_WORD_SHARD;
  return normalized.slice(0, 2);
}

/**
 * 解析一个分片。键为小写词形，值为词条。
 *
 * 第三列里的 `\n` 是**字面量反斜杠加 n**（与上游 ECDICT 一致），不是真换行，
 * 这里还原成真换行，卡片才能逐行显示释义。
 */
export function parseShard(text: string): Map<string, DictEntry> {
  const map = new Map<string, DictEntry>();
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    const first = line.indexOf('\t');
    if (first < 0) continue;
    const second = line.indexOf('\t', first + 1);
    if (second < 0) continue;
    const word = line.slice(0, first);
    const phonetic = line.slice(first + 1, second);
    const translation = line.slice(second + 1).replace(/\\n/g, '\n');
    if (word.length === 0) continue;
    map.set(normalizeWord(word), { word, phonetic, translation });
  }
  return map;
}

/** 解析 lemma 索引：每行 `变形词\t原形`。 */
export function parseLemma(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    const sep = line.indexOf('\t');
    if (sep < 0) continue;
    const form = line.slice(0, sep);
    const base = line.slice(sep + 1);
    if (form.length === 0 || base.length === 0) continue;
    map.set(normalizeWord(form), base);
  }
  return map;
}

/** 把相对词库路径解析成可 fetch 的地址。 */
function dictUrl(file: string): string {
  const base =
    typeof document === 'undefined' ? '/' : document.baseURI;
  return new URL(`${DICT_DIR}/${file}`, base).href;
}

/** 取一份词库文件的原始字节；404 返回 null，其它错误照常抛出。 */
async function fetchBytes(file: string): Promise<ArrayBuffer | null> {
  const response = await fetch(dictUrl(file));
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`词库文件读取失败：${file}（HTTP ${String(response.status)}）`);
  }
  return response.arrayBuffer();
}

/** gzip 解压：优先用浏览器内置 DecompressionStream。 */
async function gunzip(buffer: ArrayBuffer): Promise<string> {
  const Stream = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (Stream === undefined) {
    throw new Error('当前运行环境不支持 DecompressionStream，无法解压词库');
  }
  const stream = new Blob([buffer]).stream().pipeThrough(new Stream('gzip'));
  return new Response(stream).text();
}

/**
 * 读一份词库文本：先试未压缩的 .tsv，再试 .tsv.gz。
 *
 * 先试明文不是为了排障：**打包进 APK 后只有明文**。实测 aapt2 会把
 * assets 里的 `*.tsv.gz` 拆包（解压后改名成 `*.tsv`，再按自己默认的 deflate 级别压进 zip），
 * 所以 APK 里根本不存在 .gz 文件，WebView 读 `dict/d_pr.tsv` 拿到的是解压后的明文 TSV。
 * 而 web 构建产物（www/，浏览器里跑的）保留 .tsv.gz。两条路都要能走，所以先明文后 gzip。
 *
 * 由此带来的一个实测结论（写在这里免得下一个人再踩）：APK 增量不受仓库里是不是 gzip 影响 ——
 * 真正决定 APK 大小的是 aapt2 的 deflate 级别，实测带词库的 APK 比不带的只大 9.72 MiB。
 */
async function fetchDictText(stem: string): Promise<string> {
  const plain = await fetchBytes(`${stem}.tsv`);
  if (plain !== null) return new TextDecoder('utf-8').decode(plain);
  const gzipped = await fetchBytes(`${stem}.tsv.gz`);
  if (gzipped === null) throw new Error(`词库文件不存在：${stem}.tsv(.gz)`);
  return gunzip(gzipped);
}

const defaultShardLoader: ShardLoader = async (shardKey) =>
  parseShard(await fetchDictText(`${SHARD_PREFIX}_${shardKey}`));

const defaultLemmaLoader: LemmaLoader = async () => parseLemma(await fetchDictText(LEMMA_STEM));

/**
 * 模块级缓存。
 *
 * 存的是 Promise 而不是结果：并发长按同一个分片时只发一次请求，
 * 否则两次点击会各自 fetch 一遍（真机上就是白等一次 IO）。
 */
let shardCache = new Map<string, Promise<Map<string, DictEntry>>>();
let lemmaCache: Promise<ReadonlyMap<string, string>> | null = null;

let shardLoader: ShardLoader = defaultShardLoader;
let lemmaLoader: LemmaLoader = defaultLemmaLoader;

/** 清空缓存（测试与调试用）。 */
export function clearDictCache(): void {
  shardCache = new Map();
  lemmaCache = null;
}

/** 替换加载器（测试与调试用）。传 null 恢复默认。 */
export function setDictLoaders(next: {
  shard?: ShardLoader | null;
  lemma?: LemmaLoader | null;
}): void {
  shardLoader = next.shard ?? defaultShardLoader;
  lemmaLoader = next.lemma ?? defaultLemmaLoader;
  clearDictCache();
}

/** 取一个分片（带缓存）。 */
function ensureShard(shardKey: string): Promise<Map<string, DictEntry>> {
  const cached = shardCache.get(shardKey);
  if (cached !== undefined) return cached;
  const pending = shardLoader(shardKey);
  shardCache.set(shardKey, pending);
  // 加载失败不留毒缓存：下次长按还能重试
  pending.catch(() => {
    shardCache.delete(shardKey);
  });
  return pending;
}

/** 取 lemma 索引（带缓存）。 */
function ensureLemma(): Promise<ReadonlyMap<string, string>> {
  if (lemmaCache !== null) return lemmaCache;
  const pending = lemmaLoader();
  lemmaCache = pending;
  pending.catch(() => {
    lemmaCache = null;
  });
  return pending;
}

/** 是否采集耗时（仅 dev 构建，且必须有 window）。 */
function perfEnabled(): boolean {
  try {
    return typeof window !== 'undefined' && import.meta.env.DEV === true;
  } catch {
    return false;
  }
}

/** 记录一次采样。写失败不影响查词。 */
function recordPerf(sample: DictPerfSample): void {
  if (!perfEnabled()) return;
  try {
    const bucket = window.__dictPerf ?? [];
    bucket.push(sample);
    window.__dictPerf = bucket;
  } catch {
    // 打点失败不打断查词
  }
}

/** 在一个分片里精确取词；没有分片或没有词都返回 null。 */
async function findInShard(word: string): Promise<DictEntry | null> {
  try {
    const shard = await ensureShard(shardKeyOf(word));
    return shard.get(word) ?? null;
  } catch {
    // 词库读不出来时按「查不到」处理：宁可没反应，也不能让长按抛错崩掉阅读页
    return null;
  }
}

/**
 * 查词。优先级严格从上到下，命中即停（与 docs/M5-DICT-PLAN.md §4.2 一致）：
 *   1. 精确命中                     → matchedBy: 'exact'
 *   2. lemma 索引（变形词 → 原形）   → matchedBy: 'lemma'
 *   3. 后缀规则候选（core/lemma.ts） → matchedBy: 'lemma'
 *   4. 全部失败                     → { hit: false }
 *
 * 查不到时返回 { hit: false }：是否给用户提示由视图层决定，这一层不弹任何东西。
 */
export async function lookup(word: string): Promise<LookupResult> {
  const needle = normalizeWord(word);
  if (needle.length === 0) return { hit: false };

  const shardKey = shardKeyOf(needle);
  const coldStart = perfEnabled() ? performance.now() : 0;

  // ① 精确命中
  const exact = await findInShard(needle);
  const coldEnd = perfEnabled() ? performance.now() : 0;
  if (exact !== null) {
    // hot 段是纯 Map 查询，与 cold 分开量，才有「冷/热」两个数字
    recordPerf({ word: needle, shard: shardKey, cold: coldEnd - coldStart, hot: 0 });
    return { hit: true, entry: exact, matchedBy: 'exact' };
  }

  // ② lemma 索引
  let lemmaMap: ReadonlyMap<string, string>;
  try {
    lemmaMap = await ensureLemma();
  } catch {
    lemmaMap = new Map<string, string>();
  }
  const base = lemmaMap.get(needle);
  if (base !== undefined) {
    const entry = await findInShard(normalizeWord(base));
    if (entry !== null) {
      recordPerf({ word: needle, shard: shardKey, cold: coldEnd - coldStart, hot: 0 });
      return { hit: true, entry, matchedBy: 'lemma' };
    }
  }

  // ③ 后缀规则候选（纯函数，零 IO）
  for (const candidate of lemmaCandidates(needle)) {
    const entry = await findInShard(candidate);
    if (entry !== null) {
      recordPerf({ word: needle, shard: shardKey, cold: coldEnd - coldStart, hot: 0 });
      return { hit: true, entry, matchedBy: 'lemma' };
    }
  }

  recordPerf({ word: needle, shard: shardKey, cold: coldEnd - coldStart, hot: 0 });
  // ④ 查不到。契约就是静默返回；给不给提示是视图层的事（见方案 §4.4 的变更注记）。
  return { hit: false };
}
