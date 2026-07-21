// hermes-proc.test.ts — hermes 子进程 env 派生单测 (bun test)。
//
// 覆盖两件事 (从 pull-runtime-config 的 .runtime_env 时代迁来):
//   1. providerEnvVars: generic HERMES_* → provider 专属 env 名 (alibaba 读 DASHSCOPE_*,
//      见 hermes plugins/model-providers/alibaba + providers.py base_url_env_var)。
//   2. hermesSubprocessBaseEnv: 抹掉 GATEWAY_SECRET (跨租户主密钥不下放给 agent 子进程)。

import { test, expect } from 'bun:test';
import { providerEnvVars, hermesSubprocessBaseEnv } from '../server/hermes-proc.ts';

test('alibaba: 映射 DASHSCOPE_API_KEY + DASHSCOPE_BASE_URL (主 + aux 端点对齐)', () => {
  const out = providerEnvVars('alibaba', 'sk-test', 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  expect(out['DASHSCOPE_API_KEY']).toBe('sk-test');
  expect(out['DASHSCOPE_BASE_URL']).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
});

test('base_url 缺失 → 不写 base_url env (留给 config.yaml model.base_url)', () => {
  const out = providerEnvVars('alibaba', 'sk', '');
  expect(out['DASHSCOPE_BASE_URL']).toBeUndefined();
  expect(out['DASHSCOPE_API_KEY']).toBe('sk');
});

test('apiKey 缺失 → 不写 key env', () => {
  const out = providerEnvVars('alibaba', '', '');
  expect(out['DASHSCOPE_API_KEY']).toBeUndefined();
  expect(Object.keys(out).length).toBe(0);
});

test('未知 provider (custom) → 无 base_url 覆盖, key 兜底 CUSTOM_API_KEY', () => {
  const out = providerEnvVars('custom', 'k', 'https://x/v1');
  expect(Object.keys(out).some((n) => n.includes('BASE_URL'))).toBe(false); // 端点靠 config.yaml model.base_url
  expect(out['CUSTOM_API_KEY']).toBe('k');
});

test('anthropic → 有 key 名, 但无 base_url 覆盖 (overlay 未给 base_url_env_var, 固定端点)', () => {
  const out = providerEnvVars('anthropic', 'sk-ant', 'https://api.anthropic.com');
  expect(out['ANTHROPIC_API_KEY']).toBe('sk-ant');
  expect(Object.keys(out).some((n) => n.includes('BASE_URL'))).toBe(false); // 两表数量差 1 的依据
});

test('裸 "openai" 是 hermes 别名 (→openrouter), 不收: 落 CUSTOM_API_KEY 兜底, 无 OPENAI_*', () => {
  const out = providerEnvVars('openai', 'k', 'https://api.openai.com/v1');
  expect(out['OPENAI_API_KEY']).toBeUndefined();
  expect(out['OPENAI_BASE_URL']).toBeUndefined();
  expect(out['CUSTOM_API_KEY']).toBe('k');
});

test('hermesSubprocessBaseEnv: 抹掉 GATEWAY_SECRET, 保留其余 env', () => {
  process.env.GATEWAY_SECRET = 'super-secret';
  process.env.HERMES_PROVIDER = 'alibaba';
  const env = hermesSubprocessBaseEnv();
  expect(env.GATEWAY_SECRET).toBeUndefined();        // 跨租户主密钥不下放
  expect(env.HERMES_PROVIDER).toBe('alibaba');        // 其余照常继承
  expect(process.env.GATEWAY_SECRET).toBe('super-secret'); // 只动副本, 不改 process.env
  delete process.env.GATEWAY_SECRET;
  delete process.env.HERMES_PROVIDER;
});

test('cleanReply removes quiet-mode session resume status from stderr', async () => {
  const { cleanReply } = await import('../server/hermes-proc.ts');
  expect(cleanReply('↻ Resumed session 20260721_005435_f26bfb (1 user message, 2 total messages)\nsession_id: 20260721_005435_f26bfb')).toBe('');
});
