import { afterEach, expect, test } from 'bun:test';

import { HermesRuntime } from '../hermes/runtime.ts';
import { PiRuntime } from '../pi/runtime.ts';
import { createRuntime } from './select.ts';

const initialRuntime = process.env.LINGXI_AGENT_RUNTIME;

afterEach(() => {
  if (initialRuntime === undefined) delete process.env.LINGXI_AGENT_RUNTIME;
  else process.env.LINGXI_AGENT_RUNTIME = initialRuntime;
});

test('defaults to Hermes runtime', () => {
  delete process.env.LINGXI_AGENT_RUNTIME;
  expect(createRuntime()).toBeInstanceOf(HermesRuntime);
});

test('rejects unsupported runtime names instead of falling back', () => {
  process.env.LINGXI_AGENT_RUNTIME = 'unknown';
  expect(() => createRuntime()).toThrow('invalid LINGXI_AGENT_RUNTIME: unknown');
});

test('selects Pi runtime only when explicitly requested', () => {
  process.env.LINGXI_AGENT_RUNTIME = 'pi';
  expect(createRuntime()).toBeInstanceOf(PiRuntime);
});
