import { applyEntitlements } from './entitlements.ts';
import { renderConfigYaml } from './config-renderer.ts';
import { HERMES_BIN, HERMES_PROVIDER, HERMES_TIMEOUT_MS } from './config.ts';
import { buildSubprocessEnv, cleanReply, detectNewSessionId, hermesSubprocessBaseEnv, runHermes } from './hermes-proc.ts';
import { delHermesId, getHermesId, putHermesId } from './session-map.ts';
import { snapshotSession, usageDelta } from './state-db.ts';
import type { Snapshot } from './state-db.ts';
import { log } from '../boot/server/logger.ts';
import type { AgentDeleteSessionResult, AgentRunInput, AgentRunResult, AgentRuntime, ContainerChatUsage, RuntimeConfig } from '../runtime/types.ts';


class HermesProcessError extends Error {
  constructor(message: string, readonly stderr?: string) {
    super(message);
  }
}

function normalizeProcessError(error: unknown): Error {
  const err = error as NodeJS.ErrnoException;
  if (err.code === 'ENOENT') return new HermesProcessError(`hermes binary not found (${HERMES_BIN})`);
  return error instanceof Error ? error : new Error(String(error));
}
const SESSION_DELETE_TIMEOUT_MS = 15_000;

export class HermesRuntime implements AgentRuntime {
  readonly activeRuns = new Map<string, AbortController>();

  async prepare(_config: RuntimeConfig | null): Promise<void> {
    await renderConfigYaml();
  }

  async applyEntitlements(desired: string[]): Promise<string[]> {
    return applyEntitlements(desired);
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const controller = input.loopId ? new AbortController() : undefined;
    if (input.loopId) this.activeRuns.set(input.loopId, controller!);

    try {
      const existing = await getHermesId(input.sessionId);
      const before = snapshotSession(existing);
      const args = ['chat', '-Q', '--yolo'];
      if (existing) args.push('--resume', existing);
      args.push('--source', input.source, '-q', input.message);

      const env = await buildSubprocessEnv();
      let processResult: Awaited<ReturnType<typeof runHermes>>;
      try {
        processResult = await runHermes(args, env, HERMES_TIMEOUT_MS, controller?.signal);
      } catch (error) {
        throw normalizeProcessError(error);
      }
      const { stdout, stderr, exitCode, timedOut } = processResult;

      let resolved = existing;
      if (!existing && exitCode === 0) {
        const newId = await detectNewSessionId(stdout, stderr, input.source);
        if (newId) {
          await putHermesId(input.sessionId, newId);
          resolved = newId;
          log.info({ event: 'session.map', session: input.sessionId, hermes_session_id: newId, source: input.source });
        } else {
          log.warn({ event: 'session.map.miss', session: input.sessionId, source: input.source });
        }
      }
      const usage = this.toUsage(usageDelta(before, snapshotSession(resolved)));

      if (timedOut) return { reply: 'hermes timeout', exitCode: 1, usage, sessionId: resolved, timedOut: true };

      const reply = cleanReply(stdout) || cleanReply(stderr);
      if (reply) return { reply, exitCode, usage, sessionId: resolved, timedOut: false };

      log.error({ event: 'hermes.reply.empty', exit_code: exitCode, stdout_chars: stdout.length, stderr_chars: stderr.length });
      return { reply: '处理失败，请稍后再试。', exitCode: 1, usage, sessionId: resolved, timedOut: false };
    } finally {
      if (input.loopId) this.activeRuns.delete(input.loopId);
    }
  }

  async deleteSession(sessionId: string): Promise<AgentDeleteSessionResult> {
    const hermesSessionId = await getHermesId(sessionId);
    if (!hermesSessionId) return { deleted: false, sessionId: null };

    let processResult: Awaited<ReturnType<typeof runHermes>>;
    try {
      processResult = await runHermes(
        ['sessions', 'delete', hermesSessionId, '--yes'],
        hermesSubprocessBaseEnv(),
        SESSION_DELETE_TIMEOUT_MS,
      );
    } catch (error) {
      throw normalizeProcessError(error);
    }
    const { exitCode, stderr, timedOut } = processResult;
    if (timedOut) throw new Error('hermes sessions delete timeout');
    if (exitCode !== 0) throw new HermesProcessError(`hermes sessions delete exit ${exitCode}`, stderr.trim());

    await delHermesId(sessionId);
    log.info({ event: 'session.delete', session: sessionId, hermes_session_id: hermesSessionId, status: 'ok' });
    return { deleted: true, sessionId: hermesSessionId };
  }


  async abort(loopId: string): Promise<void> {
    this.activeRuns.get(loopId)?.abort();
  }

  private toUsage(snapshot: Snapshot): ContainerChatUsage {
    return { ...snapshot, provider: HERMES_PROVIDER };
  }
}
