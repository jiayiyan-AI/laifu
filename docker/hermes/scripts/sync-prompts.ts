// Prompt 文件同步: 跟远端 manifest diff, 并行下载变化的文件, 写 ~/dynamic_prompts/。
// 副作用: 下载到的 SOUL.md 同时镜像写一份到 ~/.hermes/SOUL.md (hermes 默认读那里)。
//
// 落盘结构 (NFS volume, 持久化):
//   ~/dynamic_prompts/manifest.json     ← 本地"上次已同步"快照, 用来 diff
//   ~/dynamic_prompts/<name>            ← 下载下来的原始文件
//   ~/.hermes/SOUL.md                   ← SOUL.md 的镜像 (hermes 默认读)
//
// 删除策略:
//   - 远端 manifest 里没有的文件 → 删 ~/dynamic_prompts/<name>
//   - 但 ~/.hermes/SOUL.md 永远不动 — 删了 hermes 默认 persona 行为可能异常,
//     一旦镜像过去就保留, 直到下次 SOUL.md 又出现在 manifest 再覆盖。
//
// Manifest 协议:
//   远端: { version: number, files: { name: sha } }
//   本地: { name: sha }  (兼容老格式; 本地不存 version)
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync,
} from 'node:fs';
import { log, warn, readToken, httpJson, HOME_DIR } from './lib.ts';

export const DYNAMIC_DIR = `${HOME_DIR}/dynamic_prompts`;
export const LOCAL_MANIFEST = `${DYNAMIC_DIR}/manifest.json`;
const HERMES_SOUL = `${HOME_DIR}/.hermes/SOUL.md`;

/** 容器侧支持的最高协议版本。远端 version 高于此 → 跳过同步, 不破坏本地。 */
const SUPPORTED_VERSION = 1;

export interface RemoteManifest {
  version?: number;
  files?: Record<string, string>;
}

type FileMap = Record<string, string>;

function readLocalManifest(): FileMap {
  if (!existsSync(LOCAL_MANIFEST)) return {};
  try {
    const raw = JSON.parse(readFileSync(LOCAL_MANIFEST, 'utf8')) as unknown;
    // 老格式 (扁平 { name: sha }) 也接, 一并视为 files
    if (raw && typeof raw === 'object' && 'files' in raw && typeof (raw as { files: unknown }).files === 'object') {
      return (raw as { files: FileMap }).files;
    }
    if (raw && typeof raw === 'object') return raw as FileMap;
    return {};
  } catch (e) {
    warn(`local manifest corrupted, treating as empty: ${(e as Error).message}`);
    return {};
  }
}

async function downloadOne(gateway: string, token: string, name: string): Promise<string> {
  const { status, body } = await httpJson({
    method: 'GET',
    url: `${gateway}/api/me/prompts/${encodeURIComponent(name)}`,
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 10_000,
  });
  if (status < 200 || status >= 300) {
    throw new Error(`HTTP ${status}: ${body.slice(0, 200)}`);
  }
  return body;
}

/**
 * 处理单文件下载副作用 — 主要是 SOUL.md 镜像到 ~/.hermes/SOUL.md。
 * 集中一处方便后续加更多 mirror。
 */
function applyDownloadSideEffect(name: string, content: string): void {
  if (name === 'SOUL.md') {
    writeFileSync(HERMES_SOUL, content);
    log(`mirrored SOUL.md → ~/.hermes/SOUL.md`);
  }
}

/**
 * @param remoteManifest { version, files } 来自 /api/me/runtime-config
 * @returns 实际同步成功的 files map (写回本地用)
 */
export async function syncPrompts(remoteManifest: RemoteManifest | null | undefined): Promise<FileMap> {
  const GATEWAY = process.env['GATEWAY_BASE_URL'] ?? '';
  const token = readToken();
  if (!token) {
    warn('no token — skip prompt sync');
    return readLocalManifest();
  }

  const local = readLocalManifest();

  // 协议版本校验: 不识别的 version 直接跳过, 保留本地。
  const remote = remoteManifest && typeof remoteManifest === 'object' ? remoteManifest : {};
  const remoteVersion = typeof remote.version === 'number' ? remote.version : 0;
  if (remoteVersion > SUPPORTED_VERSION) {
    warn(`remote manifest version ${remoteVersion} > supported ${SUPPORTED_VERSION} — skip sync to avoid corruption`);
    return local;
  }
  const remoteFiles: FileMap = (remote.files && typeof remote.files === 'object') ? remote.files : {};

  mkdirSync(DYNAMIC_DIR, { recursive: true });

  const toDownload: string[] = [];
  const toDelete: string[] = [];
  for (const [name, sha] of Object.entries(remoteFiles)) {
    if (local[name] !== sha) toDownload.push(name);
  }
  for (const name of Object.keys(local)) {
    if (!(name in remoteFiles)) toDelete.push(name);
  }

  if (toDownload.length === 0 && toDelete.length === 0) {
    log(`prompts manifest unchanged (${Object.keys(remoteFiles).length} file(s))`);
    return local;
  }

  log(`prompts to download: ${toDownload.join(', ') || '(none)'}; to delete: ${toDelete.join(', ') || '(none)'}`);

  // 并行下载 (Promise.allSettled: 单个失败不影响其他)
  const synced: FileMap = { ...local };
  const downloadResults = await Promise.allSettled(
    toDownload.map(async (name) => {
      const content = await downloadOne(GATEWAY, token, name);
      writeFileSync(`${DYNAMIC_DIR}/${name}`, content);
      applyDownloadSideEffect(name, content);
      synced[name] = remoteFiles[name];
      log(`downloaded prompt: ${name}`);
    }),
  );
  for (let i = 0; i < downloadResults.length; i++) {
    const r = downloadResults[i];
    if (r.status === 'rejected') {
      // 失败的文件 synced 里不更新 sha, 下次 boot 自动重试
      const reason = r.reason as { message?: string } | string;
      const msg = typeof reason === 'object' && reason?.message ? reason.message : String(reason);
      warn(`download ${toDownload[i]} failed: ${msg}`);
    }
  }

  // 删除: 只动 ~/dynamic_prompts/, 不动 ~/.hermes/ 下的镜像
  for (const name of toDelete) {
    const p = `${DYNAMIC_DIR}/${name}`;
    if (existsSync(p)) {
      try { unlinkSync(p); log(`removed ~/dynamic_prompts/${name}`); }
      catch (e) { warn(`unlink ${name} failed: ${(e as Error).message}`); }
    }
    delete synced[name];
  }

  writeFileSync(LOCAL_MANIFEST, JSON.stringify({ version: SUPPORTED_VERSION, files: synced }, null, 2));
  log(`prompts sync done, ${Object.keys(synced).length} file(s) tracked`);
  return synced;
}

/** 给 render-config 等外部模块读 dynamic prompt 的辅助 (没有就返回 null)。 */
export function readDynamicPrompt(name: string): string | null {
  const p = `${DYNAMIC_DIR}/${name}`;
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}
