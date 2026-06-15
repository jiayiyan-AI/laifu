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

// ─── 子进程 env: 每次 chat 现读 dynamic system prompt 文件 ──────────
// gateway 通过 /api/me/prompts/system-prompt.md 下发 → bootstrap.ts sync-prompts
// 写到 DYN_SYSTEM_PROMPT_FILE → 现读现注 HERMES_EPHEMERAL_SYSTEM_PROMPT
export async function buildSubprocessEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };

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
      console.error(`[server] read ${DYN_SYSTEM_PROMPT_FILE} failed: ${err.message}`);
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
    console.error(`[server] hermes wall timeout ${timeoutMs}ms, killing pgid ${pid}`);
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
    console.error(`[server] sessions list failed: ${(e as Error).message}`);
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
