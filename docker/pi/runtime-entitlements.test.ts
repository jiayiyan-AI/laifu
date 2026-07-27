import { expect, test } from 'bun:test';

test('recreates cached sessions when the entitlement resource plan changes', async () => {
  const child = Bun.spawn([
    'bun',
    '-e',
    `import { mock } from 'bun:test'; mock.module('./pi/resource-plan.ts', () => ({ resolveRuntimeResources: async (desired) => ({ packageRoots: [], skillPaths: desired, observedEntitlements: desired }) })); const { PiRuntime } = await import('./pi/runtime.ts'); const runtime = new PiRuntime(); const sessions = Reflect.get(runtime, 'sessions'); if (!(sessions instanceof Map)) throw new Error('PiRuntime session cache is unavailable'); let disposed = 0; const session = { dispose: () => { disposed++; } }; sessions.set('thread', session); await runtime.applyEntitlements(['email']); sessions.set('thread-2', session); await runtime.applyEntitlements(['email']); if (disposed !== 1 || sessions.size !== 1) throw new Error('unchanged plan recreated a session');`,
  ], {
    cwd: process.cwd(),
    stderr: 'pipe',
    stdout: 'pipe',
  });

  expect(await child.exited).toBe(0);
});
