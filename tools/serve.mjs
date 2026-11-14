#!/usr/bin/env node
/**
 * 极简静态服务器，供真实浏览器冒烟测试使用。
 *
 * 为什么不用 file:// —— ES module 在 file:// 下会被 CORS 策略拦截，
 * 页面会静默变空白。这是上一代项目没意识到、却让「真机验收」失真的坑之一。
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/**
 * 启动一个只读静态服务器。
 * @param {string} rootDir 根目录
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
export async function serveStatic(rootDir) {
  const root = resolve(rootDir);

  const server = createServer((req, res) => {
    const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
    let pathname;
    try {
      pathname = decodeURIComponent(rawPath);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }

    // 阻止路径穿越
    const target = normalize(join(root, pathname));
    if (!target.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    let filePath = target;
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = join(filePath, 'index.html');
    }
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`404 ${pathname}`);
      return;
    }

    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
    });
    createReadStream(filePath).pipe(res);
  });

  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((res) => server.close(() => res())),
  };
}

// 允许直接运行：node tools/serve.mjs www
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const dir = process.argv[2] ?? 'www';
  const { url } = await serveStatic(dir);
  console.log(`serving ${dir} at ${url}`);
}
