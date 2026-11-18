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
  /**
   * 成功时：可结构化克隆的渲染结果。
   * blockTexts 序列化成**一个 JSON 字符串**再传：真机上结构化克隆一万条数组
   * 会把主线程卡 1s+，而克隆一个字符串几乎免费，主线程按需再 JSON.parse。
   */
  readonly payload?: {
    readonly htmlChunks: readonly string[];
    readonly toc: readonly unknown[];
    readonly blockCount: number;
    readonly blockTextsJson: string;
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
        // 注意：不要在这里访问 render.html（会把剩余分片补齐并再拼一份 360KB 字符串）
        htmlChunks: [...render.htmlChunks],
        toc: [...render.toc],
        blockCount: render.blockCount,
        blockTextsJson: JSON.stringify([...render.blockTexts.entries()]),
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
