#!/usr/bin/env node
// Bootstrap 入口: 编排所有启动任务。
//
// 执行图:
//   refresh-token                        (串行第一步, 后续都要带最新 token)
//        │
//        ▼
//   ┌─ fetchRuntimeConfig ──────┐       并行
//   │                           │
//   └─ sync-entitlements ───────┘
//        │
//        ▼  (拿到 runtime-config 含 prompts_manifest 后)
//   sync-prompts (内部并行下载变化的 .md)
//        │
//        ▼
//   render config.yaml (此时 system-prompt.md 已落地)
//
// 任何一步失败都不致命 — 打日志继续, 让 hermes server 仍能起来 (用兜底配置),
// 避免 bootstrap 异常 → 容器永远起不来 → 用户彻底用不了。
// 最外层 try/catch 兜底未捕获的顶层 await reject (Node 18+ 默认会 exit 1)。
import { runRefreshToken } from './refresh-token.mjs';
import { fetchRuntimeConfig, renderConfigYaml } from './pull-runtime-config.mjs';
import { runSyncEntitlements } from './sync-entitlements.mjs';
import { syncPrompts } from './sync-prompts.mjs';
import { log, warn, envOrDie } from './lib.mjs';

async function safe(name, fn) {
  try {
    return await fn();
  } catch (e) {
    warn(`${name} threw: ${e?.message ?? e}`);
    return null;
  }
}

async function main() {
  envOrDie('GATEWAY_BASE_URL');
  const t0 = Date.now();

  // Step 1: 续签 token (后续步骤要读最新 token 文件)
  await safe('refresh-token', runRefreshToken);

  // Step 2: 并行拉 runtime-config + sync entitlements
  const [cfg] = await Promise.all([
    safe('fetch-runtime-config', fetchRuntimeConfig),
    safe('sync-entitlements', runSyncEntitlements),
  ]);

  // Step 3: 按 manifest 同步 prompt 文件 (sync-prompts 内部并行下载)
  //   - cfg 拉不到 → 跳过同步, 沿用本地已有的 prompt 文件 (老配置可用)
  //   - cfg 拉到但 manifest 是空 → 视为远端清空, 会删本地所有跟踪文件
  if (cfg) {
    await safe('sync-prompts', () => syncPrompts(cfg.prompts_manifest));
  }

  // Step 4: 渲染 config.yaml (在 sync-prompts 之后)
  await safe('render-config', () => renderConfigYaml(cfg));

  log(`bootstrap done in ${Date.now() - t0}ms`);
}

try {
  await main();
} catch (e) {
  // 真到这里说明 safe() 之外某处直接 throw, 也不能让 entrypoint 退出。
  warn(`bootstrap fatal: ${e?.message ?? e}`);
  process.exit(0);
}
