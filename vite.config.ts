/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8')) as {
  version: string;
};

// buildId is stamped once per build: git short hash + UTC timestamp.
// It is shown in-app so a human can prove which exact build is installed.
const commit = process.env.GIT_COMMIT ?? 'nogit';
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const buildId = `${commit}-${stamp}`;

export default defineConfig({
  root: resolve(here, 'web'),
  publicDir: resolve(here, 'web/public'),
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_ID__: JSON.stringify(buildId),
  },
  build: {
    outDir: resolve(here, 'www'),
    emptyOutDir: true,
    target: 'es2022',
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  test: {
    // 默认会把 .css 清空；对比度测试要读令牌文件原文
    css: { include: [/tokens.*.css/] },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
});
