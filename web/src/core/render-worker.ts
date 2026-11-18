/**
 * Markdown 渲染 Worker：把解析/渲染整篇正文的重活挪出主线程。
 *
 * 大文档（900KB / 3700+ 块）在打开瞬间同步解析会造成 >50ms 长任务，
 * 遮罩转场首帧被拖到 90ms+。Worker 里完成后传回纯数据，主线程只负责挂载首片。
 *
 * 注意：renderMarkdown 不依赖 DOM（表格包裹/围栏高亮都只在 token 层做），
 * 所以可以安全地跑在 Worker 里。
 */

import { renderMarkdown } from './markdown';

export interface WorkerRenderRequest {
  readonly id: number;
  readonly source: string;
}

export interface WorkerRenderReply {
  readonly id: number;
  readonly ok: boolean;
  /** 成功时：可结构化克隆的渲染结果（Map 已被展开成数组）。 */
  readonly payload?: {
    readonly html: string;
    readonly htmlChunks: readonly string[];
    readonly toc: readonly unknown[];
    readonly blockCount: number;
    readonly blockTexts: ReadonlyArray<readonly [string, string]>;
  };
  readonly message?: string;
}

self.addEventListener('message', (event: MessageEvent<WorkerRenderRequest>) => {
  const { id, source } = event.data;
  try {
    const render = renderMarkdown(source);
    const reply: WorkerRenderReply = {
      id,
      ok: true,
      payload: {
        html: render.html,
        htmlChunks: [...render.htmlChunks],
        toc: [...render.toc],
        blockCount: render.blockCount,
        blockTexts: [...render.blockTexts.entries()],
      },
    };
    self.postMessage(reply);
  } catch (error) {
    const reply: WorkerRenderReply = {
      id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(reply);
  }
});
