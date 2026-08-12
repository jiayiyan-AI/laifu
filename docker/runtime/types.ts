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

export interface PiRuntimeConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  timeoutSeconds: number;
}

export interface RuntimeConfig {
  files_manifest?: Record<string, string>;
  pi_config?: PiRuntimeConfig;
}

/**
 * 业务 HTTP 层唯一允许依赖的 agent 边界。
 *
 * prepare/applyEntitlements 是容器启动与 entitlement 更新所需的 runtime 生命周期；
 * run/deleteSession/abort 保持 chat 请求路径与 runtime 私有状态隔离。
 */
export interface AgentRuntime {
  prepare(config: RuntimeConfig | null): Promise<void>;
  applyEntitlements(desired: string[]): Promise<string[]>;
  run(input: AgentRunInput): Promise<AgentRunResult>;
  deleteSession(sessionId: string): Promise<AgentDeleteSessionResult>;
  abort(loopId: string): Promise<void>;
}
