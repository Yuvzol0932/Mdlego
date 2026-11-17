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

import { normalizeQuotes } from '../core/quotes';
import { DEFAULT_TYPE_PREFS, normalizeTypePrefs, typePrefsFromSettings } from '../core/typography';
import type { Settings } from '../core/types';

/** 存储键。 */
const STORAGE_KEY = 'mdlego:settings';

/**
 * 当前设置结构版本。加字段时递增，并在 coerceSettings 中补默认值。
 * v2 → v3（阶段 C2）：新增 bannerImage（自定义横幅图 data URL）与 quotes（自定义语录）。
 * v3 → v4（阶段 C5）：新增 keepAwake（阅读时保持屏幕常亮）。
 */
const SCHEMA_VERSION = 4;

/** 自定义横幅图的上限：localStorage 总配额约 5MB，留足余量给其它键。 */
const BANNER_MAX_CHARS = 900_000;

/** 默认设置。 */
export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  accent: 'theme',
  material: 'glass',
  glassLevel: 2,
  motion: 'full',
  materialHinted: false,
  typeScale: DEFAULT_TYPE_PREFS.typeScale,
  lineScale: DEFAULT_TYPE_PREFS.lineScale,
  paraScale: DEFAULT_TYPE_PREFS.paraScale,
  fontFamily: DEFAULT_TYPE_PREFS.fontFamily,
  focusMode: false,
  lookupEnabled: true,
  bannerImage: null,
  quotes: [],
  keepAwake: false,
};

/** 存储信封结构。 */
interface StoredEnvelope {
  readonly schemaVersion: number;
  readonly settings: unknown;
}

const THEMES: readonly string[] = ['warm-night', 'warm-paper', 'forest', 'slate', 'magazine', 'night', 'paper'];
const ACCENT_SET: readonly string[] = ['amber', 'rust', 'jade', 'sky', 'rose', 'violet', 'olive', 'slate'];

/** 校验主题名。v1 存的是 magazine/night/paper，仍然合法，原样保留（旧数据可读）。 */
function asTheme(value: unknown): Settings['theme'] {
  return value === 'system' || (typeof value === 'string' && THEMES.includes(value))
    ? (value as Settings['theme'])
    : DEFAULT_SETTINGS.theme;
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
    // v1 → v2 迁移：旧设置没有新字段，全部落默认值；旧主题名保持不变（用户已选的主题不被改掉）。
    theme: asTheme(obj['theme']),
    accent:
      obj['accent'] === 'theme' || (typeof obj['accent'] === 'string' && ACCENT_SET.includes(obj['accent']))
        ? (obj['accent'] as Settings['accent'])
        : 'theme',
    material: obj['material'] === 'soft' || obj['material'] === 'solid' ? obj['material'] : 'glass',
    glassLevel:
      typeof obj['glassLevel'] === 'number' && Number.isFinite(obj['glassLevel'])
        ? Math.min(3, Math.max(1, Math.round(obj['glassLevel'])))
        : 2,
    motion: obj['motion'] === 'off' || obj['motion'] === 'simple' ? obj['motion'] : 'full',
    materialHinted: obj['materialHinted'] === true,
    typeScale: prefs.typeScale,
    lineScale: prefs.lineScale,
    paraScale: prefs.paraScale,
    fontFamily: prefs.fontFamily,
    focusMode: obj['focusMode'] === true,
    lookupEnabled: obj['lookupEnabled'] !== false,
    // v2 → v3：旧设置没有这两个字段，落默认值（内置渐变横幅 + 内置语录）
    bannerImage: asBannerImage(obj['bannerImage']),
    quotes: normalizeQuotes(obj['quotes']),
    // v3 → v4：默认不常亮（省电优先；用户主动开才常亮）
    keepAwake: obj['keepAwake'] === true,
  };
}

/** 只接受应用自己写入的图片 data URL；坏数据/超长一律回落 null（用主题渐变）。 */
function asBannerImage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('data:image/')) return null;
  if (value.length > BANNER_MAX_CHARS) return null;
  return value;
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
