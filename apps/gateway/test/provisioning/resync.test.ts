import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { resyncEntitlements } from '../../src/provisioning/manager.js';

const USER = 'u1';
const READY_ROW = {
  user_id: USER,
  container_name: 'hermes-u1',
  azure_files_share: 'user-u1',
  status: 'ready' as const,
  container_url: 'https://hermes-u1.example.com',
  provisioning_step: null,
  progress_pct: 100,
  error_message: null,
  policy_hash: 'oldhash',
  created_at: new Date().toISOString(),
  ready_at: new Date().toISOString(),
  assistant_name: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dao.users.getTokenVersion).mockResolvedValue(3);
  vi.mocked(dao.entitlements.listActive).mockResolvedValue(['email']);
});

describe('resyncEntitlements', () => {
  it('ready container: POSTs desired, persists observed, aligns policy_hash, no bump', async () => {
    vi.mocked(dao.containerMapping.getByUserId).mockResolvedValue(READY_ROW as any);
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ observed: ['email'], token_version: 3 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await resyncEntitlements(USER);

    // 调对了容器端点 + 带 desired + Bearer
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://hermes-u1.example.com/internal/resync-entitlements');
    expect((init as any).method).toBe('POST');
    expect(JSON.parse((init as any).body)).toEqual({ entitlements: ['email'], token_version: 3 });
    expect((init as any).headers.Authorization).toMatch(/^Bearer .+/);

    // observed 落库 + policy_hash 对齐 + 绝不 bump
    expect(dao.observedState.upsert).toHaveBeenCalledWith({
      user_id: USER,
      observed_entitlements: ['email'],
      observed_token_version: 3,
    });
    expect(dao.containerMapping.setPolicyHash).toHaveBeenCalledWith(USER, expect.any(String));
    expect(dao.entitlements.bumpTokenVersion).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('container not ready: early return, no fetch, no observed write', async () => {
    vi.mocked(dao.containerMapping.getByUserId).mockResolvedValue(
      { ...READY_ROW, status: 'provisioning', container_url: null } as any,
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await resyncEntitlements(USER);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(dao.observedState.upsert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('container non-2xx: throws (caller fire-and-forget logs; safety net covers)', async () => {
    vi.mocked(dao.containerMapping.getByUserId).mockResolvedValue(READY_ROW as any);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })));

    await expect(resyncEntitlements(USER)).rejects.toThrow(/503/);
    expect(dao.observedState.upsert).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
