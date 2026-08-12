import { expect, mock, test } from 'bun:test';
import type { AgentRuntime, PiRuntimeConfig, RuntimeConfig } from '../../runtime/types.ts';

const piConfig: PiRuntimeConfig = {
  provider: 'dashscope',
  model: 'qwen3.7-plus',
  apiKey: 'test-key',
  timeoutSeconds: 14_400,
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
};

mock.module('../scripts/runtime-config.ts', () => ({
  fetchRuntimeConfig: async (): Promise<RuntimeConfig> => ({ files_manifest: {}, pi_config: piConfig }),
}));
mock.module('../scripts/entitlements.ts', () => ({
  fetchDesiredEntitlements: async () => null,
  reportObservedEntitlements: async () => {},
}));

const { initializeRuntime } = await import('./runtime-initialization.ts');

test('passes the complete Gateway runtime configuration to the runtime', async () => {
  let received: RuntimeConfig | null = null;
  const runtime: AgentRuntime = {
    async prepare(config: RuntimeConfig | null): Promise<void> {
      received = config;
    },
    async applyEntitlements(): Promise<string[]> {
      return [];
    },
    async run(): Promise<never> {
      throw new Error('not used');
    },
    async deleteSession(): Promise<{ deleted: false; sessionId: null }> {
      return { deleted: false, sessionId: null };
    },
    async abort(): Promise<void> {},
  };

  await initializeRuntime(runtime);

  expect(received as RuntimeConfig | null).toEqual({ files_manifest: {}, pi_config: piConfig });
});
