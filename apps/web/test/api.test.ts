import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as api from '../src/lib/api.js';

describe('api client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('devLogin POSTs with credentials and returns user', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ user_id: 'u1', wx_unionid: 'wx_1', nickname: null, avatar_url: null })),
    );
    const res = await api.devLogin({ wx_unionid: 'wx_1' });
    expect(res.user_id).toBe('u1');
    expect(fetchSpy).toHaveBeenCalledWith('/api/auth/dev/login', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
    }));
  });

  it('me throws AuthError on 401', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 401 }));
    await expect(api.me()).rejects.toThrow(api.AuthError);
  });

  it('purchase returns provisioning shape', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ user_id: 'u1', status: 'provisioning' })),
    );
    const res = await api.purchase();
    expect(res.status).toBe('provisioning');
  });

  it('status returns 404 as null (no row)', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 404 }));
    const res = await api.status();
    expect(res).toBeNull();
  });

  it('createThread POSTs body and returns row', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'thr_1', user_id: 'u1', source: 'web', title: 't', created_at: 'x', updated_at: 'x', archived: false })),
    );
    const res = await api.createThread({ title: 't' });
    expect(res.id).toBe('thr_1');
    expect(fetchSpy.mock.calls[0]![0]).toBe('/api/threads');
  });

  it('listThreads returns array of items', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ threads: [{ id: 'thr_1', title: 't', updated_at: 'x', archived: false }] })),
    );
    const res = await api.listThreads();
    expect(res).toHaveLength(1);
    expect(res[0]!.id).toBe('thr_1');
  });

  it('startChat returns stream_id', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ stream_id: 'stm_abc' })),
    );
    const res = await api.startChat({ thread_id: 'thr_1', message: 'hi' });
    expect(res.stream_id).toBe('stm_abc');
  });
});
