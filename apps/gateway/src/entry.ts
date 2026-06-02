// 启动入口 — dev (tsx watch src/entry.ts) 和生产 bundle (vite 打成 dist/index.mjs)
// 都从这里进。index.ts 只导出 start, 自己不带顶层启动副作用——避免被 bundle 时
// `import.meta.url` 判定意外触发第二次 start()。
import { start } from './index.js';

start().catch((err) => {
  console.error('[gateway] startup failed:', err);
  process.exit(1);
});
