import { createHash } from 'node:crypto';
import type { PiModelProfiles } from '@lingxi/shared';

const providers: PiModelProfiles['providers'] = [
  {
    provider: 'dashscope',
    name: 'DashScope OpenAI-compatible provider',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    api: 'openai-completions',
    authHeader: true,
    models: [
      {
        model: 'qwen3-coder-plus',
        name: 'Qwen3-Coder-Plus',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 65_536,
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      },
      {
        model: 'qwen3.7-max',
        name: 'Qwen3.7 Max',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 65_536,
        compat: { thinkingFormat: 'qwen', supportsDeveloperRole: false, supportsStore: false },
      },
      {
        model: 'qwen3.7-plus',
        name: 'Qwen3.7 Plus',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 64_000,
        compat: { thinkingFormat: 'qwen', supportsDeveloperRole: false, supportsStore: false },
      },
    ],
  },
];

export const piModelProfiles: PiModelProfiles = {
  revision: createHash('sha256').update(JSON.stringify(providers)).digest('hex'),
  providers,
};
