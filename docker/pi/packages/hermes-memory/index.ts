import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  MEMORY_LIMITS,
  loadMemorySnapshot,
  mutateMemory,
  renderMemorySnapshot,
  resolveHermesMemoryPaths,
  type MemorySnapshot,
} from './memory-store.ts';

const snapshots = new Map<string, MemorySnapshot>();
const paths = resolveHermesMemoryPaths();

const sessionKey = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();

export default function hermesMemory(pi: ExtensionAPI): void {
  pi.on('session_start', async (_event, ctx) => {
    snapshots.set(sessionKey(ctx), loadMemorySnapshot(paths));
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    snapshots.delete(sessionKey(ctx));
  });

  pi.on('before_agent_start', async (event, ctx) => {
    const key = sessionKey(ctx);
    const snapshot = snapshots.get(key) ?? loadMemorySnapshot(paths);
    snapshots.set(key, snapshot);
    const prompt = renderMemorySnapshot(snapshot);
    return prompt ? { systemPrompt: `${event.systemPrompt}\n\n${prompt}` } : undefined;
  });

  pi.registerTool({
    name: 'memory',
    label: 'Memory',
    description: 'Maintain durable USER PROFILE and MEMORY entries. SOUL is read-only identity context.',
    promptSnippet: 'Maintain durable USER PROFILE and MEMORY entries.',
    promptGuidelines: [
      'Use memory only for durable user preferences, environment facts, conventions, corrections, and decisions.',
      'Do not store secrets, raw data dumps, temporary paths, or content already present in SOUL or project context files.',
      'Use a unique oldText substring when replacing or removing an existing entry.',
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal('add'), Type.Literal('replace'), Type.Literal('remove')]),
      target: Type.Union([Type.Literal('user'), Type.Literal('memory')]),
      content: Type.Optional(Type.String()),
      oldText: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      try {
        const result = mutateMemory(paths, params);
        return {
          content: [{ type: 'text', text: `${result.message} ${result.target}: ${result.chars}/${result.limit} characters.` }],
          details: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: message }],
          details: {
            changed: false,
            target: params.target,
            entries: [],
            chars: 0,
            limit: MEMORY_LIMITS[params.target],
            message,
          },
          isError: true,
        };
      }
    },
  });
}
