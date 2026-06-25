import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

const { deleteHermesSession } = vi.hoisted(() => ({
  deleteHermesSession: vi.fn(async () => ({ ok: true, status: 200, deleted: true })),
}));
vi.mock('../../src/lib/aca-call.js', () => ({ deleteHermesSession }));

import { dao } from '../../src/db/index.js';
import { dropThreadSilently } from '../../src/lib/drop-thread.js';

describe('dropThreadSilently', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('有 containerUrl: 并行删 DB + 容器 session (sessionId=source:threadId)', () => {
    dropThreadSilently({ userId: 'u1', threadId: 't1', source: 'wechat', containerUrl: 'http://c:8080' });
    // 两个删除都在调用内同步发起 (fire-and-forget), 无需等待
    expect(dao.threads.deleteById).toHaveBeenCalledWith('t1', 'u1');
    expect(deleteHermesSession).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deleteHermesSession).mock.calls[0]![0]).toMatchObject({
      containerUrl: 'http://c:8080',
      userId: 'u1',
      threadId: 't1',
      source: 'wechat',
      sessionId: 'wechat:t1',
    });
  });

  it('containerUrl=null: 只删 DB, 跳过容器侧', () => {
    dropThreadSilently({ userId: 'u1', threadId: 't2', source: 'feishu', containerUrl: null });
    expect(dao.threads.deleteById).toHaveBeenCalledWith('t2', 'u1');
    expect(deleteHermesSession).not.toHaveBeenCalled();
  });

  it('fire-and-forget: 不抛、立即返回 (返回值为 undefined)', () => {
    const ret = dropThreadSilently({ userId: 'u1', threadId: 't3', source: 'feishu', containerUrl: 'http://c:8080' });
    expect(ret).toBeUndefined();
  });
});
