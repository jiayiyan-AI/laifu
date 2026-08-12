import type { RuntimeConfig } from '../../runtime/types.ts';
import { httpJson, log, readToken, warn } from './lib.ts';

export async function fetchRuntimeConfig(): Promise<RuntimeConfig | null> {
  const gateway = process.env.GATEWAY_BASE_URL ?? '';
  const token = readToken();
  if (!token) {
    warn('no token — cannot pull runtime-config');
    return null;
  }

  for (let attempt = 1; attempt <= 7; attempt++) {
    try {
      const { status, body } = await httpJson({
        method: 'GET',
        url: `${gateway}/api/me/runtime-config`,
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: 5_000,
      });
      if (status >= 200 && status < 300) {
        log(`runtime-config fetched on attempt ${attempt}`);
        return JSON.parse(body) as RuntimeConfig;
      }
      warn(`runtime-config HTTP ${status} (attempt ${attempt}/7)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`runtime-config attempt ${attempt}/7 failed: ${message}`);
    }
    if (attempt < 7) await sleep(3_000);
  }
  return null;
}


function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
