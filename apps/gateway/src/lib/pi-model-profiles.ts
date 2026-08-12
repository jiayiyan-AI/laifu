import { createHash } from 'node:crypto';
import type { PiModelProfiles, RuntimeConfig } from '@lingxi/shared';

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
  {
    provider: 'scott',
    name: 'Scott GitHub Copilot bridge',
    defaultBaseUrl: 'https://oc-kuma.shazhou.work/copilot/v1',
    api: 'openai-responses',
    authHeader: true,
    models: [
      {
        model: 'gpt-5.4',
        name: 'GPT-5.4 (GitHub Copilot)',
        reasoning: true,
        input: ['text', 'image'],
        cost: {
          input: 2.5,
          output: 15,
          cacheRead: 0.25,
          cacheWrite: 0,
          tiers: [
            { inputTokensAbove: 272_000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 0 },
          ],
        },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        thinkingLevelMap: {
          off: null,
          minimal: 'low',
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
          max: null,
        },
        compat: { supportsOpenAIGrammarTools: true },
      },
    ],
  },
];

export const piModelProfiles: PiModelProfiles = {
  revision: createHash('sha256').update(JSON.stringify(providers)).digest('hex'),
  providers,
};

export const piAgentConfig = {
  provider: 'scott',
  model: 'gpt-5.4',
  timeoutSeconds: 14_400,
  apiKey: "71d9d1918a48cc624c0bdb3c01af392624c10cd66fe6f6a2",
} satisfies RuntimeConfig['pi_config'];
