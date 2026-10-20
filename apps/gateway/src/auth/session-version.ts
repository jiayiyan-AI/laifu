/**
 * 网页 session 吊销: users.session_version 的带 TTL 进程内缓存 + 统一签发入口。
 * 单实例 B1 部署, 进程内缓存足够; 改密码路径主动 invalidate, 其他设备最多 ttl 内仍有效。
 */
import type { Response } from 'express';
import { signSession, sessionCookieOpts } from './session.js';
import { dao } from '../db/index.js';

export interface SessionVersionStore {
  get(userId: string): Promise<number | null>;
  invalidate(userId: string): void;
}

export const makeSessionVersionStore = (
  fetch: (userId: string) => Promise<number | null>,
  opts: { ttlMs?: number; now?: () => number } = {},
): SessionVersionStore => {
  const ttlMs = opts.ttlMs ?? 30_000;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { sv: number; at: number }>();
  // 每用户代数: invalidate 时 +1。get 在 await fetch 前记下代数, 返回后代数变了说明
  // 期间发生过改密码, 这次查到的可能是旧 sv, 不能回写缓存 (否则当前设备刚签的 sv+1
  // cookie 会被旧缓存拒掉最多 ttl)。只有被 invalidate 过的用户才会有条目, 规模 = 改过密码的人数。
  const gen = new Map<string, number>();
  return {
    async get(userId) {
      const hit = cache.get(userId);
      if (hit && now() - hit.at < ttlMs) return hit.sv;
      const g = gen.get(userId) ?? 0;
      const sv = await fetch(userId);
      const fresh = (gen.get(userId) ?? 0) === g;
      if (sv === null) { if (fresh) cache.delete(userId); return null; }
      if (fresh) cache.set(userId, { sv, at: now() });
      return sv;
    },
    invalidate(userId) {
      cache.delete(userId);
      gen.set(userId, (gen.get(userId) ?? 0) + 1);
    },
  };
};

export const sessionVersions: SessionVersionStore =
  makeSessionVersionStore((uid) => dao.users.getSessionVersion(uid));

export interface IssueSessionOpts {
  sessionSecret: string;
  cookieName: string;
  ttlHours: number;
}

/** 所有签发网页 session cookie 的地方都走这里, 保证 JWT 带上当前 sv。 */
export const issueSessionCookie = async (
  res: Response, userId: string, opts: IssueSessionOpts, sv?: number,
): Promise<void> => {
  const v = sv ?? await sessionVersions.get(userId);
  if (v === null) throw new Error(`issueSessionCookie: user not found ${userId}`);
  const token = signSession({ user_id: userId, sv: v }, opts.sessionSecret, opts.ttlHours);
  res.cookie(opts.cookieName, token, sessionCookieOpts(opts.ttlHours));
};
