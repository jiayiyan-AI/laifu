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
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { log, warn, readToken, httpJson, HOME_DIR } from './lib.mjs';

const CFG = `${HOME_DIR}/.hermes/config.yaml`;

// Hermes 一等公民 provider → 对应的 env var 名
const PROVIDER_KEY_MAP = {
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
function providerKeyName(provider) {
  return PROVIDER_KEY_MAP[provider] || 'CUSTOM_API_KEY';
}

/**
 * Partial merge: 读旧 config.yaml, 只覆盖我们关心的字段。
 *
 * 我们管的字段:
 *   model.default
 *   model.provider
 *   model.base_url           (cfg.base_url 为 null 时删除该字段)
 *   model.api_key            (仅 custom provider 有效，一等公民 provider 从 ~/.hermes/.env 读 key)
 *   model.request_timeout_seconds
 *   model.stale_timeout_seconds
 *
 * 其他所有字段 (providers / compression / stt / browser / memory / display / ...)
 * 保留 hermes seed 或用户手动添加的内容不动。
 */
function mergeConfig(existing, cfg) {
  const doc = (existing && typeof existing === 'object') ? { ...existing } : {};
  const model = (doc.model && typeof doc.model === 'object') ? { ...doc.model } : {};

  model.default = cfg.model;
  model.provider = cfg.provider;
  if (cfg.base_url) {
    model.base_url = cfg.base_url;
  } else {
    delete model.base_url;
  }
  // api_key 只对 custom provider 有效，一等公民 provider 通过 ~/.hermes/.env 注入
  if (cfg.provider === 'custom') {
    model.api_key = process.env['HERMES_API_KEY'] || '';
  } else {
    delete model.api_key;
  }
  model.request_timeout_seconds = cfg.request_timeout_seconds;
  model.stale_timeout_seconds = cfg.stale_timeout_seconds;

  doc.model = model;
  return doc;
}

function readExistingConfig() {
  if (!existsSync(CFG)) return null;
  try {
    const text = readFileSync(CFG, 'utf8');
    const parsed = yamlParse(text);
    return parsed ?? {};
  } catch (e) {
    warn(`existing config.yaml unparseable, treating as empty: ${e.message}`);
    return null;
  }
}

export async function fetchRuntimeConfig() {
  const GATEWAY = process.env['GATEWAY_BASE_URL'];
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
        return JSON.parse(body);
      }
      warn(`runtime-config HTTP ${status} (attempt ${i}/7)`);
    } catch (e) {
      warn(`runtime-config attempt ${i}/7 failed: ${e.message}`);
    }
    if (i < 7) await new Promise((r) => setTimeout(r, 3_000));
  }
  return null;
}

export function renderConfigYaml(cfg) {
  if (!cfg) {
    if (existsSync(CFG)) {
      warn('runtime-config unreachable — keeping existing config.yaml');
    } else {
      warn('runtime-config unreachable, no existing config.yaml — Hermes may fail to start');
    }
    return;
  }
  const existing = readExistingConfig();
  const merged = mergeConfig(existing, cfg);
  const yaml = yamlStringify(merged, { lineWidth: 0 });
  writeFileSync(CFG, yaml);

  // 写 .runtime_env，entrypoint source 后变成环境变量，供 server.py + hermes CLI 继承
  const apiKey = process.env['HERMES_API_KEY'] || '';
  const envLines = [
    `HERMES_PROVIDER=${cfg.provider || 'unknown'}`,
    `HERMES_MODEL=${cfg.model || 'unknown'}`,
  ];
  if (apiKey) {
    const keyName = providerKeyName(cfg.provider);
    envLines.push(`${keyName}=${apiKey}`);
  }
  writeFileSync(`${HOME_DIR}/.hermes/.runtime_env`, envLines.join('\n') + '\n');

  log(`merged config.yaml (provider=${cfg.provider} model=${cfg.model} base_url=${cfg.base_url ?? 'default'})`);
}
