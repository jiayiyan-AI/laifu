import { expect, test } from 'bun:test';

test('Pi resource preparation and entitlement reconciliation do not initialize a model runtime', async () => {
  const child = Bun.spawn([
    'bun',
    '-e',
    `import { mock } from 'bun:test'; mock.module('./pi/resource-plan.ts', () => ({ resolveRuntimeResources: async () => ({ packageRoots: [], skillPaths: [], observedEntitlements: [] }), sameResourcePlans: () => true })); const { PiRuntime } = await import('./pi/runtime.ts'); const runtime = new PiRuntime(); await runtime.prepare(null); await runtime.applyEntitlements([]);`,
  ], {
    cwd: process.cwd(),
    env: process.env,
    stderr: 'pipe',
    stdout: 'pipe',
  });

  expect(await child.exited).toBe(0);
});
