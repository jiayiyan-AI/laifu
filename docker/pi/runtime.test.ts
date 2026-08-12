import { afterAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const workspace = await mkdtemp(path.join(tmpdir(), 'pi-runtime-'));
const originalCwd = process.cwd();
const originalHome = process.env.HOME;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = path.join(workspace, '.pi', 'agent');
process.chdir(workspace);
process.env.HOME = workspace;
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(path.join(agentDir, 'extensions'), { recursive: true });
await writeFile(path.join(agentDir, 'extensions', 'noop.ts'), [
  "import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';",
  '',
  'export default function registerNoop(pi: ExtensionAPI): void {',
  "  pi.registerCommand('noop', { description: 'No-op command', handler: async () => {} });",
  '}',
].join('\n'));

let streamDelayMs = 0;
let activeStreamRequests = 0;
let maxConcurrentStreamRequests = 0;

const server = Bun.serve({
  port: 0,
  async fetch(request): Promise<Response> {
    const body = await request.json() as { stream?: boolean; model?: string };
    if (body.stream) {
      activeStreamRequests++;
      maxConcurrentStreamRequests = Math.max(maxConcurrentStreamRequests, activeStreamRequests);
      try {
        if (streamDelayMs) await Bun.sleep(streamDelayMs);
        const model = body.model ?? 'qwen3-coder-plus';
        const stream = [
          `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { role: 'assistant', content: 'Pi says hello.' }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
          'data: [DONE]\n\n',
        ].join('');
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      } finally {
        activeStreamRequests--;
      }
    }

    return Response.json({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: 'fake-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Pi says hello.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
    });
  },
});

const PI_CONFIG = {
  provider: 'dashscope',
  model: 'qwen3-coder-plus',
  timeoutSeconds: 14_400,
  apiKey: 'test-key',
  baseUrl: `http://127.0.0.1:${server.port}/v1`,
};
const [{ PiRuntime }, { SessionManager, getAgentDir }, { ensurePiWorkspace }, { delPiSession, getPiSession, getPiSessionMapFile, putPiSession }, { savePiModelProfiles }] = await Promise.all([
  import('./runtime.ts'),
  import('@earendil-works/pi-coding-agent'),
  import('./workspace.ts'),
  import('./session-map.ts'),
  import('./model-profiles.ts'),
]);

async function createPiRuntime(piConfig = PI_CONFIG): Promise<InstanceType<typeof PiRuntime>> {
  const runtime = new PiRuntime();
  await runtime.prepare({ pi_config: piConfig });
  return runtime;
}
await savePiModelProfiles({
  revision: 'test',
  providers: [
    {
      provider: 'dashscope',
      name: 'DashScope OpenAI-compatible provider',
      defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      api: 'openai-completions',
      authHeader: true,
      models: [
        {
          model: 'qwen3-coder-plus',
          name: 'Qwen3-Coder-Plus',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000_000,
          maxTokens: 65_536,
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        },
        {
          model: 'qwen3.7-max',
          name: 'Qwen3.7 Max',
          reasoning: true,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000_000,
          maxTokens: 65_536,
          compat: { thinkingFormat: 'qwen', supportsDeveloperRole: false, supportsStore: false },
        },
        {
          model: 'qwen3.7-plus',
          name: 'Qwen3.7 Plus',
          reasoning: true,
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000_000,
          maxTokens: 64_000,
          compat: { thinkingFormat: 'qwen', supportsDeveloperRole: false, supportsStore: false },
        },
      ],
    },
  ],
});

afterAll(async () => {
  server.stop();
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
  await rm(workspace, { recursive: true, force: true });
});

test('runs text chat and physically deletes a file-mapped session', async () => {
  const runtime = await createPiRuntime();
  const result = await runtime.run({ message: 'hello', sessionId: 'thread-1', source: 'web' });

  expect(result).toMatchObject({
    reply: 'Pi says hello.',
    exitCode: 0,
    timedOut: false,
    usage: { provider: 'dashscope' },
  });
  if (!result.sessionId) throw new Error('Pi run did not return a session ID');
  const sessions = await SessionManager.list(await ensurePiWorkspace());
  const session = sessions[0];
  if (!session) throw new Error('Pi session was not persisted');
  const mappings = JSON.parse(await readFile(getPiSessionMapFile(), 'utf8')) as Record<string, { sessionId: string; path: string }>;
  expect(sessions).toHaveLength(1);
  expect(mappings['thread-1']).toEqual({ sessionId: result.sessionId, path: session.path });
  expect(path.isAbsolute(mappings['thread-1']!.path)).toBe(true);
  expect(getPiSessionMapFile()).toBe(path.join(path.dirname(getAgentDir()), 'lingxi-session-map.json'));
  expect(session.name).toBeUndefined();

  const restartedRuntime = await createPiRuntime();
  expect(await restartedRuntime.deleteSession('thread-1')).toMatchObject({ deleted: true });

  expect(await SessionManager.list(await ensurePiWorkspace())).toHaveLength(0);
  expect(JSON.parse(await readFile(getPiSessionMapFile(), 'utf8'))).toEqual({});
}, 20_000);

test('serves Pi session mappings from memory after loading', async () => {
  const entry = { sessionId: 'pi-cache-test', path: '/tmp/pi-cache-test.jsonl' };
  await putPiSession('cache-test', entry);
  await writeFile(getPiSessionMapFile(), '{}');

  expect(await getPiSession('cache-test')).toEqual(entry);

  await delPiSession('cache-test');
  expect(JSON.parse(await readFile(getPiSessionMapFile(), 'utf8'))).toEqual({});
});

test('retries model initialization after Gateway configuration is corrected', async () => {
  const runtime = await createPiRuntime({ ...PI_CONFIG, apiKey: '' });

  await expect(runtime.run({ message: 'first', sessionId: 'thread-5', source: 'web', loopId: 'loop-5a' }))
    .rejects.toThrow('Pi runtime configuration is required from Gateway');

  await runtime.prepare({ pi_config: PI_CONFIG });
  expect(await runtime.run({ message: 'second', sessionId: 'thread-5', source: 'web', loopId: 'loop-5b' }))
    .toMatchObject({ reply: 'Pi says hello.', exitCode: 0, timedOut: false });
}, 20_000);
test('runs the Qwen3.7 Max DashScope profile', async () => {
  const runtime = await createPiRuntime({ ...PI_CONFIG, model: 'qwen3.7-max' });
  const result = await runtime.run({ message: 'hello', sessionId: 'thread-6', source: 'web', loopId: 'loop-6' });

  expect(result).toMatchObject({
    reply: 'Pi says hello.',
    exitCode: 0,
    timedOut: false,
    usage: { model: 'qwen3.7-max', provider: 'dashscope' },
  });
}, 20_000);
test('runs the Qwen3.7 Plus DashScope profile', async () => {
  const runtime = await createPiRuntime({ ...PI_CONFIG, model: 'qwen3.7-plus' });
  const result = await runtime.run({ message: 'hello', sessionId: 'thread-7', source: 'web', loopId: 'loop-7' });

  expect(result).toMatchObject({
    reply: 'Pi says hello.',
    exitCode: 0,
    timedOut: false,
    usage: { model: 'qwen3.7-plus', provider: 'dashscope' },
  });
}, 20_000);
test('serializes concurrent chats for the same Pi session', async () => {
  const runtime = await createPiRuntime();
  streamDelayMs = 50;
  maxConcurrentStreamRequests = 0;

  try {
    const [first, second] = await Promise.all([
      runtime.run({ message: 'first', sessionId: 'thread-3', source: 'web', loopId: 'loop-3a' }),
      runtime.run({ message: 'second', sessionId: 'thread-3', source: 'web', loopId: 'loop-3b' }),
    ]);

    expect(first).toMatchObject({ reply: 'Pi says hello.', exitCode: 0, timedOut: false });
    expect(second).toMatchObject({ reply: 'Pi says hello.', exitCode: 0, timedOut: false });
    expect(maxConcurrentStreamRequests).toBe(1);
  } finally {
    streamDelayMs = 0;
  }
}, 20_000);

test('does not return a prior assistant message after an extension command', async () => {
  const runtime = await createPiRuntime();
  await runtime.run({ message: 'hello', sessionId: 'thread-4', source: 'web', loopId: 'loop-4a' });

  expect(await runtime.run({ message: '/noop', sessionId: 'thread-4', source: 'web', loopId: 'loop-4b' })).toEqual({
    reply: '处理失败，请稍后再试。',
    exitCode: 1,
    usage: {
      model: 'qwen3-coder-plus',
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      provider: 'dashscope',
    },
    sessionId: expect.any(String),
    timedOut: false,
  });
}, 20_000);

test('does not retain a session history while deleting it', async () => {
  const runtime = await createPiRuntime();
  const initial = await runtime.run({ message: 'before delete', sessionId: 'thread-2', source: 'web' });
  const [deleted, replacement] = await Promise.all([
    runtime.deleteSession('thread-2'),
    runtime.run({ message: 'after delete', sessionId: 'thread-2', source: 'web' }),
  ]);

  expect(deleted).toMatchObject({ deleted: true, sessionId: initial.sessionId });
  expect(replacement.sessionId).not.toBe(initial.sessionId);
  const sessions = await SessionManager.list(await ensurePiWorkspace());
  const mapped = await getPiSession('thread-2');
  const session = sessions.find(({ path: sessionPath }) => sessionPath === mapped?.path);
  expect(session?.firstMessage).toBe('after delete');
}, 20_000);
