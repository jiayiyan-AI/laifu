import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeGoogleProvider } from '../../../src/auth/providers/google.js';

const provider = makeGoogleProvider({
  clientId: 'cid.apps.googleusercontent.com',
  clientSecret: 'csecret',
});

describe('GoogleProvider', () => {
  beforeEach(() => vi.restoreAllMocks());

  describe('buildAuthUrl', () => {
    it('points to Google OAuth, includes all required params', () => {
      const url = provider.buildAuthUrl('STATE123', 'http://localhost:9000/api/auth/google/callback');
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(parsed.searchParams.get('client_id')).toBe('cid.apps.googleusercontent.com');
      expect(parsed.searchParams.get('redirect_uri')).toBe('http://localhost:9000/api/auth/google/callback');
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('state')).toBe('STATE123');
      expect(parsed.searchParams.get('scope')).toBe('openid email profile');
      // Google 推荐加 access_type=online 跟 prompt=select_account,可有可无
    });
  });

  describe('exchangeCode', () => {
    it('POSTs to token endpoint with form body, returns access_token', async () => {
      const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'ya29.token', token_type: 'Bearer' })),
      );

      const result = await provider.exchangeCode('the_code', 'http://localhost:9000/cb');

      expect(result).toEqual({ access_token: 'ya29.token' });
      expect(spy).toHaveBeenCalledWith(
        'https://oauth2.googleapis.com/token',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/x-www-form-urlencoded',
          }),
        }),
      );
      const body = (spy.mock.calls[0]![1] as RequestInit).body as string;
      const form = new URLSearchParams(body);
      expect(form.get('code')).toBe('the_code');
      expect(form.get('client_id')).toBe('cid.apps.googleusercontent.com');
      expect(form.get('client_secret')).toBe('csecret');
      expect(form.get('redirect_uri')).toBe('http://localhost:9000/cb');
      expect(form.get('grant_type')).toBe('authorization_code');
    });

    it('throws on Google error response', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
      );
      await expect(provider.exchangeCode('bad', 'http://x')).rejects.toThrow(/google token exchange/i);
    });
  });

  describe('fetchUserinfo', () => {
    it('GETs userinfo with bearer, returns normalized shape', async () => {
      const spy = vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          sub: '1234567890',
          email: 'alice@example.com',
          name: 'Alice',
          picture: 'https://lh3.googleusercontent.com/x',
        })),
      );

      const user = await provider.fetchUserinfo('ya29.token');

      expect(user).toEqual({
        external_id: '1234567890',
        email: 'alice@example.com',
        name: 'Alice',
        avatar_url: 'https://lh3.googleusercontent.com/x',
      });
      expect(spy).toHaveBeenCalledWith(
        'https://openidconnect.googleapis.com/v1/userinfo',
        expect.objectContaining({
          headers: { Authorization: 'Bearer ya29.token' },
        }),
      );
    });

    it('tolerates missing name/picture (some accounts omit them)', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ sub: '999', email: 'bob@example.com' })),
      );
      const user = await provider.fetchUserinfo('t');
      expect(user).toEqual({
        external_id: '999',
        email: 'bob@example.com',
        name: null,
        avatar_url: null,
      });
    });

    it('throws if Google returns error', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(new Response('boom', { status: 401 }));
      await expect(provider.fetchUserinfo('bad')).rejects.toThrow(/google userinfo/i);
    });
  });
});
