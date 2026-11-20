/**
 * 应用内检查更新纯逻辑（方案 A1）。
 *
 * 严格保持纯函数：不碰 fetch / localStorage / DOM / 原生接口，
 * 版本比较规则与 android/app/build.gradle 的 appVersionCode 完全一致：
 *   versionCode = major * 1_000_000 + minor * 10_000 + patch * 100 + stage
 *   正式版 stage = 99，-rc.N 为 50 + Math.min(49, N)。
 */

export const UPDATE_REPO = 'Yuvzol0932/Mdlego';
export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_MIRROR_PREFIXES: readonly {
  readonly prefix: string;
  readonly label: string;
  readonly hint: string;
}[] = [
  { prefix: 'https://gh-proxy.com/', label: '国内高速线路 1（推荐）', hint: 'gh-proxy 加速' },
  { prefix: 'https://ghfast.top/', label: '国内高速线路 2', hint: 'ghfast 加速' },
];

export interface UpdateSource {
  readonly kind: 'manifest' | 'github-release';
  readonly name: string;
  readonly url: string;
}

/** 4 层瀑布流检查源：国内直连代理 → jsDelivr CDN → 备用代理 → GitHub 官方 API。 */
export const UPDATE_SOURCES: readonly UpdateSource[] = [
  {
    kind: 'manifest',
    name: 'gh-proxy',
    url: `https://gh-proxy.com/https://raw.githubusercontent.com/${UPDATE_REPO}/main/latest.json`,
  },
  {
    kind: 'manifest',
    name: 'jsdelivr',
    url: `https://fastly.jsdelivr.net/gh/${UPDATE_REPO}@main/latest.json`,
  },
  {
    kind: 'manifest',
    name: 'ghfast',
    url: `https://ghfast.top/https://raw.githubusercontent.com/${UPDATE_REPO}/main/latest.json`,
  },
  {
    kind: 'github-release',
    name: 'github-api',
    url: `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`,
  },
];

export interface UpdateDownloadOption {
  readonly label: string;
  readonly hint?: string;
  readonly url: string;
}

export interface UpdateManifest {
  readonly version: string;
  readonly versionCode: number;
  readonly releasedAt: string | null;
  readonly notes: readonly string[];
  readonly downloads: readonly UpdateDownloadOption[];
  readonly releasePageUrl: string;
  readonly source: string;
}

export type UpdateCheckResult =
  | { readonly status: 'available'; readonly manifest: UpdateManifest }
  | { readonly status: 'latest'; readonly currentVersion: string }
  | { readonly status: 'error'; readonly message: string };

/** 去掉前后空白与前导 v/V。 */
export function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v/i, '');
}

/**
 * 把语义版本号换算成与 Android Gradle 一致的整数 versionCode。
 * 支持 `X.Y.Z` 与 `X.Y.Z-rc.N`；非法格式返回 null。
 */
export function parseVersionCode(version: string): number | null {
  const clean = normalizeVersion(version);
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(clean);
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  const stage = match[4] !== undefined ? 50 + Math.min(49, Number(match[4])) : 99;
  return major * 1_000_000 + minor * 10_000 + patch * 100 + stage;
}

/** 只接受非空、无控制字符/空白的 HTTPS URL，防止 javascript:/http:/intent: 注入。 */
export function isSafeHttpsUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  if (raw.length === 0 || /[\s\x00-\x1f\x7f]/.test(raw)) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 根据直连 APK 下载地址组装国内镜像线路 + GitHub 官方直连。 */
export function buildMirrorDownloads(apkUrl: string): UpdateDownloadOption[] {
  if (!isSafeHttpsUrl(apkUrl)) return [];
  const options: UpdateDownloadOption[] = DEFAULT_MIRROR_PREFIXES.map((mirror) => ({
    label: mirror.label,
    hint: mirror.hint,
    url: `${mirror.prefix}${apkUrl}`,
  }));
  options.push({
    label: 'GitHub 官方直连',
    hint: '海外 / 代理环境',
    url: apkUrl,
  });
  return options;
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function sanitizeNotes(raw: unknown, maxLines = 8): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const clean = entry.trim().slice(0, 160);
    if (clean.length === 0) continue;
    out.push(clean);
    if (out.length >= maxLines) break;
  }
  return out;
}

function sanitizeDownloads(raw: unknown): UpdateDownloadOption[] {
  if (!Array.isArray(raw)) return [];
  const out: UpdateDownloadOption[] = [];
  for (const item of raw) {
    const obj = asRecord(item);
    if (obj === null) continue;
    const rawLabel = obj['label'];
    const rawUrl = obj['url'];
    if (typeof rawLabel !== 'string' || !isSafeHttpsUrl(rawUrl)) continue;
    const label = rawLabel.trim().slice(0, 48);
    if (label.length === 0) continue;
    const rawHint = obj['hint'];
    const hint = typeof rawHint === 'string' && rawHint.trim().length > 0
      ? rawHint.trim().slice(0, 48)
      : undefined;
    out.push(hint === undefined ? { label, url: rawUrl } : { label, hint, url: rawUrl });
    if (out.length >= 4) break;
  }
  return out;
}

/** 解析仓库内托管的 latest.json。格式不合规返回 null。 */
export function parseManifestJson(raw: unknown, source: string): UpdateManifest | null {
  const obj = asRecord(raw);
  if (obj === null || typeof obj['version'] !== 'string') return null;

  const version = normalizeVersion(obj['version']);
  const parsedCode = parseVersionCode(version);
  if (parsedCode === null) return null;

  const rawCode = obj['versionCode'];
  const versionCode =
    typeof rawCode === 'number' && Number.isInteger(rawCode) && rawCode > 0
      ? Math.max(parsedCode, rawCode)
      : parsedCode;

  const rawDate = obj['releasedAt'];
  const releasedAt =
    typeof rawDate === 'string' && rawDate.trim().length > 0
      ? rawDate.trim().slice(0, 24)
      : null;

  const notes = sanitizeNotes(obj['notes'], 8);

  let downloads = sanitizeDownloads(obj['downloads']);
  if (downloads.length === 0 && isSafeHttpsUrl(obj['apkUrl'])) {
    downloads = buildMirrorDownloads(obj['apkUrl']);
  }

  const hasExplicitPage = isSafeHttpsUrl(obj['releasePageUrl']);
  const releasePageUrl = hasExplicitPage
    ? (obj['releasePageUrl'] as string)
    : `https://github.com/${UPDATE_REPO}/releases/tag/v${version}`;

  if (downloads.length === 0 && !hasExplicitPage) return null;

  return {
    version,
    versionCode,
    releasedAt,
    notes,
    downloads,
    releasePageUrl,
    source,
  };
}

function cleanReleaseBody(body: string): string[] {
  const out: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line.length === 0) continue;
    line = line
      .replace(/^#{1,6}\s*/, '')
      .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .trim();
    if (line.length === 0) continue;
    if (/^(更新内容|更新日志|changelog|what'?s changed|full changelog)[:：]?$/i.test(line)) {
      continue;
    }
    out.push(line.slice(0, 160));
    if (out.length >= 6) break;
  }
  return out;
}

/** 兜底解析 GitHub Releases Latest API 响应（过滤草稿与预发布）。 */
export function parseGitHubReleaseJson(raw: unknown, source: string): UpdateManifest | null {
  const obj = asRecord(raw);
  if (obj === null) return null;
  if (obj['draft'] === true || obj['prerelease'] === true) return null;
  if (typeof obj['tag_name'] !== 'string') return null;

  const version = normalizeVersion(obj['tag_name']);
  const versionCode = parseVersionCode(version);
  if (versionCode === null) return null;

  let releasedAt: string | null = null;
  if (typeof obj['published_at'] === 'string') {
    const dateMatch = /^(\d{4}-\d{2}-\d{2})/.exec(obj['published_at'].trim());
    releasedAt = dateMatch !== null ? (dateMatch[1] ?? null) : null;
  }

  const notes = typeof obj['body'] === 'string' ? cleanReleaseBody(obj['body']) : [];

  let apkUrl: string | null = null;
  const assets = obj['assets'];
  if (Array.isArray(assets)) {
    for (const asset of assets) {
      const rec = asRecord(asset);
      if (rec === null) continue;
      const name = rec['name'];
      const dl = rec['browser_download_url'];
      if (typeof name === 'string' && name.toLowerCase().endsWith('.apk') && isSafeHttpsUrl(dl)) {
        apkUrl = dl;
        break;
      }
    }
  }

  const downloads = apkUrl !== null ? buildMirrorDownloads(apkUrl) : [];
  const hasExplicitPage = isSafeHttpsUrl(obj['html_url']);
  const releasePageUrl = hasExplicitPage
    ? (obj['html_url'] as string)
    : `https://github.com/${UPDATE_REPO}/releases/tag/v${version}`;

  if (downloads.length === 0 && !hasExplicitPage) return null;

  return {
    version,
    versionCode,
    releasedAt,
    notes,
    downloads,
    releasePageUrl,
    source,
  };
}

/** 比对当前版本与远端清单：仅严格高于当前 versionCode 才提示可用更新。 */
export function compareForUpdate(currentVersion: string, manifest: UpdateManifest): UpdateCheckResult {
  const currentCode = parseVersionCode(currentVersion);
  if (currentCode !== null && manifest.versionCode > currentCode) {
    return { status: 'available', manifest };
  }
  return { status: 'latest', currentVersion: normalizeVersion(currentVersion) };
}

/** 是否已到达下一次自动检查更新间隔（24 小时）。 */
export function shouldAutoCheck(lastCheckedAt: number | null, now: number): boolean {
  if (lastCheckedAt === null || !Number.isFinite(lastCheckedAt)) return true;
  if (now < lastCheckedAt) return true;
  return now - lastCheckedAt >= AUTO_CHECK_INTERVAL_MS;
}
