export interface ContainerChatUsage {
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  provider: string;
}

export interface AgentRunInput {
  message: string;
  sessionId: string;
  source: string;
  loopId: string;
}

export interface AgentRunResult {
  reply: string;
  exitCode: number;
  usage: ContainerChatUsage;
  sessionId: string | null;
  timedOut: boolean;
}

export interface AgentDeleteSessionResult {
  deleted: boolean;
  sessionId: string | null;
}

/**
 * 手动压缩会话上下文的结果。
 *  - compacted:   已压缩, 带压缩前 / 预估压缩后 token 数
 *  - nothing:     会话太短或刚压缩过, 无需压缩
 *  - no_session:  该 gateway session 还没有 agent 会话
 *  - unsupported: 当前 runtime 不支持手动压缩 (hermes CLI)
 */
export type AgentCompactSessionResult =
  | { status: 'compacted'; tokensBefore: number; tokensAfter: number | null }
  | { status: 'nothing' | 'no_session' | 'unsupported' };

export interface PiRuntimeConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  timeoutSeconds: number;
  /** 上下文超过该 token 数即自动压缩; 缺省走 Pi 默认 (contextWindow - 16384)。 */
  compactionThresholdTokens?: number;
}

export interface RuntimeConfig {
  files_manifest?: Record<string, string>;
  pi_config?: PiRuntimeConfig;
}

/**
 * 业务 HTTP 层唯一允许依赖的 agent 边界。
 *
 * prepare/applyEntitlements 是容器启动与 entitlement 更新所需的 runtime 生命周期；
 * run/deleteSession/compactSession/abort 保持 chat 请求路径与 runtime 私有状态隔离。
 */
export interface AgentRuntime {
  prepare(config: RuntimeConfig | null): Promise<void>;
  applyEntitlements(desired: string[]): Promise<string[]>;
  run(input: AgentRunInput): Promise<AgentRunResult>;
  deleteSession(sessionId: string): Promise<AgentDeleteSessionResult>;
  compactSession(sessionId: string): Promise<AgentCompactSessionResult>;
  abort(loopId: string): Promise<void>;
}
