import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { provisionContainerLocal } from '../../src/provisioning/local.js';

// 测试隔离: 把 HOME 指到临时目录。
const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `${process.env.TMPDIR || '/tmp'}/lingxi-local-test-${process.pid}`.replace(/\/{2,}/g, '/'),
}));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

vi.mock('node:child_process', () => ({
  exec: vi.fn((_cmd: string, cb: any) => cb(null, { stdout: 'true\n', stderr: '' })),
}));

import { signTokenAndInjectLocal, restartContainerAppLocal } from '../../src/provisioning/local.js';

const TOKEN_PATH = path.join(homedir(), '.hermes-dev', '.hermes', '.laifu_user_token');

afterAll(async () => {
  await fs.rm(TEST_HOME, { recursive: true, force: true });
});

const finalReadyRow = {
  user_id: 'u1',
  container_name: 'hermes-u1',
  azure_files_share: 'user-u1',
  status: 'ready' as const,
  container_url: 'http://localhost:8080',
  provisioning_step: '灵犀助理上岗完成',
  progress_pct: 100,
  error_message: null,
  created_at: new Date().toISOString(),
  ready_at: new Date().toISOString(),
};

describe('provisionContainerLocal', () => {
  let mockMappingDao: any;
  let mockUsersDao: any;
  let mockCache: any;

  beforeEach(() => {
    mockMappingDao = {
      insert: vi.fn(async () => {}),
      getByUserId: vi.fn(async () => finalReadyRow),
      listByStatus: vi.fn(async () => []),
      updateStep: vi.fn(async () => {}),
      markReady: vi.fn(async () => {}),
      markFailed: vi.fn(async () => {}),
    };
    mockUsersDao = {
      getById: vi.fn(async () => null),
      getTokenVersion: vi.fn(async () => 0),
      upsertByProvider: vi.fn(async () => null),
    };
    mockCache = { set: vi.fn(), delete: vi.fn() };
  });

  it('walks 6 steps and marks ready with localhost URL', async () => {
    await provisionContainerLocal({
      userId: 'u1',
      mappingDao: mockMappingDao,
      usersDao: mockUsersDao,
      cache: mockCache,
      localContainerUrl: 'http://localhost:8080',
      stepDelayMs: 0,
    });

    // updateStep called for intermediate steps (5 steps before ready)
    expect(mockMappingDao.updateStep.mock.calls.length).toBeGreaterThanOrEqual(5);
    // markReady called
    expect(mockMappingDao.markReady).toHaveBeenCalledWith('u1', 'http://localhost:8080', '灵犀助理上岗完成', 100);
    expect(mockCache.set).toHaveBeenCalled();
  });
});

describe('signTokenAndInjectLocal', () => {
  beforeEach(async () => {
    await fs.rm(TOKEN_PATH, { force: true });
  });

  it('writes a signed JWT to ~/.hermes-dev/.hermes/.laifu_user_token', async () => {
    await signTokenAndInjectLocal('6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f', 3);
    const written = await fs.readFile(TOKEN_PATH, 'utf8');
    expect(written.split('.').length).toBe(3);
  });
});

describe('restartContainerAppLocal', () => {
  it('calls docker inspect then docker restart when container is running', async () => {
    const { exec } = await import('node:child_process');
    const mockExec = vi.mocked(exec);
    mockExec.mockReset();
    mockExec.mockImplementationOnce((_cmd: any, cb: any) => cb(null, { stdout: 'true\n', stderr: '' }) as any);
    mockExec.mockImplementationOnce((_cmd: any, cb: any) => cb(null, { stdout: '', stderr: '' }) as any);

    await restartContainerAppLocal('any-uuid');

    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec.mock.calls[0]![0]).toContain('docker inspect');
    expect(mockExec.mock.calls[1]![0]).toContain('docker restart');
  });

  it('skips restart silently when container not running', async () => {
    const { exec } = await import('node:child_process');
    const mockExec = vi.mocked(exec);
    mockExec.mockReset();
    mockExec.mockImplementationOnce((_cmd: any, cb: any) => cb(null, { stdout: 'false\n', stderr: '' }) as any);

    await restartContainerAppLocal('any-uuid');
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it('skips restart silently when container not found', async () => {
    const { exec } = await import('node:child_process');
    const mockExec = vi.mocked(exec);
    mockExec.mockReset();
    mockExec.mockImplementationOnce((_cmd: any, cb: any) => cb(new Error('no such container'), null) as any);

    await expect(restartContainerAppLocal('any-uuid')).resolves.toBeUndefined();
  });
});
