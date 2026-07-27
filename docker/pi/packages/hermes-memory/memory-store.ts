import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { HERMES_HOME_DIR } from '../../../home.ts';

export const MEMORY_LIMITS = {
  memory: 2_200,
  user: 1_375,
} as const;

export type MemoryTarget = keyof typeof MEMORY_LIMITS;
export type MemoryAction = 'add' | 'replace' | 'remove';

export interface HermesMemoryPaths {
  soul: string;
  memory: string;
  user: string;
}

export interface MemorySnapshot {
  soul: string;
  memory: string;
  user: string;
}

export interface MemoryMutation {
  action: MemoryAction;
  target: MemoryTarget;
  content?: string;
  oldText?: string;
}

export interface MemoryMutationResult {
  changed: boolean;
  target: MemoryTarget;
  entries: string[];
  chars: number;
  limit: number;
  message: string;
}

const ENTRY_SEPARATOR = '\n\n§\n\n';

export function resolveHermesMemoryPaths(
  hermesHome = process.env.HERMES_HOME ?? `${HERMES_HOME_DIR}/.hermes`,
): HermesMemoryPaths {
  return {
    soul: join(hermesHome, 'SOUL.md'),
    memory: join(hermesHome, 'memories', 'MEMORY.md'),
    user: join(hermesHome, 'memories', 'USER.md'),
  };
}

export function loadMemorySnapshot(paths: HermesMemoryPaths): MemorySnapshot {
  return {
    soul: readOptional(paths.soul),
    memory: readOptional(paths.memory),
    user: readOptional(paths.user),
  };
}

export function renderMemorySnapshot(snapshot: MemorySnapshot): string {
  const sections: string[] = [];
  if (snapshot.soul) sections.push(`## SOUL\n${snapshot.soul}`);
  if (snapshot.user) sections.push(`## USER PROFILE\n${snapshot.user}`);
  if (snapshot.memory) sections.push(`## MEMORY\n${snapshot.memory}`);
  if (sections.length === 0) return '';

  return [
    '# Persistent identity and memory',
    ...sections,
    'This is a frozen snapshot for this session. Use the memory tool to add, replace, or remove USER PROFILE and MEMORY entries; changes apply in the next session.',
  ].join('\n\n');
}

export function mutateMemory(paths: HermesMemoryPaths, mutation: MemoryMutation): MemoryMutationResult {
  const path = paths[mutation.target];
  const entries = readOptional(path)
    .split(/\n\s*§\s*\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const content = (mutation.content ?? '').trim();
  const oldText = (mutation.oldText ?? '').trim();
  let next = entries;
  let changed = false;

  switch (mutation.action) {
    case 'add': {
      if (!content) throw new Error('memory add requires non-empty content');
      if (entries.includes(content)) {
        return {
          changed: false,
          target: mutation.target,
          entries,
          chars: serializeEntries(entries).trim().length,
          limit: MEMORY_LIMITS[mutation.target],
          message: 'No duplicate added.',
        };
      }
      next = [...entries, content];
      changed = true;
      break;
    }
    case 'replace': {
      if (!content) throw new Error('memory replace requires non-empty content');
      const index = uniqueMatch(entries, oldText, mutation.action);
      next = entries.map((entry, entryIndex) => entryIndex === index ? content : entry);
      changed = true;
      break;
    }
    case 'remove': {
      const index = uniqueMatch(entries, oldText, mutation.action);
      next = entries.filter((_, entryIndex) => entryIndex !== index);
      changed = true;
      break;
    }
  }

  const serialized = serializeEntries(next);
  ensureLimit(mutation.target, serialized);
  if (changed) writeAtomic(path, serialized);
  return {
    changed,
    target: mutation.target,
    entries: next,
    chars: serialized.trim().length,
    limit: MEMORY_LIMITS[mutation.target],
    message: 'Memory updated. Changes apply in the next session.',
  };
}

const readOptional = (path: string): string => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return '';
    throw error;
  }
};

function serializeEntries(entries: string[]): string {
  return entries.length > 0 ? `${entries.join(ENTRY_SEPARATOR)}\n` : '';
}


const uniqueMatch = (entries: string[], oldText: string, action: MemoryAction): number => {
  if (!oldText) throw new Error(`memory ${action} requires oldText`);
  const matches = entries
    .map((entry, index) => entry.includes(oldText) ? index : -1)
    .filter((index) => index !== -1);
  if (matches.length === 0) throw new Error(`No memory entry matches "${oldText}".`);
  if (matches.length > 1) throw new Error(`Multiple memory entries match "${oldText}". Use a more specific oldText.`);
  return matches[0]!;
};

const ensureLimit = (target: MemoryTarget, content: string): void => {
  const chars = content.trim().length;
  const limit = MEMORY_LIMITS[target];
  if (chars > limit) {
    throw new Error(`${target} memory is ${chars}/${limit} characters. Consolidate or remove entries before saving.`);
  }
}

const writeAtomic = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
};
