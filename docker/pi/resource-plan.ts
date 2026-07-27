import { existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_DIR } from '../boot/scripts/lib.ts';

const HERMES_SKILLS_DIR = join(HOME_DIR, '.hermes', 'skills');

interface RuntimeResource {
  source?: string;
  package?: string;
  skillPath?: string;
  entitlement?: string;
}

const IMAGE_RESOURCES: readonly RuntimeResource[] = [
  { source: '/app/pi/packages/hermes-memory' },
  { package: 'pi-web-access' },
  { package: 'pi-subagents' },
  { entitlement: 'email', skillPath: '/app/skills/email' },
  { entitlement: 'cloud', skillPath: '/app/skills/cloud' },
];

export interface RuntimeResourcePlan {
  packageRoots: string[];
  skillPaths: string[];
  observedEntitlements: string[];
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

function packageRoot(resource: RuntimeResource): string | null {
  if (resource.source) return resource.source;
  if (!resource.package) return null;
  return dirname(fileURLToPath(import.meta.resolve(resource.package)));
}

/**
 * Resolves image-owned packages and skills for one Pi runtime without mutating Pi settings.
 * Package code must already be present in the immutable image; this never installs or downloads.
 */
export async function resolveRuntimeResources(
  desiredEntitlements: readonly string[],
): Promise<RuntimeResourcePlan> {
  const desired = new Set(desiredEntitlements);
  const enabled = IMAGE_RESOURCES
    .filter((resource) => resource.entitlement === undefined || desired.has(resource.entitlement));
  const packageRoots = unique(enabled.map(packageRoot).filter((path): path is string => path !== null));
  const skillPaths = unique(enabled.flatMap((resource) => resource.skillPath ? [resource.skillPath] : []));

  if (existsSync(HERMES_SKILLS_DIR)) skillPaths.push(HERMES_SKILLS_DIR);
  await Promise.all([...packageRoots, ...skillPaths].map((path) => access(path)));

  return {
    packageRoots,
    skillPaths: unique(skillPaths),
    observedEntitlements: enabled.flatMap((resource) => resource.entitlement ? [resource.entitlement] : []).sort(),
  };
}

function sameStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function sameResourcePlans(left: RuntimeResourcePlan | null, right: RuntimeResourcePlan): boolean {
  return left !== null
    && sameStringArrays(left.packageRoots, right.packageRoots)
    && sameStringArrays(left.skillPaths, right.skillPaths)
    && sameStringArrays(left.observedEntitlements, right.observedEntitlements);
}
