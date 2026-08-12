import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/index.js', async () => {
  const { mockDaoModule } = await import('../helpers/mock-dao.js');
  return mockDaoModule();
});

import { dao } from '../../src/db/index.js';
import { buildMeRuntimeConfigRouter } from '../../src/api/me-runtime-config.js';
import { config } from '../../src/config.js';
import { signLaifuUserToken } from '../../src/lib/gateway-token.js';
import { piAgentConfig, piModelProfiles } from '../../src/lib/pi-model-profiles.js';

const SECRET = config.auth.gatewaySecret;
const USER_ID = '6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f';
const SYSTEM_PROMPT = readFileSync(fileURLToPath(new URL('../../prompts/system-prompt.md', import.meta.url)), 'utf8');

function makeApp() {
  const app = express();
  app.use(buildMeRuntimeConfigRouter());
  return app;
}

describe('GET /api/me/runtime-config', () => {
  function token(): string {
    return signLaifuUserToken({ userId: USER_ID, tokenVersion: 2, secret: SECRET });
  }

  it('returns one manifest for every dynamic file', async () => {
    vi.mocked(dao.entitlements.getTokenVersion).mockResolvedValue(2);

    const res = await request(makeApp())
      .get('/api/me/runtime-config')
      .set('Authorization', `Bearer ${token()}`);

    const profileHash = createHash('sha256').update(JSON.stringify(piModelProfiles)).digest('hex').slice(0, 16);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      files_manifest: {
        'system-prompt.md': createHash('sha256').update(SYSTEM_PROMPT).digest('hex').slice(0, 16),
        'pi-model-profiles.json': profileHash,
      },
      pi_config: piAgentConfig,
    });
  });

  it('advertises Pi-compatible GPT-5.4 through the GitHub Copilot bridge', () => {
    expect(piModelProfiles.providers.find(({ provider }) => provider === 'scott')).toMatchObject({
      defaultBaseUrl: 'https://oc-kuma.shazhou.work/copilot/v1',
      api: 'openai-responses',
      authHeader: true,
      models: [{
        model: 'gpt-5.4',
        reasoning: true,
        input: ['text', 'image'],
        cost: {
          input: 2.5,
          output: 15,
          cacheRead: 0.25,
          cacheWrite: 0,
          tiers: [
            { inputTokensAbove: 272_000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 0 },
          ],
        },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        thinkingLevelMap: {
          off: null,
          minimal: 'low',
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
          max: null,
        },
        compat: { supportsOpenAIGrammarTools: true },
      }],
    });
    expect(piAgentConfig).toMatchObject({ provider: 'scott', model: 'gpt-5.4' });
  });

  it('serves every manifest file from one authenticated endpoint', async () => {
    vi.mocked(dao.entitlements.getTokenVersion).mockResolvedValue(2);

    const prompt = await request(makeApp())
      .get('/api/me/runtime-config/files/system-prompt.md')
      .set('Authorization', `Bearer ${token()}`);
    expect(prompt.body.toString('utf8')).toBe(SYSTEM_PROMPT);

    const profiles = await request(makeApp())
      .get('/api/me/runtime-config/files/pi-model-profiles.json')
      .set('Authorization', `Bearer ${token()}`);
    expect(profiles.status).toBe(200);
    expect(JSON.parse(profiles.body.toString('utf8'))).toEqual(piModelProfiles);
  });

  it('rejects invalid, missing, and unauthenticated dynamic file requests', async () => {
    vi.mocked(dao.entitlements.getTokenVersion).mockResolvedValue(2);

    const app = makeApp();
    expect((await request(app).get('/api/me/runtime-config/files/manifest.json').set('Authorization', `Bearer ${token()}`)).status).toBe(404);
    expect((await request(app).get('/api/me/runtime-config/files/missing.md').set('Authorization', `Bearer ${token()}`)).status).toBe(404);
    expect((await request(app).get('/api/me/runtime-config')).status).toBe(401);
    expect((await request(app).get('/api/me/runtime-config/files/system-prompt.md')).status).toBe(401);
  });
});

