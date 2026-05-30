import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/index.js';

describe('GET /healthz', () => {
  it('returns 200 with ok=true and uptime_seconds', async () => {
    const app = createApp();
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.uptime_seconds).toBe('number');
  });
});
