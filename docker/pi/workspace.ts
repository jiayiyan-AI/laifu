import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HERMES_HOME_DIR } from '../home.ts';

export const PI_WORKSPACE_DIR = join(HERMES_HOME_DIR, 'pi-workspace');

let exist = false;
export async function ensurePiWorkspace(): Promise<string> {
  if (exist) return PI_WORKSPACE_DIR;
  exist = true;
  await mkdir(PI_WORKSPACE_DIR, { recursive: true, mode: 0o700 });
  return PI_WORKSPACE_DIR;
}
