import { afterEach, expect, test, vi } from 'vitest';

const USER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const runtime = process.env['LINGXI_AGENT_RUNTIME'];

afterEach(() => {
  if (runtime === undefined) delete process.env['LINGXI_AGENT_RUNTIME'];
  else process.env['LINGXI_AGENT_RUNTIME'] = runtime;
  vi.resetModules();
});

test('selects Pi runtime without adding Pi configuration to ACA', async () => {
  process.env['LINGXI_AGENT_RUNTIME'] = 'pi';
  const { buildSpec } = await import('../../src/provisioning/azure.js');
  const env = buildSpec(USER, 'token').template?.containers?.[0]?.env ?? [];
  const value = (name: string) => env.find((entry) => entry.name === name);

  expect(value('LINGXI_AGENT_RUNTIME')?.value).toBe('pi');
  expect(value('PI_PROVIDER')).toBeUndefined();
  expect(value('PI_MODEL')).toBeUndefined();
  expect(value('PI_BASE_URL')).toBeUndefined();
  expect(value('PI_API_KEY')).toBeUndefined();
});
