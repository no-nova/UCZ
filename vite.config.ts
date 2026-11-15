import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  server: { allowedHosts: ['.e2b.app'], proxy: { '/api/bench': 'http://127.0.0.1:4174' } },
  preview: { allowedHosts: ['.e2b.app'], proxy: { '/api/bench': 'http://127.0.0.1:4174' } },
  resolve: {
    alias: [
      // 浏览器构建把 Node 专用并行池替换为空桩：否则 Rollup 会去解析
      // node:worker_threads / node:os 并因"未导出"而失败。空桩让并行恒不可用，
      // codec 自动退回串行，产物与串行逐字节一致。
      { find: /^(\.\/)?parallel-pool$/, replacement: path.resolve(__dirname, "src/lib/parallel-pool.browser.ts") },
      { find: "@", replacement: path.resolve(__dirname, "src") },
    ],
  },
  plugins: [
    react(),
    tailwindcss(),
    viteSingleFile(),
    {
      // The single-file bundle links to /LICENSE from the footer; ship the text too.
      name: 'copy-license',
      closeBundle() {
        const from = path.resolve(__dirname, 'LICENSE')
        if (!existsSync(from)) return
        const to = path.resolve(__dirname, 'dist/web')
        mkdirSync(to, { recursive: true })
        copyFileSync(from, path.join(to, 'LICENSE'))
      },
    },
  ],
  // `npm run build` writes dist/cli.js + dist/index.js; keep the Web bundle in a
  // subdirectory so a later `build:web` cannot empty the CLI/library output.
  build: { outDir: 'dist/web', emptyOutDir: true },
  // 浏览器构建里关掉并行池（浏览器没有 worker_threads）：常量分支会被摇掉，
  // 于是 node:os / node:worker_threads 不会进入浏览器包。
  define: { __UCZ_NO_WORKERS__: 'true' },
  // 内联 worker 里有动态 import（并行池的惰性加载），iife 不支持代码分割，
  // 因此显式使用 es 格式（现代浏览器均支持 module worker）。
  worker: { format: 'es' },


});
