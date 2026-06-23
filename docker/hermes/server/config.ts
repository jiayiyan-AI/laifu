// config.ts — 全部 env 常量 + 启动时一次性读取的派生值
//
// 设计:模块加载时即 freeze, 调用方按需 import 字段。无 setter, 无 mutable state。
// LAIFU_USER_TOKEN 读取走 fallback (env → ~/.hermes/.laifu_user_token 文件),
// 跟 docker/hermes/scripts/lib.ts:readToken 行为一致。

import { readFileSync } from 'node:fs';

export const HERMES_BIN: string = process.env.HERMES_BIN ?? 'hermes';

// 4h 硬上限: 不是「正常 LLM 调用上限」, 而是「server 主进程心跳跟 hermes 子进程
// 解耦, hermes 真 wedge (LLM SDK deadlock 等) 时 gateway 看不到 fault, loop 永远
// 不收尾」的兜底; 实际 AI 长任务 (~小时) 跑不到。HERMES_TIMEOUT env 可覆盖, 单位秒。
export const HERMES_TIMEOUT_MS: number = parseInt(process.env.HERMES_TIMEOUT ?? '14400', 10) * 1000;

export const HERMES_PROVIDER: string = process.env.HERMES_PROVIDER ?? 'unknown';
export const DEFAULT_SESSION: string = process.env.HERMES_DEFAULT_SESSION ?? 'main';
export const DEFAULT_SOURCE: string = process.env.HERMES_DEFAULT_SOURCE ?? 'web';
export const PORT: number = parseInt(process.env.PORT ?? '8080', 10);

export const GATEWAY_BASE_URL: string = process.env.GATEWAY_BASE_URL ?? '';

// 该容器归属的用户 id (gateway azure.ts buildSpec 以 env 注入)。结构化日志的
// user_id 基础字段; dev / 未注入时为空, logger 会省略该字段。
export const USER_ID: string = (process.env.USER_ID ?? '').trim();

// 容器侧 Bearer 验签密钥 (gateway buildSpec 以 KV reference 注入)。
// 空 = dev / 未注入 → http.ts requireBearer 放行 (见 auth.ts)。
export const GATEWAY_SECRET: string = (process.env.GATEWAY_SECRET ?? '').trim();

// 微信附件缓存 TTL (天)。entrypoint sweep + /inbox 落盘后 best-effort sweep 共用。
export const INBOX_CACHE_TTL_DAYS: number = parseInt(process.env.INBOX_CACHE_TTL_DAYS ?? '7', 10);

const HOME_DIR = process.env.HOME ?? '/home/hermes';
export const SESSION_MAP_FILE = `${HOME_DIR}/.hermes/_gateway_session_map.json`;
export const STATE_DB_PATH = `${HOME_DIR}/.hermes/state.db`;
export const DYN_SYSTEM_PROMPT_FILE = `${HOME_DIR}/dynamic_prompts/system-prompt.md`;
// 入站附件 (微信图片等) 落在 laifu-inbox/ —— 我们独占的子目录, 故意**不**复用 hermes
// 自己的 cache/images (那里 vision 工具会丢下载图/生成图, 共享会被 TTL sweep 误杀)。
// sweep 只扫 laifu-inbox/ 子树, 绝不碰 cache 其余部分。P2 的 file/voice/video 同级铺开。
export const INBOX_ROOT_DIR = `${HOME_DIR}/.hermes/cache/laifu-inbox`;
export const IMAGE_CACHE_DIR = `${INBOX_ROOT_DIR}/images`;
const TOKEN_FILE = `${HOME_DIR}/.hermes/.laifu_user_token`;

export const CALLBACK_MAX_RETRIES = 3;
export const HEARTBEAT_INTERVAL_MS = 120_000;
export const KILL_GRACE_MS = 3_000;

// sessions 表里需要 snapshot 的 token 计数列, 跟 hermes_state.py CREATE TABLE sessions 一致
export const TOKEN_COLS = [
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
] as const;
export type TokenCol = typeof TOKEN_COLS[number];

// 先 env, 再 fallback 文件 (跟 bootstrap.ts readToken 一致)
function readLaifuToken(): string {
  const fromEnv = (process.env.LAIFU_USER_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}
export const LAIFU_USER_TOKEN: string = readLaifuToken();
