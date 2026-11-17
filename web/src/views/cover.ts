/**
 * 封面与横幅的纯函数（阶段 C2）。
 *
 * 任务书明确要求「不要硬塞摄影图当默认封面」：
 * 封面用「标题哈希生成的渐变色块 + 首字大号衬线字」，同一标题始终同色。
 *
 * 这里只做映射，色值一律来自 tokens.css 的 --cover-1..8（组件按 data-cover 选择），
 * 所以换主题时封面会跟着主题走，不会在 JS 里出现硬编码颜色。
 */

/** 可用封面色板数量，与 tokens.css 的 --cover-1..8 一一对应。 */
export const COVER_COUNT = 8;

/** 标题 → 封面色板序号（1..8）。哈希保证同一标题恒定同色。 */
export function coverIndex(title: string): number {
  let hash = 0;
  for (const ch of title) {
    const code = ch.codePointAt(0) ?? 0;
    hash = (hash * 31 + code) >>> 0;
  }
  return (hash % COVER_COUNT) + 1;
}

/** 封面上的装饰首字：中文取首字，拉丁字母转大写，空标题回落「墨」。 */
export function coverInitial(title: string): string {
  const trimmed = title.trim();
  const first = trimmed.length > 0 ? ([...trimmed][0] ?? '墨') : '墨';
  return /^[a-z]$/.test(first) ? first.toUpperCase() : first;
}

/** 估读时长：中文阅读约 500 字/分钟（与旧书架卡片的估算保持一致）。 */
export function estimatedMinutes(text: string): number {
  return Math.max(1, Math.round(text.length / 500));
}

/** 相对时间：今天 / 昨天 / N 天前 / 具体日期。 */
export function relativeTime(ms: number | null): string {
  if (ms === null) return '未读';
  const diff = Date.now() - ms;
  const day = 86_400_000;
  if (diff < 0) return '刚刚';
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < day * 2) return '昨天';
  if (diff < day * 7) return `${Math.floor(diff / day)} 天前`;
  const d = new Date(ms);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}
