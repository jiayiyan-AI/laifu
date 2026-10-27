import { describe, it, expect, vi, beforeEach } from 'vitest';

const { compactHermesSession } = vi.hoisted(() => ({ compactHermesSession: vi.fn() }));
vi.mock('../../src/lib/aca-call.js', () => ({ compactHermesSession }));

import { compactThreadSession, COMPACT_TIMEOUT_MS } from '../../src/lib/compact-session.js';

const input = { userId: 'u1', threadId: 'thr_1', source: 'feishu', containerUrl: 'http://c' };

describe('compactThreadSession', () => {
  beforeEach(() => vi.clearAllMocks());

  it('按 `${source}:${threadId}` 调容器并带超时', async () => {
    compactHermesSession.mockResolvedValue({ ok: true, status: 'nothing' });
    await compactThreadSession(input);
    expect(compactHermesSession).toHaveBeenCalledWith({ ...input, sessionId: 'feishu:thr_1', timeoutMs: COMPACT_TIMEOUT_MS });
  });

  it.each([
    [{ ok: true, status: 'compacted', tokensBefore: 895_488, tokensAfter: 31_000 }, '约 89.5万 → 约 3.1万 tokens'],
    [{ ok: true, status: 'compacted', tokensBefore: 50_000, tokensAfter: null }, '约 5.0万 tokens'],
    [{ ok: true, status: 'nothing' }, '无需压缩'],
    [{ ok: true, status: 'no_session' }, '还没有可压缩的内容'],
    [{ ok: true, status: 'unsupported' }, '不支持手动压缩'],
    [{ ok: false, timedOut: true, status: 0, error: 'timeout' }, '仍在后台继续'],
    [{ ok: false, timedOut: false, status: 404, error: 'http 404' }, '暂不支持手动压缩'],
    [{ ok: false, timedOut: false, status: 500, error: 'http 500' }, '压缩失败'],
  ])('渲染结果 %o', async (result, expected) => {
    compactHermesSession.mockResolvedValue(result);
    expect(await compactThreadSession(input)).toContain(expected);
  });
});
