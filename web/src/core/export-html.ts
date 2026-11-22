/**
 * 导出单文件 HTML（阶段 E6，纯函数）。
 *
 * 目标：把当前文档的已渲染正文包成「双击就能看」的独立 HTML ——
 * 不依赖应用、不联网、图片若是外链则原样引用（不内嵌，避免备份文件过大）。
 * 样式内嵌一份最小阅读排版；日/夜主题由导出时的当前主题决定。
 */

/** 导出样式用到的颜色（由 main 从当前主题令牌读取后传入；core 不硬编码色值）。 */
export interface ExportPalette {
  readonly ink: string;
  readonly paper: string;
  readonly soft: string;
  readonly rule: string;
  readonly accent: string;
  readonly codeBg: string;
}

/** 生成 HTML 需要的输入。 */
export interface ExportHtmlInput {
  readonly title: string;
  readonly bodyHtml: string;
  /** 当前是否深色主题。 */
  readonly dark: boolean;
  readonly palette: ExportPalette;
}

/** 转义 HTML 文本节点。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 生成完整 HTML 文档（含内嵌样式与标题）。 */
export function buildExportHtml(input: ExportHtmlInput): string {
  const { ink, paper, soft, rule, accent, codeBg } = input.palette;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>
  :root { color-scheme: ${input.dark ? 'dark' : 'light'}; }
  html { background: ${paper}; }
  body {
    margin: 0 auto; max-width: 46rem; padding: 32px 20px 64px;
    background: ${paper}; color: ${ink};
    font-family: "Noto Serif SC", "Songti SC", Georgia, serif;
    font-size: 18px; line-height: 1.85;
  }
  h1, h2, h3 { line-height: 1.35; margin: 1.6em 0 0.6em; }
  h1 { font-size: 1.9em; }
  h2 { font-size: 1.45em; }
  h3 { font-size: 1.2em; }
  p { margin: 0.9em 0; }
  a { color: ${accent}; }
  blockquote {
    margin: 1.2em 0; padding: 0.2em 1em;
    border-left: 3px solid ${accent}; color: ${soft};
  }
  pre {
    overflow-x: auto; padding: 12px 14px; border-radius: 10px;
    background: ${codeBg};
    font-size: 0.86em; line-height: 1.6;
  }
  code { font-family: "JetBrains Mono", Consolas, monospace; }
  img { max-width: 100%; height: auto; border-radius: 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 0.92em; }
  th, td { border: 1px solid ${rule}; padding: 6px 10px; text-align: left; }
  .table-box__bar, .code-copy { display: none; }
  hr { border: 0; border-top: 1px solid ${rule}; margin: 2em 0; }
  .export-meta {
    margin-top: 48px; padding-top: 12px; border-top: 1px solid ${rule};
    color: ${soft}; font-size: 12px;
    font-family: system-ui, sans-serif;
  }
</style>
</head>
<body>
<article>
${input.bodyHtml}
</article>
<p class="export-meta">由墨读导出 · ${escapeHtml(input.title)}</p>
</body>
</html>
`;
}
