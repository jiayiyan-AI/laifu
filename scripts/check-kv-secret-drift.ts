/**
 * check-kv-secret-drift — 校验 KV secret 在 manifest / bicep / azure.ts 三方一致。
 *
 * 真相来源: apps/gateway/src/kv-secrets.ts (KV_SECRETS)
 * 配套工具: scripts/seed-kv-secrets.ts (按 manifest 灌缺失 secret)
 *
 * ─── 先决条件 ────────────────────────────────────────────────────────
 *   1. 已跑过 pnpm install (脚本通过 gateway 包的 tsx 执行)
 *   不需要 Azure 凭据 — 只读 repo 内文件做静态分析。
 *
 * ─── 跑法 ────────────────────────────────────────────────────────────
 *   # 从 repo 根目录跑:
 *   pnpm --filter @lingxi/gateway exec tsx ../../scripts/check-kv-secret-drift.ts
 *
 *   无参数; 无 flag。退出码即结果, 适合 CI gate (见 .github/workflows/gateway-deploy.yml)。
 *
 * ─── 检查规则 ────────────────────────────────────────────────────────
 *   1. (error) bicep `@Microsoft.KeyVault(...SecretName=X)` 引用的 X 必须在 manifest
 *              否则 ARM deploy 通过, 但 App Service 启动 SecretNotFound。
 *   2. (error) manifest consumer = 'gateway.env.<NAME>' 的 secret, bicep 必须有对应
 *              appSetting 通过 KV reference 拉它, 且 appSetting 名字与 consumer 一致。
 *   3. (error) manifest consumer = 'aca-hermes.env.<NAME>' 的 secret, azure.ts 必须
 *              出现该 secret 名字 (字符串匹配; KvSecretName 类型挡笔误后兜底)。
 *   4. (warn)  bicep 用了一个 manifest 里有, 但 appSetting 名字对不上 consumer 的 secret。
 *              多半是命名错配 — 不会直接坏运行, 但会让 manifest 跟现实漂移。
 *
 * ─── 不在范围 ────────────────────────────────────────────────────────
 *   - 真实 KV 是否灌了 secret  →  跑 seed-kv-secrets <env> --dry-run
 *   - secret 真值是否过期 / placeholder  →  目前没工具, 出问题靠 runtime 报警
 *
 * ─── 退出码 ──────────────────────────────────────────────────────────
 *   0  无 error (可能有 warn, 不阻塞)
 *   1  至少一条 error (CI 应阻塞 deploy)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KV_SECRETS, type KvSecretName } from '../apps/gateway/src/kv-secrets.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));

interface BicepRef {
  appSettingName: string;
  kvSecretName: string;
  line: number;
}

const BICEP_KV_REF = /^\s*([A-Z][A-Z_0-9]*)\s*:\s*'@Microsoft\.KeyVault\([^)]*SecretName=([a-z0-9-]+)\)'/;

const scanBicep = (relPath: string): BicepRef[] => {
  const text = readFileSync(`${REPO}/${relPath}`, 'utf8');
  const refs: BicepRef[] = [];
  text.split('\n').forEach((line, i) => {
    const m = BICEP_KV_REF.exec(line);
    if (m) {
      refs.push({ appSettingName: m[1]!, kvSecretName: m[2]!, line: i + 1 });
    }
  });
  return refs;
};

const scanAzureTs = (relPath: string): KvSecretName[] => {
  const text = readFileSync(`${REPO}/${relPath}`, 'utf8');
  const found: KvSecretName[] = [];
  for (const name of Object.keys(KV_SECRETS) as KvSecretName[]) {
    if (text.includes(`'${name}'`) || text.includes(`"${name}"`)) {
      found.push(name);
    }
  }
  return found;
};

interface Diag {
  level: 'error' | 'warn';
  msg: string;
}

const CONSUMER_RE = /^(gateway|aca-hermes)\.env\.([A-Z][A-Z_0-9]*)$/;

const check = (): Diag[] => {
  const diags: Diag[] = [];
  const bicepRefs = scanBicep('infra/bicep/main.bicep');
  const azureRefs = scanAzureTs('apps/gateway/src/provisioning/azure.ts');
  const manifest = KV_SECRETS;

  // 索引: kvSecretName → bicep ref (用 Record 因为 secret 名都是已知字符串)
  const bicepBySecret: Record<string, BicepRef> = {};
  for (const r of bicepRefs) bicepBySecret[r.kvSecretName] = r;

  // 规则 1: bicep 引用必须在 manifest
  for (const ref of bicepRefs) {
    if (!Object.hasOwn(manifest, ref.kvSecretName)) {
      diags.push({
        level: 'error',
        msg: `bicep main.bicep:${ref.line} 引用 KV secret "${ref.kvSecretName}" 不在 manifest`,
      });
    }
  }

  // 规则 2/3: manifest 的每个 consumer 必须有实际消费者
  for (const [name, spec] of Object.entries(manifest)) {
    for (const consumer of spec.consumers) {
      const m = CONSUMER_RE.exec(consumer);
      if (!m) {
        diags.push({
          level: 'warn',
          msg: `manifest "${name}" 的 consumer "${consumer}" 格式不对 (期望 gateway.env.X 或 aca-hermes.env.X)`,
        });
        continue;
      }
      const [, kind, envName] = m;
      if (kind === 'gateway') {
        const ref = bicepBySecret[name];
        if (!ref) {
          diags.push({
            level: 'error',
            msg: `manifest "${name}" 声明 gateway.env.${envName} 但 bicep 无 @Microsoft.KeyVault(SecretName=${name}) 引用`,
          });
        } else if (ref.appSettingName !== envName) {
          diags.push({
            level: 'error',
            msg: `manifest "${name}" 说 gateway.env.${envName}, bicep 实际拼成 ${ref.appSettingName} (line ${ref.line})`,
          });
        }
      } else {
        if (!azureRefs.includes(name as KvSecretName)) {
          diags.push({
            level: 'error',
            msg: `manifest "${name}" 声明 aca-hermes.env.${envName} 但 azure.ts 找不到 "${name}" 字符串引用`,
          });
        }
      }
    }
  }

  // 规则 4: bicep 命名与 manifest 不对齐 (warn)
  for (const ref of bicepRefs) {
    if (!Object.hasOwn(manifest, ref.kvSecretName)) continue;
    const spec = manifest[ref.kvSecretName as KvSecretName];
    const consumer = `gateway.env.${ref.appSettingName}`;
    if (!spec.consumers.includes(consumer)) {
      diags.push({
        level: 'warn',
        msg: `bicep main.bicep:${ref.line} 拼成 ${ref.appSettingName} → ${ref.kvSecretName}, manifest 没声明 consumer "${consumer}"`,
      });
    }
  }

  return diags;
};

const main = (): void => {
  console.log('KV secret drift check\n');

  const bicepRefs = scanBicep('infra/bicep/main.bicep');
  const azureRefs = scanAzureTs('apps/gateway/src/provisioning/azure.ts');
  console.log(`Manifest declares : ${Object.keys(KV_SECRETS).length} secrets`);
  console.log(`Bicep references  : ${bicepRefs.length}`);
  console.log(`azure.ts mentions : ${azureRefs.length}\n`);

  const diags = check();
  const errors = diags.filter((d) => d.level === 'error');
  const warnings = diags.filter((d) => d.level === 'warn');

  if (warnings.length > 0) {
    console.log(`Warnings (${warnings.length}):`);
    for (const d of warnings) console.log(`  ⚠ ${d.msg}`);
    console.log('');
  }
  if (errors.length > 0) {
    console.log(`Errors (${errors.length}):`);
    for (const d of errors) console.log(`  ✗ ${d.msg}`);
    process.exit(1);
  }
  if (warnings.length === 0) console.log('✓ 三方一致。');
};

main();
