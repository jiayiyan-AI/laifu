/**
 * Local dev 短路 — 仅 provisioner==='local' 且该 provider 配了 localDevToken 时挂载。
 *
 * 跳过真 OAuth flow: 用本地 token (e.g. `gh auth token` 写进 .env.local) 直接绑定。
 * 工程师不用各自注册 personal OAuth App; 真 OAuth 链路在 cloud dev 环境跑。
 * 双重 gate 防误入 prod: validateConfig 已校验非 local 环境不得有 localDevToken (config.ts)。
 * 目前仅 github 有 localDevToken。详见 docs/todo/github.md §六.11。
 */
import type { Request, Response } from 'express';
import { config } from '../../config.js';
import { encryptToken } from './crypto.js';
import { getProvider, getProviderLocalDevToken } from './providers/registry.js';
import { dao } from '../../db/index.js';

/** 短路是否对某 provider 可用。 */
export const devShortcutEnabled = (provider: string): boolean =>
  config.provisioner === 'local' && Boolean(getProviderLocalDevToken(provider));

/** 用 dev token 拉账户身份 → 加密入库 → 302 回前端。 */
export const handleDevCallback = async (
  req: Request,
  res: Response,
  provider: string,
  frontendBaseUrl: string,
): Promise<void> => {
  const userId = req.session?.user_id;
  if (!userId) {
    res.status(401).json({ error: 'not authenticated' });
    return;
  }
  const def = getProvider(provider);
  const devToken = getProviderLocalDevToken(provider);
  if (!def || !devShortcutEnabled(provider) || !devToken) {
    res.status(404).json({ error: 'dev shortcut not available' });
    return;
  }
  try {
    const account = await def.fetchAccount(devToken);
    const existing = await dao.oauthConnections.getByProviderAccount(provider, account.externalAccountId);
    if (existing && existing.user_id !== userId) {
      res.status(409).json({ error: `this ${def.displayName} account is already linked to another user` });
      return;
    }
    await dao.oauthConnections.upsertByUserAndProvider({
      userId,
      provider,
      externalAccountId: account.externalAccountId,
      externalLogin: account.externalLogin,
      encryptedAccessToken: encryptToken(devToken),
      encryptedRefreshToken: null,
      accessTokenExpiresAt: null,
      tokenScopes: account.scopes.length ? account.scopes : [...def.scopes],
    });
    res.redirect(`${frontendBaseUrl}/desktop?${provider}=ok`);
  } catch (err) {
    console.error(`[oauth:${provider}] dev-callback failed:`, err);
    res.redirect(`${frontendBaseUrl}/desktop?${provider}=error`);
  }
};
