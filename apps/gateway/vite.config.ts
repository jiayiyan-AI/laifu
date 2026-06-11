// Vite lib mode 配置 — 把 gateway TS 源码 + @lingxi/* workspace 包一起打包成单个 ESM
//
// 设计:
//   - lib mode, format=es, target=node22
//   - 所有 apps/gateway/package.json 里的 dependencies 标 external (运行时 npm install
//     真装), 只把 @lingxi/* workspace 包内联——消除 workspace:* 协议、消除单独 build
//     这些包的顺序依赖。(注: @lingxi/db 依赖的 drizzle-orm/pg 仍作为 external 真装。)
//     的顺序依赖。
//   - banner 注入 createRequire 垫片, 兼容 azure SDK / supabase 偶尔在 ESM 上下文
//     用 require 的情况。
//   - 不打包 native module / 不打包 node:* 内置——platform=node 默认行为正确。
//
// 产物: dist/index.mjs (+ index.mjs.map), 配合 scripts/build-deploy.sh 拼成
// app-service-deploy/ 部署单元。
import { defineConfig, type Plugin } from 'vite';
import { builtinModules } from 'node:module';
import { readFileSync, cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8'));
// @lingxi/* workspace 包全部内联 (不进 external); 其余 deps 真装。
const runtimeDeps = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@lingxi/'));

/**
 * 把 apps/gateway/prompts/ 整体复制到 dist/prompts/。
 *
 * 为什么不通过 import: gateway 运行时按文件名读 (fs.readdir + readFile),
 * 没有静态 import 入口供 vite 跟踪;
 * 也禁止任何代码 `import x from './prompts/...md'` —— 一旦走 import,
 * 这些文件就会被当成 raw asset 进 bundle, 行为不可控。
 *
 * 为什么不放 build-deploy.sh: prompts 是 gateway 的产物组成部分, 应该由 gateway
 * 自己 build 出来; build-deploy 只负责拼装现成产物。
 */
function copyPromptsPlugin(): Plugin {
  return {
    name: 'lingxi:copy-prompts',
    apply: 'build',
    closeBundle() {
      const src = resolve(import.meta.dirname, 'prompts');
      const dst = resolve(import.meta.dirname, 'dist/prompts');
      if (existsSync(src)) {
        cpSync(src, dst, { recursive: true });
        console.log(`[copy-prompts] ${src} → ${dst}`);
      }
    },
  };
}

export default defineConfig({
  plugins: [copyPromptsPlugin()],
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
