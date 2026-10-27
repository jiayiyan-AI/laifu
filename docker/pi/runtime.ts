import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { readDynamicFile, SYSTEM_PROMPT_FILE } from '../boot/scripts/dynamic-files.ts';
import { log } from '../boot/server/logger.ts';
import type {
  AgentCompactSessionResult,
  AgentDeleteSessionResult,
  AgentRunInput,
  AgentRunResult,
  AgentRuntime,
  ContainerChatUsage,
  RuntimeConfig,
} from '../runtime/types.ts';
import { registerPiModelProfile } from './model-profiles.ts';
import { resolveRuntimeResources, type RuntimeResourcePlan, sameResourcePlans } from './resource-plan.ts';
import {
  createPiSessionManager,
  deletePiSessionManager,
  openPiSessionManager,
} from './session-locator.ts';
import { getPiSession } from './session-map.ts';
import { ensurePiWorkspace } from './workspace.ts';

function timeoutMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`invalid Pi timeoutSeconds: ${seconds}`);
  }
  return Math.floor(seconds * 1000);
}

/** Pi 默认的压缩预留 token (见 pi-coding-agent settings: compaction.reserveTokens)。 */
const PI_DEFAULT_RESERVE_TOKENS = 16_384;

/** session.compact() 在「无需压缩」时抛的错误前缀, 当作正常结果而非失败。 */
const NOTHING_TO_COMPACT_ERRORS = ['Nothing to compact', 'Already compacted'];


export class PiRuntime implements AgentRuntime {
  private readonly activeRuns = new Map<string, AgentSession>();
  private readonly sessions = new Map<string, AgentSession>();
  private readonly sessionLifecycleLocks = new Map<string, Promise<void>>();
  private settingsManager: SettingsManager | null = null;
  private resourcePlan: RuntimeResourcePlan | null = null;
  private providerName: string | null = null;
  private modelName: string | null = null;
  private modelRuntimeInitialization: Promise<ModelRuntime> | null = null;
  private config: RuntimeConfig | null = null;

  async prepare(config: RuntimeConfig | null): Promise<void> {
    this.config = config;
  }

  async applyEntitlements(desired: string[]): Promise<string[]> {
    const next = await resolveRuntimeResources(desired);
    if (!sameResourcePlans(this.resourcePlan, next)) {
      this.resourcePlan = next;
      await Promise.allSettled([...this.activeRuns.values()].map((session) => session.abort()));
      await Promise.all([...this.sessions.keys()].map((sessionId) => this.withSessionLifecycleLock(sessionId, async () => {
        this.sessions.get(sessionId)?.dispose();
        this.sessions.delete(sessionId);
      })));
    }
    return next.observedEntitlements;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const modelRuntime = await this.ensureModelRuntime();
    const result = await this.withSessionLifecycleLock(input.sessionId, async () => {
      const session = await this.getSession(input.sessionId, modelRuntime);
      return this.runSession(session, input);
    });
    return result;
  }

  private async runSession(session: AgentSession, input: AgentRunInput): Promise<AgentRunResult> {
    const firstNewMessage = session.messages.length;
    this.activeRuns.set(input.loopId, session);

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      void session.abort().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log.warn({ event: 'session.abort', session: input.sessionId, loop_id: input.loopId, err: message });
      });
    }, timeoutMs(this.config?.pi_config?.timeoutSeconds ?? NaN));

    try {
      await session.prompt(input.message);
      const assistant = this.lastAssistantMessage(session, firstNewMessage);
      const usage = this.toUsage(assistant);

      if (timedOut) {
        return { reply: 'pi timeout', exitCode: 1, usage, sessionId: session.sessionId, timedOut: true };
      }
      if (!assistant) {
        return { reply: '处理失败，请稍后再试。', exitCode: 1, usage, sessionId: session.sessionId, timedOut: false };
      }
      if (assistant.errorMessage || assistant.stopReason === 'error' || assistant.stopReason === 'aborted') {
        return {
          reply: assistant.errorMessage || '处理失败，请稍后再试。',
          exitCode: 1,
          usage,
          sessionId: session.sessionId,
          timedOut: false,
        };
      }

      let reply = '';
      for (const part of assistant.content) {
        if (part.type === 'text') reply += part.text;
      }
      return {
        reply: reply || '处理失败，请稍后再试。',
        exitCode: reply ? 0 : 1,
        usage,
        sessionId: session.sessionId,
        timedOut: false,
      };
    } finally {
      clearTimeout(timeout);
      if (this.activeRuns.get(input.loopId) === session) this.activeRuns.delete(input.loopId);
    }
  }

  async deleteSession(sessionId: string): Promise<AgentDeleteSessionResult> {
    await this.sessions.get(sessionId)?.abort();
    return this.withSessionLifecycleLock(sessionId, async () => {
      const session = this.sessions.get(sessionId);
      session?.dispose();
      this.sessions.delete(sessionId);

      const piSessionId = await deletePiSessionManager(sessionId);
      if (!piSessionId) return { deleted: false, sessionId: null };
      log.info({ event: 'session.delete', session: sessionId, pi_session_id: piSessionId, status: 'ok' });
      return { deleted: true, sessionId: piSessionId };
    });
  }

  /**
   * 手动压缩。与 run 共用 session 生命周期锁: 有正在跑的轮次时排在其后, 压缩期间新轮次也排队。
   */
  async compactSession(sessionId: string): Promise<AgentCompactSessionResult> {
    const modelRuntime = await this.ensureModelRuntime();
    return this.withSessionLifecycleLock(sessionId, async () => {
      if (!this.sessions.has(sessionId) && !(await getPiSession(sessionId))) return { status: 'no_session' };
      const session = await this.getSession(sessionId, modelRuntime);
      try {
        const result = await session.compact();
        const tokensAfter = result.estimatedTokensAfter ?? null;
        log.info({ event: 'session.compact', session: sessionId, status: 'ok', tokens_before: result.tokensBefore, tokens_after: tokensAfter });
        return { status: 'compacted', tokensBefore: result.tokensBefore, tokensAfter };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (NOTHING_TO_COMPACT_ERRORS.some((prefix) => message.startsWith(prefix))) {
          log.info({ event: 'session.compact', session: sessionId, status: 'nothing', reason: message });
          return { status: 'nothing' };
        }
        throw error;
      }
    });
  }

  async abort(loopId: string): Promise<void> {
    await this.activeRuns.get(loopId)?.abort();
  }

  private async withSessionLifecycleLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionLifecycleLocks.get(sessionId);
    const current = Promise.withResolvers<void>();
    this.sessionLifecycleLocks.set(sessionId, current.promise);

    if (previous) await previous;
    try {
      return await operation();
    } finally {
      current.resolve();
      if (this.sessionLifecycleLocks.get(sessionId) === current.promise) {
        this.sessionLifecycleLocks.delete(sessionId);
      }
    }
  }

  private async ensureModelRuntime(): Promise<ModelRuntime> {
    return this.modelRuntimeInitialization ??= this.createModelRuntime().catch((error) => {
      this.modelRuntimeInitialization = null;
      this.modelName = null;
      this.providerName = null;
      throw error;
    });
  }

  private async createModelRuntime(): Promise<ModelRuntime> {
    const config = this.config?.pi_config;
    if (!config?.provider || !config.model || !config.apiKey) {
      throw new Error('Pi runtime configuration is required from Gateway');
    }

    const runtime = await ModelRuntime.create({ allowModelNetwork: false });
    const builtInModel = runtime.getModel(config.provider, config.model);
    if (builtInModel) {
      if (config.baseUrl) runtime.registerProvider(config.provider, { baseUrl: config.baseUrl });
      await runtime.setRuntimeApiKey(config.provider, config.apiKey);
      this.providerName = config.provider;
      this.modelName = config.model;
      return runtime;
    }

    const providerId = await registerPiModelProfile(runtime, config);
    if (providerId) {
      await runtime.setRuntimeApiKey(providerId, config.apiKey);
      this.providerName = providerId;
      this.modelName = config.model;
      return runtime;
    }

    throw new Error(`Pi model is not configured: ${config.provider}/${config.model}`);
  }

  private async getSession(gatewaySessionId: string, modelRuntime: ModelRuntime): Promise<AgentSession> {
    const cached = this.sessions.get(gatewaySessionId);
    if (cached) return cached;

    const providerName = this.providerName;
    const modelName = this.modelName;
    if (!providerName || !modelName) throw new Error('Pi model runtime is not initialized');
    const model = modelRuntime.getModel(providerName, modelName);
    if (!model) throw new Error(`Pi model is not configured: ${providerName}/${modelName}`);

    const workspace = await ensurePiWorkspace();
    const existingManager = await openPiSessionManager(gatewaySessionId);
    const sessionManager = existingManager ?? await createPiSessionManager(gatewaySessionId);
    const agentDir = getAgentDir();
    const settingsManager = this.getSettingsManager(workspace);
    const resourcePlan = (this.resourcePlan ??= await resolveRuntimeResources([]));
    const managedPrompt = readDynamicFile(SYSTEM_PROMPT_FILE);

    const resourceLoader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir,
      settingsManager,
      additionalExtensionPaths: resourcePlan.packageRoots,
      additionalSkillPaths: resourcePlan.skillPaths,
      appendSystemPrompt: managedPrompt ? [managedPrompt] : [],
    });
    await resourceLoader.reload();
    // reload 会按文件重建 settings、丢掉 override, 所以每次 reload 后重新施加。
    this.applyCompactionThreshold(settingsManager, model);

    const { session } = await createAgentSession({
      agentDir,
      cwd: workspace,
      modelRuntime,
      model,
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    this.sessions.set(gatewaySessionId, session);
    return session;
  }

  /**
   * Pi 自动压缩条件是 `context > contextWindow - reserveTokens`。contextWindow 是模型真实上限,
   * 不能为了提前压缩而调小 (会把 max_tokens 夹到极小, 大会话连摘要都生成不了), 所以通过
   * reserveTokens 把触发线放到 compactionThresholdTokens。
   */
  private applyCompactionThreshold(settingsManager: SettingsManager, model: { contextWindow: number }): void {
    const threshold = this.config?.pi_config?.compactionThresholdTokens;
    if (!threshold || threshold <= 0 || model.contextWindow <= 0) return;
    const reserveTokens = Math.max(PI_DEFAULT_RESERVE_TOKENS, model.contextWindow - threshold);
    settingsManager.applyOverrides({ compaction: { reserveTokens } });
  }

  private getSettingsManager(workspace: string): SettingsManager {
    return this.settingsManager ??= SettingsManager.create(workspace, getAgentDir(), { projectTrusted: true });
  }

  private lastAssistantMessage(session: AgentSession, firstNewMessage: number): AssistantMessage | null {
    for (let i = session.messages.length - 1; i >= firstNewMessage; i--) {
      const message = session.messages[i];
      if (message.role === 'assistant') return message;
    }
    return null;
  }

  private toUsage(message: AssistantMessage | null): ContainerChatUsage {
    return {
      model: message?.responseModel ?? message?.model ?? this.modelName,
      input_tokens: message?.usage.input ?? 0,
      output_tokens: message?.usage.output ?? 0,
      cache_read_tokens: message?.usage.cacheRead ?? 0,
      cache_write_tokens: message?.usage.cacheWrite ?? 0,
      reasoning_tokens: message?.usage.reasoning ?? 0,
      provider: message?.provider ?? this.providerName ?? 'unknown',
    };
  }
}
