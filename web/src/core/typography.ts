/**
 * 排版设置 —— 可调字号的唯一入口。
 *
 * 设计原则（这是「改一处动十处」的防线）：
 *   HTML 上不出现任何具体数值，只出现「档位」。
 *   所有字号/行高/字体/字距的映射全部集中在 tokens.css，
 *   JS 只负责把设置翻译成 data-* 属性。
 *
 * 为什么用档位而不是直接写 px：
 *   1. 直接写 px 会让「用户偏好」与「主题默认值」互相打架 ——
 *      换主题时要不要覆盖用户字号？用档位就没有这个问题。
 *   2. 档位可以在 CSS 里对每个主题单独配一套曲线（夜间可以更松、杂志可以更大）。
 *   3. 测试可以断言「data-type-scale=3」，而不必断言某个像素值。
 */

import type { Settings } from './types';

/** 字号档位：1 最小，7 最大。3 为默认。 */
export const TYPE_SCALE_MIN = 1;
export const TYPE_SCALE_MAX = 7;
export const TYPE_SCALE_DEFAULT = 3;

/** 行高档位：1 最紧，5 最松。3 为默认。 */
export const LINE_SCALE_MIN = 1;
export const LINE_SCALE_MAX = 5;
export const LINE_SCALE_DEFAULT = 3;

/** 段落间距档位，与行高联动但可独立调。 */
export const PARA_SCALE_MIN = 1;
export const PARA_SCALE_MAX = 3;
export const PARA_SCALE_DEFAULT = 2;

/** 把任意数值夹到档位区间内并取整。 */
export function clampScale(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 一组可调排版参数。比 Settings 更底层，便于单独测试。 */
export interface TypePrefs {
  /** 字号档位 1..7 */
  readonly typeScale: number;
  /** 行高档位 1..5 */
  readonly lineScale: number;
  /** 段落间距档位 1..3 */
  readonly paraScale: number;
  /** 字体：系统黑体 / 衬线 */
  readonly fontFamily: 'sans' | 'serif';
}

/** 默认推荐值。 */
export const DEFAULT_TYPE_PREFS: TypePrefs = {
  typeScale: TYPE_SCALE_DEFAULT,
  lineScale: LINE_SCALE_DEFAULT,
  paraScale: PARA_SCALE_DEFAULT,
  fontFamily: 'serif',
};

/** 把 TypePrefs 规范化（夹紧越界值），保证任何输入都得到合法输出。 */
export function normalizeTypePrefs(prefs: Partial<TypePrefs> | null | undefined): TypePrefs {
  const p = prefs ?? {};
  return {
    typeScale: clampScale(p.typeScale ?? TYPE_SCALE_DEFAULT, TYPE_SCALE_MIN, TYPE_SCALE_MAX),
    lineScale: clampScale(p.lineScale ?? LINE_SCALE_DEFAULT, LINE_SCALE_MIN, LINE_SCALE_MAX),
    paraScale: clampScale(p.paraScale ?? PARA_SCALE_DEFAULT, PARA_SCALE_MIN, PARA_SCALE_MAX),
    fontFamily: p.fontFamily === 'sans' ? 'sans' : 'serif',
  };
}

/** 应用到一个 DOM 根节点上实际要写的属性集合。纯函数，便于测试。 */
export interface TypeAttributes {
  readonly 'data-type-scale': string;
  readonly 'data-line-scale': string;
  readonly 'data-para-scale': string;
  readonly 'data-font': string;
}

/** 把 TypePrefs 编译成根节点属性。 */
export function typeAttributes(prefs: TypePrefs): TypeAttributes {
  const n = normalizeTypePrefs(prefs);
  return {
    'data-type-scale': String(n.typeScale),
    'data-line-scale': String(n.lineScale),
    'data-para-scale': String(n.paraScale),
    'data-font': n.fontFamily,
  };
}

/** 从完整 Settings 里取出排版部分。 */
export function typePrefsFromSettings(settings: Settings): TypePrefs {
  return normalizeTypePrefs({
    typeScale: settings.typeScale,
    lineScale: settings.lineScale,
    paraScale: settings.paraScale,
    fontFamily: settings.fontFamily,
  });
}

/** 供 UI 展示的档位名称。 */
export const TYPE_SCALE_LABELS: readonly string[] = [
  '特小',
  '小',
  '标准',
  '大',
  '较大',
  '特大',
  '最大',
];

export const LINE_SCALE_LABELS: readonly string[] = ['很紧', '紧', '标准', '松', '很松'];
export const PARA_SCALE_LABELS: readonly string[] = ['紧凑', '标准', '宽松'];
