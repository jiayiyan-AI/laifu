// 拉 /api/me/runtime-config, **partial merge** 到 ~/.hermes/config.yaml。
//
// 拆成两个 export:
//   fetchRuntimeConfig()  — 拉 HTTP, 返回 cfg 对象 (含 prompts_manifest)
//                            bootstrap 拿到后驱动 sync-prompts 并行下载
//   renderConfigYaml(cfg) — 读旧 config.yaml, 只覆盖我们管的字段, 写回
//                           (保留 hermes seed / 用户手动加的其他字段不动)
//
// 拉不到时 fallback: 旧 config.yaml 原样保留, 容器仍能跑老配置。
//
// system-prompt.md 暂时不嵌进 config.yaml (hermes 是否支持 system_message 待验证);
// 留在 ~/dynamic_prompts/system-prompt.md 等后续做法定下来再接。
//
// YAML 解析/序列化走 Bun 内置 (YAML.parse / YAML.stringify), 从 1.2.22 起一等公民,
// 无需 yaml@2 三方包 — Dockerfile 的 npm install yaml@2 已删。
import { existsSync } from 'node:fs';
import { YAML } from 'bun';
import type { RemoteManifest } from './sync-prompts.ts';
import { log, warn, readToken, httpJson, HOME_DIR } from './lib.ts';

const CFG = `${HOME_DIR}/.hermes/config.yaml`;

// Hermes 一等公民 provider → 对应的 env var 名
const PROVIDER_KEY_MAP: Record<string, string> = {
  alibaba: 'DASHSCOPE_API_KEY',
  'alibaba-coding-plan': 'DASHSCOPE_API_KEY',
  alibaba_coding: 'DASHSCOPE_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  xai: 'XAI_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  novita: 'NOVITA_API_KEY',
  huggingface: 'HF_TOKEN',
  gmi: 'GMI_API_KEY',
  stepfun: 'STEPFUN_API_KEY',
};
function providerKeyName(provider: string): string {
  return PROVIDER_KEY_MAP[provider] || 'CUSTOM_API_KEY';
}

export interface RuntimeConfig {
  provider: string;
  model: string;
  base_url?: string | null;
  prompts_manifest?: RemoteManifest;
}

type YamlDoc = Record<string, unknown>;
type ModelSection = Record<string, unknown>;

/**
 * Partial merge: 读旧 config.yaml, 只覆盖我们关心的字段。
 *
 * 我们管的字段:
 *   model.default
 *   model.provider
 *   model.base_url            (cfg.base_url 为 null 时删除该字段)
 *   model.api_key             (仅 custom provider 有效，一等公民 provider 从 ~/.hermes/.env 读 key)
 *   display.tool_progress     'off' — 不在 chat UI 输出 "⚙ pnpm install ..." 工具进度条
 *   display.inline_diffs      false — 不在 chat UI 输出 "┊ review diff a/x → b/x @@ ..."
 *
 * display 这两条是 hermes -Q (quiet) 没盖到的盲区: -Q 只把 tool_progress
 * 在 runtime 改成 off, inline_diffs 是 write_file/patch/skill_manage 工具
 * 完成时强制打的, 走的是另一条 print 路径。我们的输出最终落到 chat 气泡
 * (web/微信), diff text 和工具进度条对用户毫无意义且会让普通用户懵逼。
 * 在 config 层关掉是唯一干净的做法 (hermes 上游没暴露 env 开关)。
 *
 * timeout 不管: hermes 自带的默认 (request 1800s / stale 90s + 长 ctx 自动放大到
 *   150-240s) 实测够用; 容器内 retry + fallback 链兜底, 跨境抖动自愈。
 *   ⚠️ 历史遗留 model.{request,stale}_timeout_seconds 主动清掉 ——
 *   hermes_cli/timeouts.py 只在 providers.<id> 块读这俩 key, 写在 model.* 下 hermes
 *   静默忽略, 留着只会让人误以为生效。
 *
 * 其他所有字段 (providers / compression / stt / browser / memory / skills / ...)
 * 保留 hermes seed 或用户手动添加的内容不动。
 */
function mergeConfig(existing: YamlDoc | null, cfg: RuntimeConfig): YamlDoc {
  const doc: YamlDoc = (existing && typeof existing === 'object') ? { ...existing } : {};
  const existingModel = doc.model;
  const model: ModelSection = (existingModel && typeof existingModel === 'object')
    ? { ...(existingModel as ModelSection) }
    : {};

  model.default = cfg.model;
  model.provider = cfg.provider;
  if (cfg.base_url) {
    model.base_url = cfg.base_url;
  } else {
    delete model.base_url;
  }
  if (cfg.provider === 'custom') {
    model.api_key = process.env['HERMES_API_KEY'] || '';
  } else {
    delete model.api_key;
  }
  // 清旧版本错位置写入的死字段 (一次性, 老 volume 升级时自动清理)
  delete model.request_timeout_seconds;
  delete model.stale_timeout_seconds;

  doc.model = model;

  // display: clamp 我们关心的两条, 其余字段 (compact / banner / language / ...) 不动
  const existingDisplay = doc.display;
  const display: Record<string, unknown> = (existingDisplay && typeof existingDisplay === 'object')
    ? { ...(existingDisplay as Record<string, unknown>) }
    : {};
  display.tool_progress = 'off';
  display.inline_diffs = false;
  doc.display = display;

  return doc;
}

async function readExistingConfig(): Promise<YamlDoc | null> {
  if (!existsSync(CFG)) return null;
  try {
    const text = await Bun.file(CFG).text();
    const parsed = YAML.parse(text) as unknown;
    return (parsed && typeof parsed === 'object') ? parsed as YamlDoc : {};
  } catch (e) {
    warn(`existing config.yaml unparseable, treating as empty: ${(e as Error).message}`);
    return null;
  }
}

export async function fetchRuntimeConfig(): Promise<RuntimeConfig | null> {
  const GATEWAY = process.env['GATEWAY_BASE_URL'] ?? '';
  const token = readToken();
  if (!token) {
    warn('no token — cannot pull runtime-config');
    return null;
  }
  // retry 7 次, 应对 dev concurrently 起 gateway+hermes 时 gateway 没 ready
  for (let i = 1; i <= 7; i++) {
    try {
      const { status, body } = await httpJson({
        method: 'GET',
        url: `${GATEWAY}/api/me/runtime-config`,
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: 5_000,
      });
      if (status >= 200 && status < 300) {
        log(`runtime-config fetched on attempt ${i}`);
        return JSON.parse(body) as RuntimeConfig;
      }
      warn(`runtime-config HTTP ${status} (attempt ${i}/7)`);
    } catch (e) {
      warn(`runtime-config attempt ${i}/7 failed: ${(e as Error).message}`);
    }
    if (i < 7) await sleep(3_000);
  }
  return null;
}

export async function renderConfigYaml(cfg: RuntimeConfig | null | undefined): Promise<void> {
  if (!cfg) {
    if (existsSync(CFG)) {
      warn('runtime-config unreachable — keeping existing config.yaml');
    } else {
      warn('runtime-config unreachable, no existing config.yaml — Hermes may fail to start');
    }
    return;
  }
  const existing = await readExistingConfig();
  const merged = mergeConfig(existing, cfg);
  const yaml = YAML.stringify(merged, null, 2);
  await Bun.write(CFG, yaml);

  // 写 .runtime_env，entrypoint source 后变成环境变量，供 server.ts + hermes CLI 继承
  const apiKey = process.env['HERMES_API_KEY'] || '';
  const envLines = [
    `HERMES_PROVIDER=${cfg.provider || 'unknown'}`,
    `HERMES_MODEL=${cfg.model || 'unknown'}`,
  ];
  if (apiKey) {
    const keyName = providerKeyName(cfg.provider);
    envLines.push(`${keyName}=${apiKey}`);
  }
  await Bun.write(`${HOME_DIR}/.hermes/.runtime_env`, envLines.join('\n') + '\n');

  log(`merged config.yaml (provider=${cfg.provider} model=${cfg.model} base_url=${cfg.base_url ?? 'default'})`);
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
