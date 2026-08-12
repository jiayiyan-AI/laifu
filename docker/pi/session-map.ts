import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface PiSessionMapEntry {
  sessionId: string;
  path: string;
}

type PiSessionMap = Record<string, PiSessionMapEntry>;

const SESSION_MAP_FILE_NAME = 'lingxi-session-map.json';
let cachedMap: PiSessionMap | null = null;
let mapLock: Promise<unknown> = Promise.resolve();

function withMapLock<T>(operation: () => Promise<T>): Promise<T> {
  const next = mapLock.then(operation, operation);
  mapLock = next.catch(() => {});
  return next;
}

export function getPiSessionMapFile(): string {
  return join(dirname(getAgentDir()), SESSION_MAP_FILE_NAME);
}

async function loadMap(): Promise<PiSessionMap> {
  if (cachedMap) return cachedMap;

  try {
    cachedMap = JSON.parse(await readFile(getPiSessionMapFile(), 'utf8')) as PiSessionMap;
  } catch {
    cachedMap = {};
  }
  return cachedMap;
}

async function saveMap(map: PiSessionMap): Promise<void> {
  const mapFile = getPiSessionMapFile();
  await mkdir(dirname(mapFile), { recursive: true, mode: 0o700 });
  const temporary = `${mapFile}.tmp`;
  await writeFile(temporary, JSON.stringify(map, null, 2), { mode: 0o600 });
  await rename(temporary, mapFile);
}

export function getPiSession(gatewaySessionId: string): Promise<PiSessionMapEntry | null> {
  return withMapLock(async () => {
    const session = (await loadMap())[gatewaySessionId];
    return session ? { ...session } : null;
  });
}

export function putPiSession(gatewaySessionId: string, session: PiSessionMapEntry): Promise<void> {
  return withMapLock(async () => {
    const map = await loadMap();
    map[gatewaySessionId] = session;
    await saveMap(map);
  });
}

export function delPiSession(gatewaySessionId: string): Promise<void> {
  return withMapLock(async () => {
    const map = await loadMap();
    if (!(gatewaySessionId in map)) return;
    delete map[gatewaySessionId];
    await saveMap(map);
  });
}
