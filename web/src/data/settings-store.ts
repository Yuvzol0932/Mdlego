/**
 * 本地持久化 —— 设置与阅读偏好的存储边界。
 *
 * 这是 data 层：唯一允许碰 localStorage 的地方。
 * 上层（views / ui）拿到的永远是纯数据。
 *
 * 存储设计：
 *   - 单一 key 存整个设置对象，结构简单、迁移容易
 *   - 带 schemaVersion，未来加字段时按版本升级
 *   - 任何解析失败都回落到默认值，绝不因为坏数据导致白屏
 */

import { DEFAULT_TYPE_PREFS, normalizeTypePrefs, typePrefsFromSettings } from '../core/typography';
import type { Settings } from '../core/types';

/** 存储键。 */
const STORAGE_KEY = 'mdlego:settings';

/** 当前设置结构版本。加字段时递增，并在 migrate 中补默认值。 */
const SCHEMA_VERSION = 1;

/** 默认设置。 */
export const DEFAULT_SETTINGS: Settings = {
  theme: 'magazine',
  typeScale: DEFAULT_TYPE_PREFS.typeScale,
  lineScale: DEFAULT_TYPE_PREFS.lineScale,
  paraScale: DEFAULT_TYPE_PREFS.paraScale,
  fontFamily: DEFAULT_TYPE_PREFS.fontFamily,
  focusMode: false,
  lookupEnabled: true,
};

/** 存储信封结构。 */
interface StoredEnvelope {
  readonly schemaVersion: number;
  readonly settings: unknown;
}

/** 校验主题名。 */
function asTheme(value: unknown): Settings['theme'] {
  return value === 'night' || value === 'paper' || value === 'magazine' ? value : DEFAULT_SETTINGS.theme;
}

/**
 * 把任意 JSON 值收敛成合法 Settings。
 * 任何字段缺失或类型不对都用默认值兜底 —— 坏数据不能导致应用无法启动。
 */
export function coerceSettings(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_SETTINGS;
  const obj = raw as Record<string, unknown>;

  const prefs = normalizeTypePrefs({
    typeScale: typeof obj['typeScale'] === 'number' ? obj['typeScale'] : undefined,
    lineScale: typeof obj['lineScale'] === 'number' ? obj['lineScale'] : undefined,
    paraScale: typeof obj['paraScale'] === 'number' ? obj['paraScale'] : undefined,
    fontFamily: obj['fontFamily'] === 'sans' ? 'sans' : obj['fontFamily'] === 'serif' ? 'serif' : undefined,
  });

  return {
    theme: asTheme(obj['theme']),
    typeScale: prefs.typeScale,
    lineScale: prefs.lineScale,
    paraScale: prefs.paraScale,
    fontFamily: prefs.fontFamily,
    focusMode: obj['focusMode'] === true,
    lookupEnabled: obj['lookupEnabled'] !== false,
  };
}

/** 读取设置。任何异常都静默回落默认值。 */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SETTINGS;
    const envelope = parsed as Partial<StoredEnvelope>;
    return coerceSettings(envelope.settings);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** 保存设置。配额超限等异常被吞掉，不打断阅读。 */
export function saveSettings(settings: Settings): void {
  try {
    const envelope: StoredEnvelope = { schemaVersion: SCHEMA_VERSION, settings };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // 存储不可用时静默失败：本会话内设置仍然生效，只是下次启动回到默认
  }
}

/** 导出给测试与调试用。 */
export const __storageInternals = { STORAGE_KEY, SCHEMA_VERSION, typePrefsFromSettings };
