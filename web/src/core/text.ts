/**
 * 纯文本工具。零 DOM、零副作用。
 */

/** 把文本按换行切成行数组，保留空行。 */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** 折叠多余空白，用于标题比较与搜索。 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 取字符串的稳定短哈希（FNV-1a 32 位）。
 * 只用于生成块锚点 id，不用于安全用途。
 */
export function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // hash * 16777619，用移位避免 32 位溢出精度问题
    hash =
      (hash +
        (hash << 1) +
        (hash << 4) +
        (hash << 7) +
        (hash << 8) +
        (hash << 24)) >>>
      0;
  }
  return hash.toString(36);
}

/** 截断到指定长度，超出部分以省略号替代。 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max);
}

/**
 * 判断字符是否为中日韩文字或其他宽字符。
 * 用于排版判断（例如中英文混排时是否需要额外空格）。
 */
export function isWideChar(ch: string): boolean {
  const code = ch.codePointAt(0);
  if (code === undefined) return false;
  return (
    (code >= 0x2e80 && code <= 0x9fff) || // 中日韩部首、标点、假名、统一汉字
    (code >= 0xac00 && code <= 0xd7af) || // 韩文
    (code >= 0xf900 && code <= 0xfaff) || // 兼容汉字
    (code >= 0xff00 && code <= 0xff60) || // 全角
    (code >= 0x20000 && code <= 0x3ffff) // 扩展汉字
  );
}

/**
 * 判断一个字符是否可以作为英文单词的组成部分。
 * 供长按查词使用：只认 ASCII 字母、连字符与撇号。
 */
export function isWordChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  const isLower = code >= 97 && code <= 122;
  const isUpper = code >= 65 && code <= 90;
  const apostrophe = ch === "'" || ch === '’';
  const hyphen = ch === '-';
  return isLower || isUpper || apostrophe || hyphen;
}

/**
 * 从 text 的 position 处向两侧扩展，取出包含该位置的英文单词。
 * 若该位置不在单词内，返回 null（调用方据此静默不弹窗）。
 */
export function wordAt(text: string, position: number): string | null {
  if (position < 0 || position >= text.length) return null;
  if (!isWordChar(text[position] ?? '')) return null;

  let start = position;
  while (start > 0 && isWordChar(text[start - 1] ?? '')) start--;

  let end = position;
  while (end < text.length && isWordChar(text[end] ?? '')) end++;

  // 去掉首尾的连字符与撇号，避免取到 "word-" 这类残片
  let word = text.slice(start, end);
  word = word.replace(/^[-'’]+/, '').replace(/[-'’]+$/, '');
  return word.length > 0 ? word : null;
}
