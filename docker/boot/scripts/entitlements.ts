import { httpJson, readToken, warn } from './lib.ts';

export interface DesiredEntitlements {
  entitlements: string[];
  tokenVersion: number;
}

interface EntitlementsResponse {
  entitlements?: string[];
  token_version?: number;
}

export async function fetchDesiredEntitlements(): Promise<DesiredEntitlements | null> {
  const gateway = process.env.GATEWAY_BASE_URL ?? '';
  const token = readToken();
  if (!token) {
    warn('no token — skip entitlement sync');
    return null;
  }

  for (let attempt = 1; attempt <= 7; attempt++) {
    try {
      const { status, body } = await httpJson({
        method: 'GET',
        url: `${gateway}/api/me/entitlements`,
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: 5_000,
      });
      if (status >= 200 && status < 300) {
        const response = JSON.parse(body) as EntitlementsResponse;
        return {
          entitlements: Array.isArray(response.entitlements) ? response.entitlements : [],
          tokenVersion: typeof response.token_version === 'number' ? response.token_version : 0,
        };
      }
      warn(`entitlements HTTP ${status} (attempt ${attempt}/7)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`entitlements attempt ${attempt}/7 failed: ${message}`);
    }
    if (attempt < 7) await sleep(3_000);
  }
  return null;
}

export async function reportObservedEntitlements(observed: string[], tokenVersion: number): Promise<void> {
  const gateway = process.env.GATEWAY_BASE_URL ?? '';
  const token = readToken();
  if (!gateway || !token) return;

  const body = { observed, token_version: tokenVersion };
  try {
    const result = await httpJson({
      method: 'POST',
      url: `${gateway}/api/me/observed-entitlements`,
      headers: { Authorization: `Bearer ${token}` },
      body,
      timeoutMs: 10_000,
    });
    if (result.status < 200 || result.status >= 300) {
      warn(`observed-entitlements HTTP ${result.status}: ${result.body.slice(0, 200)}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`observed-entitlements report failed: ${message}`);
  }
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
