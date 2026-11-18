/**
 * 诊断日志（F3 错误边界）。
 *
 * 目标：任何未捕获错误都留下可导出的证据，而不是只有控制台。
 *  - 全局 error / unhandledrejection / console.error 记录进环形缓冲（最多 100 条）；
 *  - 同步持久化到 localStorage，崩溃重开也能导出；
 *  - 不采集正文内容，只存消息、来源、栈、页面标识与少量上下文。
 */

const STORAGE_KEY = 'mdlego.diagnostics.v1';
const MAX_ENTRIES = 100;
const MAX_TEXT = 500;

export type DiagnosticKind = 'error' | 'rejection' | 'render' | 'console';

export interface DiagEntry {
  /** ISO 时间。 */
  readonly at: string;
  readonly kind: DiagnosticKind;
  readonly message: string;
  readonly stack?: string;
  /** 出错脚本/页面标识。 */
  readonly source?: string;
  readonly line?: number;
  readonly column?: number;
  /** 追加的少量上下文（不放大段文本）。 */
  readonly extra?: Readonly<Record<string, string | number | boolean>>;
}

let entries: DiagEntry[] = [];
let installed = false;
let onRecord: ((entry: DiagEntry) => void) | null = null;

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_TEXT ? `${oneLine.slice(0, MAX_TEXT)}…` : oneLine;
}

function load(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    entries = parsed
      .filter((item): item is DiagEntry => typeof item === 'object' && item !== null && typeof (item as DiagEntry).message === 'string')
      .slice(-MAX_ENTRIES);
  } catch {
    // 存储损坏不影响启动：丢掉坏数据从头记
    entries = [];
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // 隐私模式/配额满：内存里还有，导出仍可用
  }
}

/** 追加一条诊断记录（会持久化并触发提示回调）。 */
export function recordDiagnostic(entry: Omit<DiagEntry, 'at'> & { readonly at?: string }): DiagEntry {
  const full: DiagEntry = {
    at: entry.at ?? new Date().toISOString(),
    kind: entry.kind,
    message: clip(entry.message),
    ...(entry.stack === undefined ? {} : { stack: clip(entry.stack) }),
    ...(entry.source === undefined ? {} : { source: clip(entry.source) }),
    ...(entry.line === undefined ? {} : { line: entry.line }),
    ...(entry.column === undefined ? {} : { column: entry.column }),
    ...(entry.extra === undefined ? {} : { extra: entry.extra }),
  };
  entries = [...entries.slice(-(MAX_ENTRIES - 1)), full];
  persist();
  try {
    onRecord?.(full);
  } catch {
    // 提示回调本身出错不能影响记录
  }
  return full;
}

/** 安装全局监听（幂等）。 */
export function installDiagnostics(options: { readonly onRecord?: (entry: DiagEntry) => void } = {}): void {
  if (typeof window === 'undefined' || installed) return;
  installed = true;
  onRecord = options.onRecord ?? null;
  load();

  window.addEventListener(
    'error',
    (event) => {
      const target = event.target;
      if (target instanceof Element && target !== document.documentElement) {
        // 资源加载错误（img/script/link）：没有 ErrorEvent 字段，记资源地址
        const url = target.getAttribute('src') ?? target.getAttribute('href') ?? target.tagName;
        recordDiagnostic({ kind: 'error', message: `资源加载失败：${url}`, source: 'resource' });
        return;
      }
      const errorEvent = event as ErrorEvent;
      recordDiagnostic({
        kind: 'error',
        message: errorEvent.message || '未知脚本错误',
        ...(errorEvent.error instanceof Error && errorEvent.error.stack !== undefined
          ? { stack: errorEvent.error.stack }
          : {}),
        ...(errorEvent.filename === undefined ? {} : { source: errorEvent.filename }),
        ...(typeof errorEvent.lineno === 'number' ? { line: errorEvent.lineno } : {}),
        ...(typeof errorEvent.colno === 'number' ? { column: errorEvent.colno } : {}),
      });
    },
    true,
  );

  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    recordDiagnostic({
      kind: 'rejection',
      message: `未处理的 Promise 拒绝：${message}`,
      ...(stack === undefined ? {} : { stack }),
    });
  });

  // console.error 也留痕：很多兜底分支只打日志，不抛异常
  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]): void => {
    recordDiagnostic({
      kind: 'console',
      message: args
        .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : typeof arg === 'string' ? arg : JSON.stringify(arg)))
        .join(' '),
    });
    originalError(...args);
  };
}

/** 读取当前日志（复制，不改内部数组）。 */
export function readDiagnostics(): readonly DiagEntry[] {
  return entries.slice();
}

/** 清空日志（设置页按钮用）。 */
export function clearDiagnostics(): void {
  entries = [];
  persist();
}

export interface DiagnosticsReport {
  readonly appVersion: string;
  readonly buildId: string;
  readonly generatedAt: string;
  readonly userAgent: string;
  readonly language: string;
  readonly platform: string;
  readonly viewport: string;
  readonly dpr: number;
  readonly state: Readonly<Record<string, unknown>>;
  readonly errors: readonly DiagEntry[];
}

/** 生成可导出的诊断 JSON（版本、环境、状态摘要、错误列表）。 */
export function buildDiagnosticsReport(base: {
  readonly appVersion: string;
  readonly buildId: string;
  readonly state: Readonly<Record<string, unknown>>;
}): DiagnosticsReport {
  return {
    appVersion: base.appVersion,
    buildId: base.buildId,
    generatedAt: new Date().toISOString(),
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    language: typeof navigator === 'undefined' ? '' : navigator.language,
    platform: typeof navigator === 'undefined' ? '' : navigator.platform,
    viewport: typeof window === 'undefined' ? '' : `${window.innerWidth}×${window.innerHeight}`,
    dpr: typeof window === 'undefined' ? 1 : window.devicePixelRatio,
    state: base.state,
    errors: readDiagnostics(),
  };
}

/** 测试/诊断用：当前条数。 */
export function diagnosticsCount(): number {
  return entries.length;
}

export const DIAGNOSTICS_STORAGE_KEY = STORAGE_KEY;
