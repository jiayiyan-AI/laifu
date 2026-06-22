import { describe, it, expect } from 'vitest';
import { policyHashFor, buildSpec } from '../../src/provisioning/azure.js';

// policyHashFor 是纯同步函数 (不签 token、不拉 ACR、不碰网络): 用哨兵空 token + 空 acr 造 spec 再哈希。
describe('policyHashFor', () => {
  it('对同一 userId 确定且稳定 (memo)', () => {
    const a = policyHashFor('11111111-2222-3333-4444-555555555555');
    const b = policyHashFor('11111111-2222-3333-4444-555555555555');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);   // sha256 hex
  });

  it('不同 userId 哈希不同 (per-user, subPath 入哈希)', () => {
    const a = policyHashFor('aaaaaaaa-0000-0000-0000-000000000000');
    const b = policyHashFor('bbbbbbbb-0000-0000-0000-000000000000');
    expect(a).not.toBe(b);
  });

  it('只取 userId 前 8 位 hex (与 appNameFor/shareNameFor 同算法): 前 8 位相同 → 哈希相同', () => {
    const a = policyHashFor('abcdef01-1111-1111-1111-111111111111');
    const b = policyHashFor('abcdef01-9999-9999-9999-999999999999');
    expect(a).toBe(b);
  });
});

// gateway-secret 注入 (reconcile 改造试点): 容器侧验签 LAIFU_USER_TOKEN 用的对称密钥,
// 走 KV reference (secretRef), 绝不把明文塞进 env value。消费方留待 weichat Task 4。
describe('buildSpec gateway-secret 注入', () => {
  const USER = '11111111-2222-3333-4444-555555555555';

  it('secrets[] 含 gateway-secret 的 KV reference (keyVaultUrl + identity)', () => {
    const spec = buildSpec(USER, 'tok');
    const secret = spec.configuration?.secrets?.find((s) => s.name === 'gateway-secret');
    expect(secret).toBeDefined();
    expect(secret?.keyVaultUrl).toContain('/secrets/gateway-secret');
    expect(secret?.value).toBeUndefined();          // 走 KV reference, 不内联明文
  });

  it('env GATEWAY_SECRET 走 secretRef 引用 gateway-secret, 不内联明文', () => {
    const spec = buildSpec(USER, 'tok');
    const env = spec.template?.containers?.[0]?.env?.find((e) => e.name === 'GATEWAY_SECRET');
    expect(env).toBeDefined();
    expect(env?.secretRef).toBe('gateway-secret');
    expect(env?.value).toBeUndefined();             // secretRef, 非明文 value
  });

  it('是 policy 字段: 哨兵空 token 下仍注入 (进哈希 → 部署后存量用户 reconcile)', () => {
    const spec = buildSpec(USER, '');               // policyHashFor 用的哨兵空 token
    const env = spec.template?.containers?.[0]?.env?.find((e) => e.name === 'GATEWAY_SECRET');
    expect(env?.secretRef).toBe('gateway-secret');
  });
});

// provider/model/base_url 统一从 ACA spec env 注入 (单一事实源), 容器 renderConfigYaml +
// buildSubprocessEnv 直接读, 不再走 runtime-config HTTP / .runtime_env 中转。
describe('buildSpec 通用 LLM env 注入 (provider/model/base_url)', () => {
  const USER = '11111111-2222-3333-4444-555555555555';
  const envOf = (name: string) =>
    buildSpec(USER, 'tok').template?.containers?.[0]?.env?.find((e) => e.name === name);

  it('HERMES_PROVIDER / HERMES_MODEL / HERMES_BASE_URL / HERMES_VISION_MODEL 以明文 value 注入 (非 secret)', () => {
    for (const name of ['HERMES_PROVIDER', 'HERMES_MODEL', 'HERMES_BASE_URL', 'HERMES_VISION_MODEL']) {
      const env = envOf(name);
      expect(env, `${name} 应注入`).toBeDefined();
      expect(typeof env?.value).toBe('string');
      expect(env?.value!.length).toBeGreaterThan(0);
      expect(env?.secretRef).toBeUndefined();
    }
  });

  it('HERMES_API_KEY 仍走 secretRef (key 不落明文 / 不写 NFS)', () => {
    const env = envOf('HERMES_API_KEY');
    expect(env?.secretRef).toBe('hermes-api-key');
    expect(env?.value).toBeUndefined();
  });

  it('是 policy 字段: 哨兵空 token 下仍注入 (进哈希 → 部署后存量用户 reconcile)', () => {
    const env = buildSpec(USER, '').template?.containers?.[0]?.env?.find((e) => e.name === 'HERMES_PROVIDER');
    expect(env?.value).toBeDefined();
  });
});
