import { expect, test } from 'bun:test';

test('Pi resource preparation and entitlement reconciliation do not initialize a model runtime', async () => {
  const child = Bun.spawn([
    'bun',
    '-e',
    `import { mock } from 'bun:test'; mock.module('./pi/resource-plan.ts', () => ({ resolveRuntimeResources: async () => ({ packageRoots: [], skillPaths: [], observedEntitlements: [] }) })); const { PiRuntime } = await import('./pi/runtime.ts'); const runtime = new PiRuntime(); await runtime.prepare(); await runtime.applyEntitlements([]);`,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_PROVIDER: '',
      PI_MODEL: '',
      PI_API_KEY: '',
      PI_BASE_URL: '',
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });

  expect(await child.exited).toBe(0);
});
