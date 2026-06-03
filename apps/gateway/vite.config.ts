// Vite lib mode 配置 — 把 gateway TS 源码 + @lingxi/shared 一起打包成单个 ESM
//
// 设计:
//   - lib mode, format=es, target=node22
//   - 所有 apps/gateway/package.json 里的 dependencies 标 external (运行时 npm install
//     真装), 只把 @lingxi/shared 内联——消除 workspace:* 协议、消除单独 build shared
//     的顺序依赖。
//   - banner 注入 createRequire 垫片, 兼容 azure SDK / supabase 偶尔在 ESM 上下文
//     用 require 的情况。
//   - 不打包 native module / 不打包 node:* 内置——platform=node 默认行为正确。
//
// 产物: dist/index.mjs (+ index.mjs.map), 配合 scripts/build-deploy.sh 拼成
// app-service-deploy/ 部署单元。
import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8'));
const runtimeDeps = Object.keys(pkg.dependencies ?? {}).filter((d) => d !== '@lingxi/shared');

export default defineConfig({
  build: {
    target: 'node22',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    ssr: true,                     // SSR 模式: 不打 polyfill, 不拷 public/, 按 node 跑
    lib: {
      entry: resolve(import.meta.dirname, 'src/entry.ts'),
      formats: ['es'],
    },
    rollupOptions: {
      external: [
        ...runtimeDeps,
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
      ],
      output: {
        entryFileNames: 'index.mjs',
        banner: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      },
    },
  },
});
