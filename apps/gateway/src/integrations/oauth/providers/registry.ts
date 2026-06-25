/**
 * OAuth provider 注册表 — provider id → def + 运行时凭证。
 *
 * 接新 provider: import 它的 def, 加进 DEFS。其余 (路由 / DAO / 加密 / 刷新) 全通用。
 */
import { config, oauthConnectEnabled } from '../../../config.js';
import type { OAuthProviderDef, ProviderCreds } from './types.js';
import { githubProvider } from './github.js';

const DEFS: Record<string, OAuthProviderDef> = {
  [githubProvider.id]: githubProvider,
};

/** 取 provider def; 未知 provider 返 null (路由据此回 404)。 */
export const getProvider = (id: string): OAuthProviderDef | null => DEFS[id] ?? null;

/** 该 provider 是否已注册 def (不代表凭证已配齐)。 */
export const isKnownProvider = (id: string): boolean => id in DEFS;

/** provider 的运行时凭证 (来自 config.oauth.providers)。未配返空串。 */
export const getProviderCreds = (id: string): ProviderCreds => {
  const p = config.oauth.providers[id];
  return { clientId: p?.clientId ?? '', clientSecret: p?.clientSecret ?? '' };
};

/** 该 provider 的 local dev 短路 token (仅 github 有, 仅 local 生效)。 */
export const getProviderLocalDevToken = (id: string): string | null =>
  config.oauth.providers[id]?.localDevToken ?? null;

/** 是否可走 connect 流程 (config.oauthConnectEnabled 的转发)。 */
export const isProviderConnectEnabled = (id: string): boolean =>
  isKnownProvider(id) && oauthConnectEnabled(id);
