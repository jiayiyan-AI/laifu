import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { classifyMessage, runIntercept } from '../../src/lib/slash-filter.js';

describe('classifyMessage', () => {
  it('forwards plain text', () => {
    expect(classifyMessage('你好')).toEqual({ kind: 'forward' });
    expect(classifyMessage('帮我写个 SQL')).toEqual({ kind: 'forward' });
  });

  it('forwards empty / non-string defensively', () => {
    expect(classifyMessage('')).toEqual({ kind: 'forward' });
  });

  it('intercepts /new and friends with reject_session tag', () => {
    for (const cmd of ['new', 'reset', 'clear', 'undo', 'retry', 'sessions', 'quit']) {
      const r = classifyMessage(`/${cmd}`);
      expect(r.kind).toBe('intercept');
      if (r.kind === 'intercept') {
        expect(r.cmd).toBe(cmd);
        expect(r.logTag).toBe('reject_session');
      }
    }
  });

  it('intercepts /model and config-class commands', () => {
    for (const cmd of ['model', 'personality', 'yolo', 'compress', 'snapshot']) {
      const r = classifyMessage(`/${cmd}`);
      expect(r.kind).toBe('intercept');
      if (r.kind === 'intercept') expect(r.logTag).toBe('reject_config');
    }
  });

  it('intercepts /tools /skills /cron etc. with reject_tools tag', () => {
    for (const cmd of ['tools', 'skills', 'cron', 'kanban', 'goal', 'background']) {
      const r = classifyMessage(`/${cmd}`);
      expect(r.kind).toBe('intercept');
      if (r.kind === 'intercept') expect(r.logTag).toBe('reject_tools');
    }
  });

  it('intercepts /help /version /usage /status with gateway_* tags', () => {
    expect((classifyMessage('/help') as { logTag?: string }).logTag).toBe('gateway_help');
    expect((classifyMessage('/version') as { logTag?: string }).logTag).toBe('gateway_version');
    expect((classifyMessage('/usage') as { logTag?: string }).logTag).toBe('gateway_usage');
    expect((classifyMessage('/status') as { logTag?: string }).logTag).toBe('gateway_status');
  });

  it('forwards unknown /<word> commands so Hermes can self-handle', () => {
    expect(classifyMessage('/some-skill')).toEqual({ kind: 'forward' });
    expect(classifyMessage('/randomthing arg1 arg2')).toEqual({ kind: 'forward' });
  });

  it('does NOT misidentify path-like input as slash command', () => {
    // /etc/hosts: 命令名后跟 /,不是空白 → 不匹配
    expect(classifyMessage('/etc/hosts 是什么')).toEqual({ kind: 'forward' });
    expect(classifyMessage('/foo/bar 路径')).toEqual({ kind: 'forward' });
    // // 注释开头
    expect(classifyMessage('// comment')).toEqual({ kind: 'forward' });
    // 数字 / 横杠开头
    expect(classifyMessage('/123foo')).toEqual({ kind: 'forward' });
    expect(classifyMessage('/-flag')).toEqual({ kind: 'forward' });
    // 纯斜杠
    expect(classifyMessage('/')).toEqual({ kind: 'forward' });
    expect(classifyMessage(' / ')).toEqual({ kind: 'forward' });
  });

  it('case-insensitive command names', () => {
    const r1 = classifyMessage('/New');
    const r2 = classifyMessage('/HELP');
    expect(r1.kind).toBe('intercept');
    expect(r2.kind).toBe('intercept');
    if (r1.kind === 'intercept') expect(r1.cmd).toBe('new');
    if (r2.kind === 'intercept') expect(r2.cmd).toBe('help');
  });

  it('captures args after command', () => {
    const r = classifyMessage('/new my-experiment');
    expect(r.kind).toBe('intercept');
    if (r.kind === 'intercept') expect(r.args).toBe('my-experiment');
  });

  it('strips leading whitespace before /', () => {
    const r = classifyMessage('   /reset');
    expect(r.kind).toBe('intercept');
    if (r.kind === 'intercept') expect(r.cmd).toBe('reset');
  });

  it('matches commands across line break (multi-line input)', () => {
    // 用户语义就是想发命令,后续是参数 — 按命令处理
    const r = classifyMessage('/new\n顺便问一下');
    expect(r.kind).toBe('intercept');
    if (r.kind === 'intercept') expect(r.cmd).toBe('new');
  });
});

describe('runIntercept', () => {
  it('renders /help static text', async () => {
    const action = classifyMessage('/help');
    if (action.kind !== 'intercept') throw new Error('expected intercept');
    const out = await runIntercept(action, { userId: 'u1', threadId: 'thr_1' });
    expect(out).toContain('灵犀可用指令');
    expect(out).toContain('/help');
    expect(out).toContain('/usage');
  });

  it('renders /usage with balance from dao', async () => {
    vi.mocked(dao.usage.getBalance).mockResolvedValueOnce({
      balance_cny: 5.5, free_quota_cny_month: 10, used_cny_month: 3.25, period_start: '2026-06-01',
    });
    const action = classifyMessage('/usage');
    if (action.kind !== 'intercept') throw new Error('expected intercept');
    const out = await runIntercept(action, { userId: 'u1', threadId: 'thr_1' });
    expect(out).toContain('¥3.25');
    expect(out).toContain('¥10.00');
    expect(out).toContain('¥5.50');
    expect(out).toContain('2026-06-01');
  });

  it('renders /usage fallback when DAO throws', async () => {
    vi.mocked(dao.usage.getBalance).mockRejectedValueOnce(new Error('db down'));
    const action = classifyMessage('/usage');
    if (action.kind !== 'intercept') throw new Error('expected intercept');
    const out = await runIntercept(action, { userId: 'u1', threadId: 'thr_1' });
    expect(out).toMatch(/暂不可用/);
  });

  it('renders /status with container info', async () => {
    vi.mocked(dao.cache.get).mockReturnValueOnce({
      user_id: 'u1', container_name: 'hermes-u1', container_url: 'http://x',
      status: 'ready', provisioning_step: null, progress_pct: 100,
      error_message: null, azure_files_share: 'user-u1',
      created_at: '2026-01-01', ready_at: '2026-01-01',
    });
    const action = classifyMessage('/status');
    if (action.kind !== 'intercept') throw new Error('expected intercept');
    const out = await runIntercept(action, { userId: 'u1', threadId: 'thr_42' });
    expect(out).toContain('thr_42');
    expect(out).toContain('ready');
  });

  it('renders /status when no container mapping yet', async () => {
    vi.mocked(dao.cache.get).mockReturnValueOnce(null);
    const action = classifyMessage('/status');
    if (action.kind !== 'intercept') throw new Error('expected intercept');
    const out = await runIntercept(action, { userId: 'u1', threadId: 'thr_1' });
    expect(out).toContain('未开通');
  });

  it('returns reject text for /new', async () => {
    const action = classifyMessage('/new');
    if (action.kind !== 'intercept') throw new Error('expected intercept');
    const out = await runIntercept(action, { userId: 'u1', threadId: 'thr_1' });
    expect(out).toMatch(/新对话/);
  });

  it('returns reject text for /model', async () => {
    const action = classifyMessage('/model claude');
    if (action.kind !== 'intercept') throw new Error('expected intercept');
    const out = await runIntercept(action, { userId: 'u1', threadId: 'thr_1' });
    expect(out).toMatch(/模型由后端/);
  });
});
