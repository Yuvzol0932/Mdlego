/**
 * 检查更新数据层边界：串联 4 层镜像瀑布流请求与本地节流/忽略版本持久化。
 *
 * 允许碰 fetch / localStorage / native；纯解析逻辑在 core/update.ts。
 */

import {
  UPDATE_SOURCES,
  compareForUpdate,
  normalizeVersion,
  parseGitHubReleaseJson,
  parseManifestJson,
  type UpdateCheckResult,
  type UpdateSource,
} from '../core/update';
import { fetchUpdateJson, openExternalUrl } from './native';

const KEY_LAST_CHECK = 'mdlego:update-last-check';
const KEY_IGNORED_VERSION = 'mdlego:update-ignored';

export interface CheckUpdateOptions {
  readonly fetcher?: (url: string) => Promise<{ status: number; body: string } | null>;
  readonly sources?: readonly UpdateSource[];
  readonly now?: () => number;
}

export function readLastUpdateCheck(): number | null {
  try {
    const raw = localStorage.getItem(KEY_LAST_CHECK);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function writeLastUpdateCheck(at: number): void {
  try {
    if (Number.isFinite(at) && at > 0) {
      localStorage.setItem(KEY_LAST_CHECK, String(Math.floor(at)));
    }
  } catch {
    /* 存储受限时不阻断检查流程 */
  }
}

export function readIgnoredVersion(): string | null {
  try {
    const raw = localStorage.getItem(KEY_IGNORED_VERSION);
    if (raw === null) return null;
    const clean = normalizeVersion(raw);
    return clean.length > 0 ? clean : null;
  } catch {
    return null;
  }
}

export function writeIgnoredVersion(version: string): void {
  try {
    const clean = normalizeVersion(version);
    if (clean.length > 0) localStorage.setItem(KEY_IGNORED_VERSION, clean);
  } catch {
    /* 静默兜底 */
  }
}

/** 按优先级逐一请求更新源，首个可用且合法的清单即落盘检查时间并返回比对结果。 */
export async function checkForUpdate(
  currentVersion: string,
  options: CheckUpdateOptions = {},
): Promise<UpdateCheckResult> {
  const fetcher = options.fetcher ?? fetchUpdateJson;
  const sources = options.sources ?? UPDATE_SOURCES;
  const now = options.now ?? (() => Date.now());

  for (const source of sources) {
    let res: { status: number; body: string } | null = null;
    try {
      res = await fetcher(source.url);
    } catch {
      res = null;
    }
    if (res === null || res.status < 200 || res.status >= 300 || res.body.trim().length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      continue;
    }
    const manifest =
      source.kind === 'manifest'
        ? parseManifestJson(parsed, source.name)
        : parseGitHubReleaseJson(parsed, source.name);
    if (manifest === null) continue;

    writeLastUpdateCheck(now());
    return compareForUpdate(currentVersion, manifest);
  }

  return {
    status: 'error',
    message: '暂时无法连接更新源，请检查网络后重试',
  };
}

export { openExternalUrl };
