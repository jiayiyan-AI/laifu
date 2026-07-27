import { afterEach, expect, test, vi } from 'vitest';

const USER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const runtime = process.env['LINGXI_AGENT_RUNTIME'];

afterEach(() => {
  if (runtime === undefined) delete process.env['LINGXI_AGENT_RUNTIME'];
  else process.env['LINGXI_AGENT_RUNTIME'] = runtime;
  vi.resetModules();
});

test('injects global Pi runtime and provider credentials when selected', async () => {
  process.env['LINGXI_AGENT_RUNTIME'] = 'pi';
  const { buildSpec } = await import('../../src/provisioning/azure.js');
  const env = buildSpec(USER, 'token').template?.containers?.[0]?.env ?? [];
  const value = (name: string) => env.find((entry) => entry.name === name);

  expect(value('LINGXI_AGENT_RUNTIME')?.value).toBe('pi');
  expect(value('PI_PROVIDER')?.value).toBeTruthy();
  expect(value('PI_MODEL')?.value).toBeTruthy();
  expect(value('PI_BASE_URL')?.value).toBeTruthy();
  expect(value('PI_API_KEY')?.secretRef).toBe('hermes-api-key');
});
