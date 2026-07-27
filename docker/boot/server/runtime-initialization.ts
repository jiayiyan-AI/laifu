import { syncDynamicFiles } from '../scripts/dynamic-files.ts';
import { fetchRuntimeConfig } from '../scripts/runtime-config.ts';
import { fetchDesiredEntitlements, reportObservedEntitlements } from '../scripts/entitlements.ts';
import type { AgentRuntime } from '../../runtime/types.ts';
import { log } from './logger.ts';


/** Initializes the server process's runtime state after bootstrap has exited. */
export async function initializeRuntime(runtime: AgentRuntime): Promise<void> {
  const [config, desired] = await Promise.all([
    fetchRuntimeConfig(),
    fetchDesiredEntitlements(),
  ]);

  if (config) {
    try {
      await syncDynamicFiles(config.files_manifest);
    } catch (error) {
      log.error({ event: 'runtime.dynamic-files.failed', err: error instanceof Error ? error.message : String(error) });
    }
  }

  try {
    await runtime.prepare();
  } catch (error) {
    log.error({ event: 'runtime.prepare.failed', err: error instanceof Error ? error.message : String(error) });
  }

  if (!desired) return;

  try {
    const observed = await runtime.applyEntitlements(desired.entitlements);
    await reportObservedEntitlements(observed, desired.tokenVersion);
  } catch (error) {
    log.error({ event: 'runtime.entitlements.failed', err: error instanceof Error ? error.message : String(error) });
  }
}
