/**
 * seed-kv-secrets — 按 manifest 把缺失的 KV secret 灌进 Azure KeyVault。
 *
 * 真相来源: apps/gateway/src/kv-secrets.ts (KV_SECRETS)
 * 配套工具: scripts/check-kv-secret-drift.ts (校验 bicep / azure.ts 是否对齐 manifest)
 *
 * ─── 先决条件 ────────────────────────────────────────────────────────
 *   1. 装好 Azure CLI (https://aka.ms/azure-cli)
 *   2. az login                                              一次性
 *   3. az account set --subscription <SUB_ID>                确认当前 subscription 是目标环境的
 *      az account show --query name -o tsv                   不放心就先打一下
 *   4. 已跑过 pnpm install (脚本通过 gateway 包的 tsx 执行)
 *
 * ─── 跑法 ────────────────────────────────────────────────────────────
 *   # 从 repo 根目录跑:
 *   pnpm --filter @lingxi/gateway exec tsx ../../scripts/seed-kv-secrets.ts <env> [flags]
 *
 *   <env>          dev | prod   (拼出 KV 名 kv-lingxi-<env>)
 *   --dry-run      只显示会做什么, 不写 KV (推荐第一次跑先 --dry-run)
 *   --force        覆盖已存在的 secret (默认 skip)
 *
 * ─── 典型场景 ────────────────────────────────────────────────────────
 *   # 新环境首次部署后灌满
 *   pnpm --filter @lingxi/gateway exec tsx ../../scripts/seed-kv-secrets.ts prod
 *
 *   # 灾后/换机器先 dry-run 看看 KV 里缺啥
 *   pnpm --filter @lingxi/gateway exec tsx ../../scripts/seed-kv-secrets.ts dev --dry-run
 *
 *   # 轮换 google-client-secret (或任何一条) — 改完 manifest 不行, 这条值要覆盖
 *   pnpm --filter @lingxi/gateway exec tsx ../../scripts/seed-kv-secrets.ts prod --force
 *   # ↑ 会逐条问你要不要重置; --force 配合 prompt 类 secret 时仍会停下来等你粘新值
 *
 * ─── 行为 ────────────────────────────────────────────────────────────
 *   遍历 manifest 每条 secret, 按 seed.kind 决定缺失时怎么补:
 *     - generate     跑指定 shell 命令生成 (e.g. openssl rand -hex 32), 自动 set
 *     - placeholder  用 manifest 里硬编码的占位值, 自动 set
 *     - prompt       terminal 提示运维粘贴值 (带 hint 提示格式), 粘完 set
 *   已存在的 secret 默认 skip; --force 才会覆盖。
 *   末尾扫一遍 KV, 列出 manifest 没声明的孤儿 secret (仅 warn 不删, 让人工决定)。
 *
 * ─── 安全说明 ────────────────────────────────────────────────────────
 *   secret 值通过 az CLI --value <X> 传, 短暂出现在 ps 输出里。
 *   这是单机运维操作 (不是常驻服务), 风险可接受; 介意可隔离机器跑。
 *   值不进 shell history (脚本内部 spawn, 不经 shell expansion)。
 *
 * ─── 退出码 ──────────────────────────────────────────────────────────
 *   0  全部 OK
 *   1  参数错 / az 未登录 / KV 不存在 / set 失败
 */

import { spawnSync } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  KV_SECRETS,
  type KvSecretName,
  type KvSecretSpec,
} from '../apps/gateway/src/kv-secrets.js';

interface Args {
  env: 'dev' | 'prod';
  force: boolean;
  dryRun: boolean;
}

const parseArgs = (): Args => {
  const argv = process.argv.slice(2);
  const env = argv.find((a) => a === 'dev' || a === 'prod') as
    | 'dev'
    | 'prod'
    | undefined;
  if (!env) {
    console.error(
      'Usage: pnpm --filter @lingxi/gateway exec tsx ../../scripts/seed-kv-secrets.ts <dev|prod> [--force] [--dry-run]',
    );
    process.exit(1);
  }
  return {
    env,
    force: argv.includes('--force'),
    dryRun: argv.includes('--dry-run'),
  };
};

interface AzResult {
  ok: boolean;
  out: string;
  err: string;
}

const az = (args: string[]): AzResult => {
  const r = spawnSync('az', args, { encoding: 'utf8' });
  if (r.error) {
    console.error(`Failed to spawn az: ${r.error.message}`);
    console.error('Install Azure CLI: https://aka.ms/azure-cli');
    process.exit(1);
  }
  return {
    ok: r.status === 0,
    out: (r.stdout ?? '').trim(),
    err: (r.stderr ?? '').trim(),
  };
};

const azRequire = (args: string[], context: string): string => {
  const r = az(args);
  if (!r.ok) {
    console.error(`\n${context} 失败:\n  az ${args.join(' ')}\n  ${r.err}`);
    process.exit(1);
  }
  return r.out;
};

const secretExists = (kv: string, name: string): boolean =>
  az([
    'keyvault', 'secret', 'show',
    '--vault-name', kv,
    '--name', name,
    '--query', 'value',
    '-o', 'tsv',
  ]).ok;

const setSecret = (kv: string, name: string, value: string): void => {
  const r = az([
    'keyvault', 'secret', 'set',
    '--vault-name', kv,
    '--name', name,
    '--value', value,
    '--output', 'none',
  ]);
  if (!r.ok) {
    console.error(`✗ az keyvault secret set ${name} 失败: ${r.err}`);
    process.exit(1);
  }
};

const listSecretNames = (kv: string): string[] => {
  const out = azRequire(
    ['keyvault', 'secret', 'list', '--vault-name', kv, '--query', '[].name', '-o', 'tsv'],
    `list secrets in ${kv}`,
  );
  return out.split('\n').filter(Boolean);
};

const generateValue = (cmd: string): string => {
  const parts = cmd.split(/\s+/);
  const bin = parts[0];
  const args = parts.slice(1);
  if (!bin) throw new Error(`empty generate cmd`);
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`✗ generate 命令失败: ${cmd}\n${r.stderr}`);
    process.exit(1);
  }
  return (r.stdout ?? '').trim();
};

const promptValue = async (rl: Interface, hint: string): Promise<string> => {
  for (;;) {
    const v = (await rl.question(`  ▸ paste value (${hint}): `)).trim();
    if (v) return v;
    console.log('    (空值, 重输; Ctrl+C 放弃)');
  }
};

interface Stats {
  set: number;
  skipped: number;
  forced: number;
}

const seed = async (
  kv: string,
  rl: Interface,
  force: boolean,
  dryRun: boolean,
): Promise<Stats> => {
  const entries = Object.entries(KV_SECRETS) as [KvSecretName, KvSecretSpec][];
  const stats: Stats = { set: 0, skipped: 0, forced: 0 };

  let i = 0;
  for (const [name, spec] of entries) {
    i++;
    console.log(`\n[${i}/${entries.length}] ${name}`);
    console.log(`  · ${spec.description}`);
    console.log(`  · source: ${spec.source}`);
    console.log(`  · consumers: ${spec.consumers.join(', ')}`);

    const exists = secretExists(kv, name);
    if (exists && !force) {
      console.log('  · ✓ EXISTS — skip (--force 可覆盖)');
      stats.skipped++;
      continue;
    }
    if (exists) {
      console.log('  · ⚠ EXISTS — 覆盖中 (--force)');
      stats.forced++;
    } else {
      console.log('  · ✗ MISSING');
    }

    let value: string;
    switch (spec.seed.kind) {
      case 'generate':
        console.log(`  · seed: generate \`${spec.seed.cmd}\``);
        value = generateValue(spec.seed.cmd);
        break;
      case 'placeholder':
        console.log(`  · seed: placeholder \`${spec.seed.value}\``);
        value = spec.seed.value;
        break;
      case 'prompt':
        console.log('  · seed: prompt');
        value = await promptValue(rl, spec.seed.hint);
        break;
    }

    if (dryRun) {
      console.log(`  · (dry-run) 将 set ${value.length} chars, 跳过`);
    } else {
      setSecret(kv, name, value);
      console.log(`  · ✓ set (${value.length} chars)`);
      stats.set++;
    }
  }
  return stats;
};

const reportOrphans = (kv: string): void => {
  console.log('\n── Orphan check ──');
  const actualNames = listSecretNames(kv);
  const orphans = actualNames.filter((n) => !Object.hasOwn(KV_SECRETS, n));
  if (orphans.length === 0) {
    console.log('  · ✓ KV 没有 manifest 之外的 secret');
    return;
  }
  console.log(`  ⚠ KV 有 ${orphans.length} 条 secret 不在 manifest 里:`);
  for (const o of orphans) {
    console.log(`    - ${o}    (确认无人消费再 az keyvault secret delete)`);
  }
};

const main = async (): Promise<void> => {
  const { env, force, dryRun } = parseArgs();
  const kv = `kv-lingxi-${env}`;

  const accountJson = az(['account', 'show', '-o', 'json']);
  if (!accountJson.ok) {
    console.error('`az account show` 失败 — 先跑 az login。');
    process.exit(1);
  }
  const account = JSON.parse(accountJson.out) as { name: string; id: string };

  if (!az(['keyvault', 'show', '--name', kv, '--query', 'name', '-o', 'tsv']).ok) {
    console.error(
      `KeyVault ${kv} 在当前 subscription "${account.name}" 下没找到。\n` +
        `   subscription 选错了? 跑 \`az account list -o table\` 看看。`,
    );
    process.exit(1);
  }

  console.log(`Target KV   : ${kv}`);
  console.log(`Subscription: ${account.name} (${account.id})`);
  if (force) console.log('Mode        : --force (覆盖现有)');
  if (dryRun) console.log('Mode        : --dry-run (不写)');

  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    if (env === 'prod' && !dryRun) {
      const ok = (await rl.question(
        '\n⚠ 目标是 PROD。输入 "yes" 继续: ',
      )).trim();
      if (ok !== 'yes') {
        console.log('已放弃。');
        return;
      }
    }

    const stats = await seed(kv, rl, force, dryRun);
    reportOrphans(kv);

    console.log('\n── Summary ──');
    console.log(`  set     : ${stats.set}`);
    console.log(`  forced  : ${stats.forced}`);
    console.log(`  skipped : ${stats.skipped}`);
    console.log('\nDone.');
  } finally {
    rl.close();
  }
};

main().catch((err) => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
