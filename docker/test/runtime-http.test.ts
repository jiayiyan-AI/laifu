import { expect, test } from 'bun:test';

import { createHandler } from '../boot/server/http.ts';
import type { AgentRuntime } from '../runtime/types.ts';

function createRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    async prepare(): Promise<void> {},
    async applyEntitlements(desired: string[]): Promise<string[]> { return desired; },
    async run() {
      return {
        reply: 'reply',
        exitCode: 0,
        usage: {
          model: 'test',
          input_tokens: 1,
          output_tokens: 2,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          provider: 'test',
        },
        sessionId: 'runtime-session',
        timedOut: false,
      };
    },
    async deleteSession() { return { deleted: false, sessionId: null }; },
    async abort() {},
    ...overrides,
  };
}

test('accepts chat asynchronously when callback loop ID is present', async () => {
  const seen: string[] = [];
  const handler = createHandler(createRuntime({
    async run(input) {
      seen.push(input.loopId ?? '');
      return {
        reply: 'runtime reply',
        exitCode: 0,
        usage: {
          model: 'test',
          input_tokens: 1,
          output_tokens: 2,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          provider: 'test',
        },
        sessionId: 'runtime-session',
        timedOut: false,
      };
    },
  }));

  const response = await handler(new Request('http://x/chat', {
    method: 'POST',
    body: JSON.stringify({
      message: 'hello',
      session_id: 'thread',
      source: 'web',
      callback: { loop_id: 'loop_123' },
    }),
  }));

  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ accepted: true });
  expect(seen).toEqual(['loop_123']);
});

test('rejects chat without a valid callback loop ID', async () => {
  const handler = createHandler(createRuntime());
  for (const callback of [undefined, {}, { loop_id: '' }, { loop_id: ' ' }, { loop_id: 123 }]) {
    const response = await handler(new Request('http://x/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'hello', callback }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "missing 'callback.loop_id'" });
  }
});

test('does not expose the removed history endpoint', async () => {
  const response = await createHandler(createRuntime())(new Request('http://x/history'));

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'not found' });
});

test('routes entitlement resync through the injected runtime', async () => {
  const seen: string[][] = [];
  const handler = createHandler(createRuntime({
    async applyEntitlements(desired) {
      seen.push(desired);
      return ['email'];
    },
  }));

  const response = await handler(new Request('http://x/internal/resync-entitlements', {
    method: 'POST',
    body: JSON.stringify({ entitlements: ['email', 'cloud'], token_version: 7 }),
  }));

  expect(seen).toEqual([['email', 'cloud']]);
  expect(await response.json()).toEqual({ observed: ['email'], token_version: 7 });
});
