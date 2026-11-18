/**
 * 渲染客户端：优先把 markdown 解析/渲染丢给 Worker，失败或环境不支持时退回同步渲染。
 *
 * 阅读页打开路径用 `renderMarkdownAsync`（大文档不阻塞首帧），
 * 导出/搜索等后台路径仍可直接用同步的 `renderMarkdown`。
 */

import { renderMarkdown } from './markdown';
import type { RenderResult, TocEntry } from './types';
import type { WorkerRenderReply, WorkerRenderRequest } from './render-worker';

type Pending = {
  resolve: (render: RenderResult) => void;
  reject: (error: Error) => void;
};

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map<number, Pending>();

function rehydrate(payload: NonNullable<WorkerRenderReply['payload']>): RenderResult {
  const chunks = [...payload.htmlChunks];
  let next = 1;
  let blockTexts: Map<string, string> | null = null;
  return {
    // 全量 html 只在导出/备份需要时才拼（分片已经都在）
    get html(): string {
      return chunks.join('');
    },
    get htmlChunks(): readonly string[] {
      return chunks;
    },
    firstHtmlChunk: chunks[0] ?? '',
    nextHtmlChunk: () => {
      const chunk = chunks[next];
      if (chunk === undefined) return null;
      next += 1;
      return chunk;
    },
    toc: payload.toc as TocEntry[],
    blockCount: payload.blockCount,
    // 懒解析：真机上首次访问（批注/选区）才付出解析成本，且不在转场窗口内
    get blockTexts(): ReadonlyMap<string, string> {
      if (blockTexts === null) {
        blockTexts = new Map(JSON.parse(payload.blockTextsJson) as Array<[string, string]>);
      }
      return blockTexts;
    },
  };
}

function fallback(source: string): Promise<RenderResult> {
  workerBroken = true;
  worker?.terminate();
  worker = null;
  for (const waiter of pending.values()) waiter.reject(new Error('渲染 Worker 已停用'));
  pending.clear();
  return Promise.resolve().then(() => renderMarkdown(source));
}

function ensureWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker !== null) return worker;
  if (typeof Worker === 'undefined') {
    workerBroken = true;
    return null;
  }
  try {
    worker = new Worker(new URL('./render-worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event: MessageEvent<WorkerRenderReply>) => {
      const reply = event.data;
      const waiter = pending.get(reply.id);
      if (waiter === undefined) return;
      pending.delete(reply.id);
      if (reply.ok && reply.payload !== undefined) waiter.resolve(rehydrate(reply.payload));
      else waiter.reject(new Error(reply.message ?? '渲染失败'));
    });
    worker.addEventListener('error', () => {
      // Worker 不可用（旧 WebView / 本地 file:// 限制）：停用它并让本次调用走同步
      const waiters = [...pending.values()];
      pending.clear();
      workerBroken = true;
      worker?.terminate();
      worker = null;
      for (const waiter of waiters) waiter.reject(new Error('渲染 Worker 崩溃'));
    });
    return worker;
  } catch {
    workerBroken = true;
    worker = null;
    return null;
  }
}

/** 异步渲染（Worker 优先）；调用方需自行处理「返回时已切走文档」的竞态。 */
export function renderMarkdownAsync(source: string): Promise<RenderResult> {
  const instance = ensureWorker();
  if (instance === null) return fallback(source);
  const id = nextId;
  nextId += 1;
  return new Promise<RenderResult>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const request: WorkerRenderRequest = { id, source };
    try {
      instance.postMessage(request);
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  }).catch((error: unknown) => {
    // Worker 失败：不能无限等待，退回同步渲染保证功能可用
    if (workerBroken) return renderMarkdown(source);
    throw error;
  });
}

/** 预热 Worker（导入/打开文档前调用，省掉首次 worker 启动开销）。 */
export function warmRenderWorker(): void {
  ensureWorker();
}
