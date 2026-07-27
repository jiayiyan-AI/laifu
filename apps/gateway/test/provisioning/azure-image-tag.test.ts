import { afterEach, expect, test, vi } from 'vitest';

const USER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const environment = process.env['LAIFU_ENV'];

const imageFor = async (value: string): Promise<string | undefined> => {
  process.env['LAIFU_ENV'] = value;
  vi.resetModules();
  const { buildSpec } = await import('../../src/provisioning/azure.js');
  return buildSpec(USER, 'token').template?.containers?.[0]?.image;
};

afterEach(() => {
  if (environment === undefined) delete process.env['LAIFU_ENV'];
  else process.env['LAIFU_ENV'] = environment;
  vi.resetModules();
});

