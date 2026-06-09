import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { PromptsManifest } from '@lingxi/shared';

/** 协议版本; 字段语义不兼容变更时 bump, 容器侧脚本会按版本号决定怎么解析。 */
export const PROMPTS_PROTOCOL_VERSION = 1;

/**
 * 内存里的 prompt 仓库: 启动时一次性扫盘, 之后只在内存里查。
 * 改 prompt 必须 redeploy gateway (跟 git/build 流程对齐, 不做 fs.watch)。
 *
 * 详见 docs/managed-prompts.md。
 */
export interface PromptStore {
  /** name → 文件内容 (UTF-8 文本) */
  getContent(name: string): string | undefined;
  /** 给 runtime-config 下发的 manifest, 含协议版本 */
  manifest(): PromptsManifest;
  /** 全部文件名 (调试用) */
  list(): string[];
}

/**
 * 扫给定目录下所有顶层 .md 文件, 算 sha256[:16]。
 * 不递归 (设计上 prompts/ 就是平铺)。目录不存在 → 空 store, 不报错。
 */
export function loadPromptStore(dir: string): PromptStore {
  const files = new Map<string, string>();
  const shas = new Map<string, string>();

  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    // 目录不存在或不可读 — 视为空仓库
    return makeStore(files, shas);
  }

  for (const name of names) {
    const p = join(dir, name);
    try {
      if (!statSync(p).isFile()) continue;
    } catch {
      continue;
    }
    const content = readFileSync(p, 'utf8');
    files.set(name, content);
    const sha = createHash('sha256').update(content).digest('hex').slice(0, 16);
    shas.set(name, sha);
  }

  console.log(`[prompts] loaded ${files.size} file(s) from ${dir}: ${[...files.keys()].join(', ') || '(none)'}`);
  return makeStore(files, shas);
}

function makeStore(files: Map<string, string>, shas: Map<string, string>): PromptStore {
  return {
    getContent: (name) => files.get(name),
    manifest: () => ({
      version: PROMPTS_PROTOCOL_VERSION,
      files: Object.fromEntries(shas),
    }),
    list: () => [...files.keys()],
  };
}
