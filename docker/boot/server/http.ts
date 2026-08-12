import { DEFAULT_SESSION, DEFAULT_SOURCE } from './config.ts';
import { requireBearer } from './auth.ts';
import { runAsyncChatAndCallback } from './callback.ts';
import { handleInboxFile, handleInboxImage } from './inbox.ts';
import { log } from './logger.ts';
import type { AgentRuntime } from '../../runtime/types.ts';

type ApplyEntitlements = (desired: string[]) => Promise<string[]> | string[];

interface ChatRequestBody {
  message?: string;
  session_id?: string;
  source?: string;
  callback?: { loop_id?: unknown } | null;
}

interface ResyncRequestBody {
  entitlements?: string[];
  token_version?: number;
}

export function createHandler(runtime: AgentRuntime): (req: Request) => Promise<Response> {
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/health') return Response.json({ status: 'ok' });

    const denied = requireBearer(req);
    if (denied) return denied;

    if (req.method === 'POST' && url.pathname === '/internal/resync-entitlements') {
      return handleResyncEntitlements(req, (desired) => runtime.applyEntitlements(desired));
    }
    if (req.method === 'POST' && url.pathname === '/chat') return handleChat(runtime, req);
    if (req.method === 'POST' && url.pathname === '/inbox/image') return handleInboxImage(req);
    if (req.method === 'POST' && url.pathname === '/inbox/file') return handleInboxFile(req);
    if (req.method === 'DELETE' && url.pathname === '/session') return handleDeleteSession(runtime, url);
    return Response.json({ error: 'not found' }, { status: 404 });
  };
}

async function handleChat(runtime: AgentRuntime, req: Request): Promise<Response> {
  let body: ChatRequestBody;
  try {
    body = await req.json() as ChatRequestBody;
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }

  const message = (body.message ?? '').trim();
  if (!message) return Response.json({ error: "missing 'message'" }, { status: 400 });
  const sessionId = (body.session_id ?? DEFAULT_SESSION).trim();
  const source = (body.source ?? DEFAULT_SOURCE).trim();
  const callbackLoopId = body.callback?.loop_id;
  if (typeof callbackLoopId !== 'string' || !callbackLoopId.trim()) {
    return Response.json({ error: "missing 'callback.loop_id'" }, { status: 400 });
  }
  const loopId = callbackLoopId.trim();

  runAsyncChatAndCallback(runtime, message, sessionId, source, loopId).catch((error) => {
    const err = error instanceof Error ? error.message : String(error);
    log.error({ event: 'chat.async.unhandled', loop_id: loopId, err });
  });
  return Response.json({ accepted: true }, { status: 202 });
}

async function handleDeleteSession(runtime: AgentRuntime, url: URL): Promise<Response> {
  const sessionId = (url.searchParams.get('session_id') ?? '').trim();
  if (!sessionId) return Response.json({ error: "missing 'session_id'" }, { status: 400 });

  try {
    const result = await runtime.deleteSession(sessionId);
    return Response.json(result.deleted
      ? { ok: true, deleted: true, hermes_session_id: result.sessionId }
      : { ok: true, deleted: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes('timeout') ? 504 : 500;
    const stderr = error instanceof Error && typeof (error as Error & { stderr?: unknown }).stderr === 'string'
      ? { stderr: (error as Error & { stderr: string }).stderr }
      : {};
    log.error({ event: 'session.delete', session: sessionId, status: 'error', err: message });
    return Response.json({ error: message, ...stderr }, { status });
  }
}

export async function handleResyncEntitlements(
  req: Request,
  apply: ApplyEntitlements,
): Promise<Response> {
  let body: ResyncRequestBody;
  try {
    body = await req.json() as ResyncRequestBody;
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }

  const desired = Array.isArray(body.entitlements) ? body.entitlements : [];
  const tokenVersion = typeof body.token_version === 'number' ? body.token_version : 0;
  try {
    const observed = await apply(desired);
    return Response.json({ observed, token_version: tokenVersion });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ event: 'resync.entitlements.failed', err: message });
    return Response.json({ error: message }, { status: 500 });
  }
}
