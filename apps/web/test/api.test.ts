import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as api from '../src/lib/api.js';

describe('api client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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

  it('sendChat returns user_msg_id and loop_id', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ user_msg_id: 'msg_abc', loop_id: 'loop_xyz' })),
    );
    const res = await api.sendChat({ thread_id: 'thr_1', message: 'hi' });
    expect(res.user_msg_id).toBe('msg_abc');
    expect(res.loop_id).toBe('loop_xyz');
  });
});
