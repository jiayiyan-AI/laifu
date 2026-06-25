/**
 * DAO 单例注册表 — 统一入口 `dao.*`，基于 getDb() 单例懒创建。
 *
 * 用法:
 *   import { dao } from '../db/index.js';
 *   const user = await dao.users.getById(id);
 *   const threads = await dao.threads.listByUser(userId);
 *
 * 所有 DAO 首次访问时才创建，不需要手动注入 db。
 */
import { getDb, closeDb } from './client.js';
import { makeUsersDao, type UsersDao } from './users-dao.js';
import { makeContainerMappingDao, type ContainerMappingDao } from './container-mapping-dao.js';
import { makeMessageDao, type MessageDao } from './message-dao.js';
import { makeThreadsDao, type ThreadsDao } from './threads-dao.js';
import { makeAgentLoopDao, type AgentLoopDao } from './agent-loop-dao.js';
import { makeWechatBindingDao, type WechatBindingDao } from './wechat-binding-dao.js';
import { makeFeishuBindingDao, type FeishuBindingDao } from './feishu-binding-dao.js';
import { makeEmailDao, type EmailDao } from './email-dao.js';
import { makeEntitlementsDao, type EntitlementsDao } from './entitlements-dao.js';
import { makeUsageDao, type UsageDao } from './usage-dao.js';
import { makeObservedStateDao, type ObservedStateDao } from './observed-state-dao.js';
import { makeOauthConnectionsDao, type OauthConnectionsDao } from './oauth-connections-dao.js';
import { ContainerMappingCache } from './cache.js';

export interface Dao {
  users: UsersDao;
  containerMapping: ContainerMappingDao;
  messages: MessageDao;
  threads: ThreadsDao;
  agentLoops: AgentLoopDao;
  wechatBindings: WechatBindingDao;
  feishuBindings: FeishuBindingDao;
  email: EmailDao;
  entitlements: EntitlementsDao;
  usage: UsageDao;
  observedState: ObservedStateDao;
  oauthConnections: OauthConnectionsDao;
  cache: ContainerMappingCache;
}

const factories: Record<keyof Dao, () => unknown> = {
  users: () => makeUsersDao(getDb()),
  containerMapping: () => makeContainerMappingDao(getDb()),
  messages: () => makeMessageDao(getDb()),
  threads: () => makeThreadsDao(getDb()),
  agentLoops: () => makeAgentLoopDao(getDb()),
  wechatBindings: () => makeWechatBindingDao(getDb()),
  feishuBindings: () => makeFeishuBindingDao(getDb()),
  email: () => makeEmailDao(getDb()),
  entitlements: () => makeEntitlementsDao(getDb()),
  usage: () => makeUsageDao(getDb()),
  observedState: () => makeObservedStateDao(getDb()),
  oauthConnections: () => makeOauthConnectionsDao(getDb()),
  cache: () => new ContainerMappingCache(getDb()),
};

const target = {} as Record<string, unknown>;

/**
 * 全局 DAO 单例。首次访问某个属性时懒创建对应 DAO 实例。
 *
 * ```ts
 * import { dao } from '../db/index.js';
 * await dao.users.getById(id);
 * await dao.threads.create(...);
 * await dao.cache.loadAll();
 * ```
 */
export const dao: Dao = new Proxy(target as unknown as Dao, {
  get(t, prop: string) {
    if (!(prop in t)) {
      const factory = factories[prop as keyof Dao];
      if (!factory) return undefined;
      (t as any)[prop] = factory();
    }
    return (t as any)[prop];
  },
});

/** 测试用：清空所有缓存的 DAO 实例（配合 closeDb 使用）。 */
export const resetDao = (): void => {
  for (const key of Object.keys(target)) delete target[key];
};

// Re-export
export { getDb, closeDb };
export { ContainerMappingCache };
export type {
  UsersDao, ContainerMappingDao, MessageDao, ThreadsDao,
  AgentLoopDao, WechatBindingDao, FeishuBindingDao, EmailDao, EntitlementsDao,
  UsageDao, ObservedStateDao, OauthConnectionsDao,
};
