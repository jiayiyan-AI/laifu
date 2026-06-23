// hermes-proc.ts — 跑 hermes CLI 子进程 + 输出解析
//
// 三组功能:
//   1. runHermes()      spawn hermes, 进程组管理, 硬超时一锅端 (SIGTERM→3s→SIGKILL)
//   2. buildSubprocessEnv()  每次 chat 现读 dynamic system prompt, 注 env
//   3. ID 提取 / cleanReply  解析 hermes stdout/stderr 拿 session_id, 清洗回复
//
// 关键设计: spawn 时 detached:true → 新 process group leader; 超时时 kill(-pid)
// 一锅端整个组 (包括 hermes 起的 pnpm/git/uv 等孙子), 避免孤儿在容器里残留资源。
// Python `subprocess.run(timeout=...)` 只 SIGKILL 直接子进程, 这里是修了的 bug。
//
// Bun 注: 走 node:child_process polyfill (Bun 1.3+ 完整支持 spawn + detached + ipc),
// process.kill(-pgid) 直接走 POSIX kill(2), 跟 Node 行为完全一致。

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { HERMES_BIN, KILL_GRACE_MS, DYN_SYSTEM_PROMPT_FILE } from './config.ts';
import { log } from './logger.ts';

// ─── provider → hermes 实际读的 env 名 (generic HERMES_* → provider 专属名) ──────
// 单一依据 = 镜像内 hermes-agent 源码 (pin 95715dcb):
//   key 名     → plugins/model-providers/<provider>/__init__.py 的 env_vars[0]
//   base_url 名 → hermes_cli/providers.py HERMES_OVERLAYS[<provider>].base_url_env_var
// 通用名 (HERMES_PROVIDER/MODEL/BASE_URL + HERMES_API_KEY) 由 gateway buildSpec(prod) /
// dev-hermes.sh --env-file(dev) 注入; 这层 generic→专属 翻译只在容器这一处, prod/dev 共用。
//
// ⚠ key 用**canonical provider id**, 不做 hermes 的 ALIASES 归一化 (那张表太大会漂)。
//   故裸 "openai" 这种别名 (hermes 里 →openrouter 聚合器) **不收**: 要用就显式写 canonical id。
const PROVIDER_KEY_MAP: Record<string, string> = {
  alibaba: 'DASHSCOPE_API_KEY',
  // coding-plan 首选 ALIBABA_CODING_PLAN_API_KEY, 但 env_vars 接受 DASHSCOPE_API_KEY 作 fallback,
  // 而我们的 secret 就是 dashscope key, 故钉 DASHSCOPE_API_KEY (同一把 key 直接通用)。
  'alibaba-coding-plan': 'DASHSCOPE_API_KEY',
  alibaba_coding: 'DASHSCOPE_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  xai: 'XAI_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  novita: 'NOVITA_API_KEY',
  huggingface: 'HF_TOKEN',
  gmi: 'GMI_API_KEY',
  stepfun: 'STEPFUN_API_KEY',
};
// base_url 覆盖 env: 仅 overlay 里声明了 base_url_env_var 的 provider 才有 (其余固定端点)。
// 与 KEY_MAP **同一 provider 集**, 唯一缺 anthropic —— overlay 未给它 base_url_env_var
// (固定端点), 这就是两表数量差 1 的全部原因 (有依据, 非随意)。
const PROVIDER_BASE_URL_MAP: Record<string, string> = {
  alibaba: 'DASHSCOPE_BASE_URL',
  'alibaba-coding-plan': 'ALIBABA_CODING_PLAN_BASE_URL',
  alibaba_coding: 'ALIBABA_CODING_PLAN_BASE_URL',
  deepseek: 'DEEPSEEK_BASE_URL',
  xai: 'XAI_BASE_URL',
  nvidia: 'NVIDIA_BASE_URL',
  novita: 'NOVITA_BASE_URL',
  huggingface: 'HF_BASE_URL',
  gmi: 'GMI_BASE_URL',
  stepfun: 'STEPFUN_BASE_URL',
};

/**
 * 纯函数: 由通用 HERMES_API_KEY/HERMES_BASE_URL + provider 派生 hermes 专属 env 名。
 * key 走 provider 专属名 (alibaba→DASHSCOPE_API_KEY; 未知 provider 兜底 CUSTOM_API_KEY);
 * base_url 仅 mapped provider 写 (其余靠 config.yaml model.base_url)。缺值各自跳过。
 */
export function providerEnvVars(provider: string, apiKey: string, baseUrl: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (apiKey) out[PROVIDER_KEY_MAP[provider] || 'CUSTOM_API_KEY'] = apiKey;
  const baseUrlName = PROVIDER_BASE_URL_MAP[provider];
  if (baseUrl && baseUrlName) out[baseUrlName] = baseUrl;
  return out;
}

// ─── 子进程 env: 每次 chat 现读 dynamic system prompt 文件 ──────────
// gateway 通过 /api/me/prompts/system-prompt.md 下发 → bootstrap.ts sync-prompts
// 写到 DYN_SYSTEM_PROMPT_FILE → 现读现注 HERMES_EPHEMERAL_SYSTEM_PROMPT
/**
 * hermes 子进程的基础 env: 克隆 process.env 但抹掉 server 专属的跨租户密钥。
 * GATEWAY_SECRET 是签发所有用户 LAIFU_USER_TOKEN 的对称主密钥, 只有 server 的 requireBearer
 * 验签入站请求用; hermes CLI / agent 子进程一概不需要。盲传 process.env 会把它递给半受信的
 * agent 代码 (bash/pnpm/skills) → 可伪造任意用户 token。chat 与 sessions 子命令共用此基础。
 * (注: 同 UID 仍可读 /proc/1/environ, 这是纵深防御非硬边界; 硬边界需 secret 改文件投递。)
 */
export function hermesSubprocessBaseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GATEWAY_SECRET;
  return env;
}

export async function buildSubprocessEnv(): Promise<NodeJS.ProcessEnv> {
  const env = hermesSubprocessBaseEnv();

  // generic HERMES_* → hermes 专属 env 名 (alibaba→DASHSCOPE_API_KEY/BASE_URL)。注入源:
  // prod=ACA spec env(buildSpec) / dev=--env-file; 翻译只在此一处。aux/vision 子代理读
  // provider profile env (而非 config.yaml), 故必须在 env 里给到专属名。
  Object.assign(env, providerEnvVars(
    (process.env.HERMES_PROVIDER ?? '').trim(),
    process.env.HERMES_API_KEY ?? '',
    (process.env.HERMES_BASE_URL ?? '').trim(),
  ));

  // 非交互执行: 这俩 env 是 hermes oneshot 模式 (-z) 自己也会设的,
  // 等价于 CLI flag --yolo + --accept-hooks, 但 env 覆盖更彻底
  // (子进程 / 子 agent 都继承)。少了任一个都会让助理在审批点静默截断:
  //   - HERMES_YOLO_MODE      绕过 "dangerous command" 审批 (pnpm/git/rm 等)
  //   - HERMES_ACCEPT_HOOKS   绕过 shell-hooks first-use consent
  //     (UWF bootstrap 注册的 pre_tool_call/post_tool_call 钩子首次触发会卡)
  // 不设的话表现就是 "助理回 '让我来 X:' 后就没下文",
  // 因为容器里没 TTY 响应这两类审批弹窗。
  env.HERMES_YOLO_MODE = '1';
  env.HERMES_ACCEPT_HOOKS = '1';

  try {
    const content = (await readFile(DYN_SYSTEM_PROMPT_FILE, 'utf8')).trim();
    if (content) {
      env.HERMES_EPHEMERAL_SYSTEM_PROMPT = content;
    } else {
      delete env.HERMES_EPHEMERAL_SYSTEM_PROMPT;
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      log.error({ event: 'prompt.read.failed', file: DYN_SYSTEM_PROMPT_FILE, err: err.message });
    }
    // 文件不存在 / 读失败 → 显式 unset 防吃到启动时继承的旧值
    delete env.HERMES_EPHEMERAL_SYSTEM_PROMPT;
  }
  return env;
}

export interface HermesRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

// ─── spawn + 进程组 + 超时杀 ─────────────────────────────────────
export function runHermes(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<HermesRunResult> {
  const { promise, resolve, reject } = Promise.withResolvers<HermesRunResult>();

  let child;
  try {
    child = spawn(HERMES_BIN, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // 新 process group, 用 kill(-pid) 一锅端整组
    });
  } catch (e) {
    reject(e);
    return promise;
  }

  let settled = false;
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (c: string) => (stdout += c));
  child.stderr!.on('data', (c: string) => (stderr += c));

  const pid = child.pid;
  const wallTimer = setTimeout(() => {
    timedOut = true;
    log.error({ event: 'hermes.proc.timeout', timeout_ms: timeoutMs, pid });
    try {
      if (pid) process.kill(-pid, 'SIGTERM');
    } catch {}
    setTimeout(() => {
      try {
        if (pid) process.kill(-pid, 'SIGKILL');
      } catch {}
    }, KILL_GRACE_MS).unref();
  }, timeoutMs);
  wallTimer.unref();

  child.on('error', (e) => {
    if (settled) return;
    settled = true;
    clearTimeout(wallTimer);
    reject(e);
  });

  child.on('exit', (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(wallTimer);
    resolve({
      stdout,
      stderr,
      exitCode: code ?? (signal ? 1 : 0),
      timedOut,
    });
  });

  return promise;
}

// ─── Hermes session_id 提取 ──────────────────────────────────────
// Hermes 输出格式 e.g.: "session_id: YYYYMMDD_HHMMSS_<hash>"
const KEYWORD_PATTERNS: RegExp[] = [
  /[Ss]ession(?:[ _-]?id)?\s*[:=]\s*([A-Za-z0-9_-]{8,})/,
  /\[session\s+([A-Za-z0-9_-]{8,})\]/,
  /resume\s+(?:with\s+)?([A-Za-z0-9_-]{8,})/,
];

// 兜底 ID-like 正则 (UUID / ULID / 长 token)
const ID_PATTERNS: RegExp[] = [
  /\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b/,
  /\b([0-9A-Z]{26})\b/,
  /\b([a-zA-Z0-9_-]{16,})\b/,
];

function extractIdNearKeyword(text: string): string | null {
  for (const pat of KEYWORD_PATTERNS) {
    const m = text.match(pat);
    if (m) return m[1];
  }
  return null;
}

async function newestSessionIdViaList(source: string): Promise<string | null> {
  try {
    const env = await buildSubprocessEnv();
    const { stdout, exitCode } = await runHermes(
      ['sessions', 'list', '--source', source, '--limit', '1'],
      env,
      15_000,
    );
    if (exitCode !== 0) return null;
    const sid = extractIdNearKeyword(stdout);
    if (sid) return sid;
    for (const pat of ID_PATTERNS) {
      const m = stdout.match(pat);
      if (m) return m[1];
    }
    return null;
  } catch (e) {
    log.error({ event: 'session.list.failed', source, err: (e as Error).message });
    return null;
  }
}

export async function detectNewSessionId(
  stdout: string,
  stderr: string,
  source: string,
): Promise<string | null> {
  for (const text of [stdout, stderr]) {
    const sid = extractIdNearKeyword(text);
    if (sid) return sid;
  }
  return newestSessionIdViaList(source);
}

// ─── 清洗 Hermes 输出, 只留真正的 LLM 回复 ──────────────────────
// Hermes -Q 模式会输出:
//   ⚠️ Normalized model 'anthropic/...' to 'claude-sonnet-...' for anthropic.
//     ⚠ tirith security scanner enabled but not available ...
//   session_id: YYYYMMDD_HHMMSS_<hash>
//   <真正的回复>
// 策略: ⚠️/⚠/[server] 开头丢; 末尾 " to" 的吞下一行 (wrap 续接); session_id 元信息丢。
export function cleanReply(stdout: string): string {
  const lines = stdout.split('\n');
  const keep: string[] = [];
  let skipNext = false;
  for (const line of lines) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const stripped = line.replace(/^\s+/, '');
    if (
      stripped.startsWith('⚠️') ||
      stripped.startsWith('⚠') ||
      stripped.startsWith('[server]')
    ) {
      if (line.replace(/\s+$/, '').endsWith(' to')) skipNext = true;
      continue;
    }
    if (stripped.startsWith('session_id:') || stripped.startsWith('Session ID:')) continue;
    keep.push(line);
  }
  return keep.join('\n').trim();
}
