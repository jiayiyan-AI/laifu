#!/usr/bin/env bun
import { runRefreshToken } from './refresh-token.ts';
import { sweepCache } from './sweep-cache.ts';
import { envOrDie, log, warn } from './lib.ts';

async function safe<T>(name: string, action: () => Promise<T>): Promise<T | null> {
  try {
    return await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`${name} threw: ${message}`);
    return null;
  }
}

async function main(): Promise<void> {
  envOrDie('GATEWAY_BASE_URL');
  const startedAt = Date.now();
  const sweeping = safe('sweep-cache', sweepCache);

  await safe('refresh-token', runRefreshToken);

  await sweeping;
  log(`bootstrap done in ${Date.now() - startedAt}ms`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  warn(`bootstrap fatal: ${message}`);
  process.exit(0);
}
