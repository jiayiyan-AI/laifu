import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DYNAMIC_DIR, PI_MODEL_PROFILES_FILE } from '../boot/scripts/dynamic-files.ts';
import type { PiRuntimeConfig } from '../runtime/types.ts';

export type PiProfileApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages';

export interface PiModelCostTier {
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PiModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: PiModelCostTier[];
}

export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface PiModelProfile {
  model: string;
  name: string;
  reasoning: boolean;
  input: Array<'text' | 'image'>;
  cost: PiModelCost;
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Partial<Record<PiThinkingLevel, string | null>>;
  compat?: {
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    supportsStore?: boolean;
    supportsOpenAIGrammarTools?: boolean;
    thinkingFormat?: 'qwen';
  };
}

export interface PiProviderProfile {
  provider: string;
  name: string;
  defaultBaseUrl: string;
  api: PiProfileApi;
  authHeader: boolean;
  models: PiModelProfile[];
}

export interface PiModelProfiles {
  revision: string;
  providers: PiProviderProfile[];
}

const PI_MODEL_PROFILES = join(DYNAMIC_DIR, PI_MODEL_PROFILES_FILE);

export async function savePiModelProfiles(profiles: PiModelProfiles | undefined): Promise<void> {
  if (!profiles) return;

  await mkdir(DYNAMIC_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${PI_MODEL_PROFILES}.tmp`;
  await writeFile(temporary, JSON.stringify(profiles), { mode: 0o600 });
  await rename(temporary, PI_MODEL_PROFILES);
}

export async function loadPiModelProfiles(): Promise<PiModelProfiles | null> {
  try {
    return JSON.parse(await readFile(PI_MODEL_PROFILES, 'utf8')) as PiModelProfiles;
  } catch {
    return null;
  }
}

export async function registerPiModelProfile(
  runtime: ModelRuntime,
  config: PiRuntimeConfig,
) {
  const profiles = await loadPiModelProfiles();
  const provider = profiles?.providers.find(({ provider }) => provider === config.provider);
  if (!provider || !provider.models.some(({ model }) => model === config.model)) return null;

  const baseUrl = config.baseUrl || provider.defaultBaseUrl;
  runtime.registerProvider(provider.provider, {
    name: provider.name,
    baseUrl,
    api: provider.api,
    authHeader: provider.authHeader,
    models: provider.models.map((model) => ({
      id: model.model,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      compat: model.compat,
      thinkingLevelMap: model.thinkingLevelMap,
    })),
  });
  return provider.provider;
}
