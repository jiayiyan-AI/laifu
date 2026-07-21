// 拉 /api/me/runtime-config, **partial merge** 到 ~/.hermes/config.yaml。
//
// 拆成两个 export:
//   fetchRuntimeConfig()  — 拉 /api/me/runtime-config, 返回 prompts_manifest (驱动 sync-prompts)
//   renderConfigYaml()    — 读 HERMES_PROVIDER/MODEL/BASE_URL/VISION_MODEL 环境变量 (由 ACA spec env /
//                           dev-hermes.mjs 注入), partial merge 进 ~/.hermes/config.yaml, 写回
//                           (保留 hermes seed / 用户手动加的其他字段不动)。
//
// provider/model/base_url 不再走 runtime-config HTTP, 也不再写 .runtime_env 中转 —— 统一从
// 环境变量取; generic→provider 专属 env 名映射在 server/hermes-proc.ts 一处 (spawn hermes 时)。
// 环境变量缺失时 fallback: 旧 config.yaml 原样保留, 容器仍能跑老配置。
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

// fetchRuntimeConfig 的返回 (端点已瘦成只回 prompts manifest)。
export interface RuntimeConfig {
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
 *   auxiliary.vision         主模型不吃原生图时, 配专用 VL 模型走文字描述路 (model 名由
 *                            env HERMES_VISION_MODEL 注入); 不写 base_url (见下); 否则删除
 *   model.supports_vision    主动删除 —— v16 曾无条件写 true 让 qwen3.7-max 走 native,
 *                            实测该端点 400 拒图; 现统一靠 auxiliary.vision, 不再骗路由
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
export function mergeConfig(existing: YamlDoc | null, cfg: { provider: string; model: string; base_url: string | null; vision_model: string | null }): YamlDoc {
  const doc: YamlDoc = (existing && typeof existing === 'object') ? { ...existing } : {};
  const existingModel = doc.model;
  const model: ModelSection = (existingModel && typeof existingModel === 'object') ? { ...existingModel } : {};

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

  // v16 曾写入这个字段；保留它会让主模型误走原生图像 content，而 compatible-mode 端点会拒绝该请求。
  delete model.supports_vision;
  doc.model = model;

  // display: clamp 我们关心的两条, 其余字段 (compact / banner / language / ...) 不动
  const existingDisplay = doc.display;
  const display: Record<string, unknown> = (existingDisplay && typeof existingDisplay === 'object') ? { ...existingDisplay } : {};
  display.tool_progress = 'off';
  display.inline_diffs = false;
  doc.display = display;

  // ACA 没有 TTY；Hermes 未设置 sudo_password 时会等待 45 秒的交互输入。主容器又启用了
  // no_new_privs，不能把 sudo 当作安装依赖的能力路径，故显式空值只让 Hermes 立即按无密码路径处理。
  const existingTerminal = doc.terminal;
  const terminal: Record<string, unknown> = (existingTerminal && typeof existingTerminal === 'object') ? { ...existingTerminal } : {};
  terminal.sudo_password = '';
  doc.terminal = terminal;

  // auxiliary.vision: "主模型不吃原生图"时配专用 VL 模型走文字描述路。VL model 名由 gateway
  // 经 env HERMES_VISION_MODEL 注入 (config.azure.hermesVisionModel) → 改它只需重部署 gateway,
  // 不必 rebuild 镜像 (旧 PROVIDER_VISION_MODEL 硬编码映射已删, 单一事实源回到 gateway)。
  // ⚠ 只写 provider+model, **绝不写 base_url**: hermes call_llm(task=vision) 会把
  //   auxiliary.vision.base_url 当显式 base_url 传进 _resolve_task_provider_model →
  //   命中 `if base_url: return "custom"` → provider 被强制成 custom → custom 分支只认
  //   OPENAI_API_KEY (空) → 401 invalid_api_key (pin 95715dcb 实测坐实)。
  //   端点改由 env DASHSCOPE_BASE_URL 覆盖 (buildSubprocessEnv 已注入国内站, 与主模型
  //   同一机制): registry 路 resolve_api_key_provider_credentials(alibaba) 读
  //   DASHSCOPE_BASE_URL(端点) + DASHSCOPE_API_KEY(key), 都从 env, 密钥不落 NFS。
  //   gate 仍用 cfg.base_url 在场 (⟺ HERMES_BASE_URL 有值 ⟺ DASHSCOPE_BASE_URL 必被注入),
  //   确保端点覆盖一定到位, 不会落 alibaba profile 默认的国际站 dashscope-intl。
  //   无 vision_model / 无 base_url → 删除该字段 (delete-on-absence, 防 provider 切换后残留强制 text)。
  const visionModel = cfg.vision_model;
  const existingAux = doc.auxiliary;
  const auxiliary: Record<string, unknown> = (existingAux && typeof existingAux === 'object') ? { ...existingAux } : {};
  if (visionModel && cfg.base_url) {
    auxiliary.vision = { provider: cfg.provider, model: visionModel };
  } else {
    delete auxiliary.vision;
  }
  if (Object.keys(auxiliary).length > 0) doc.auxiliary = auxiliary;
  else delete doc.auxiliary;

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

export async function renderConfigYaml(): Promise<void> {
  const provider = (process.env['HERMES_PROVIDER'] ?? '').trim();
  const model = (process.env['HERMES_MODEL'] ?? '').trim();
  const base_url = (process.env['HERMES_BASE_URL'] ?? '').trim();
  const vision_model = (process.env['HERMES_VISION_MODEL'] ?? '').trim();
  if (!provider || !model) {
    if (existsSync(CFG)) {
      warn('HERMES_PROVIDER/MODEL 未注入 — 保留现有 config.yaml');
    } else {
      warn('HERMES_PROVIDER/MODEL 未注入, 且无现有 config.yaml — Hermes 可能起不来');
    }
    return;
  }
  const existing = await readExistingConfig();
  const merged = mergeConfig(existing, { provider, model, base_url, vision_model });
  const yaml = YAML.stringify(merged, null, 2);
  await Bun.write(CFG, yaml);
  log(`merged config.yaml (provider=${provider} model=${model} base_url=${base_url || 'default'} vision=${vision_model || 'none'})`);
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
