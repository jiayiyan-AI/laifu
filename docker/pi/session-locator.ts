import { rm } from 'node:fs/promises';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { delPiSession, getPiSession, putPiSession } from './session-map.ts';
import { ensurePiWorkspace } from './workspace.ts';

export async function createPiSessionManager(gatewaySessionId: string): Promise<SessionManager> {
  const manager = SessionManager.create(await ensurePiWorkspace());
  const path = manager.getSessionFile();
  if (!path) throw new Error('Pi session manager did not create a session file path');

  await putPiSession(gatewaySessionId, { sessionId: manager.getSessionId(), path });
  return manager;
}

export async function openPiSessionManager(gatewaySessionId: string): Promise<SessionManager | null> {
  const mapped = await getPiSession(gatewaySessionId);
  if (!mapped) return null;

  try {
    const manager = SessionManager.open(mapped.path);
    if (manager.getSessionId() === mapped.sessionId) return manager;
  } catch {
    // The mapping is stale or does not point to a Pi session.
  }

  await delPiSession(gatewaySessionId);
  return null;
}

export async function deletePiSessionManager(gatewaySessionId: string): Promise<string | null> {
  const mapped = await getPiSession(gatewaySessionId);
  if (!mapped) return null;

  try {
    await rm(mapped.path);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT') throw error;
    await delPiSession(gatewaySessionId);
    return null;
  }

  await delPiSession(gatewaySessionId);
  return mapped.sessionId;
}
