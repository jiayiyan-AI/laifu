// ⚠️ 必须在所有 fetch() 调用之前,否则代理装不上
import './lib/proxy-bootstrap.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import type { SupabaseClient } from '@supabase/supabase-js';
import { healthzRouter } from './api/healthz.js';
import { buildStatusRouter } from './api/status.js';
import { buildPurchaseRouter, type ProvisionerFn } from './api/purchase.js';
import { buildThreadsRouter } from './api/threads.js';
import { buildChatRouter } from './api/chat.js';
import { ContainerMappingCache } from './db/cache.js';
import { config, validateConfig } from './config.js';
import { getSupabase } from './db/supabase.js';
import { provisionContainer } from './provisioning/manager.js';
import { provisionContainerLocal } from './provisioning/local.js';
import { recoverProvisioning } from './provisioning/recovery.js';
import * as azureModule from './provisioning/azure.js';
import { requireSession } from './auth/middleware.js';
import { buildSessionRoutes } from './auth/session-routes.js';
import { buildOAuthRouter } from './auth/oauth-router.js';
import { providers } from './auth/providers/index.js';
import { buildWechatBindRouter } from './api/wechat-bind.js';
import { PollManager } from './wechat-ilink/poll-manager.js';
import { makeHandleInbound } from './wechat-ilink/inbound-handler.js';
import { makeWechatBindingDao } from './db/wechat-binding-dao.js';
import { ThreadStreamHub } from './lib/thread-stream.js';

export interface CreateAppOptions {
  cache?: ContainerMappingCache;
  sb?: SupabaseClient;
  provisioner?: ProvisionerFn;
  /**
   * 微信 iLink 长轮询管理器。本地启动时构造,测试里可省略 — 省了就不挂
   * /api/wechat/* 路由,其它端点不受影响。
   */
  pollMgr?: PollManager;
  /**
   * SSE 通知 hub。本地启动构造,传给 chat 路由注册 /api/threads/:id/stream
   * 端点 + 给入站事件源头 (handleInbound、POST /api/chat) 调 emit。
   * 测试里可省略,/stream 端点就不挂。
   */
  hub?: ThreadStreamHub;
}

export const createApp = (opts: CreateAppOptions = {}): Express => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  app.use(healthzRouter);

  // 懒加载，让 healthz 测试无需 Supabase env
  let _sb: SupabaseClient | undefined = opts.sb;
  const getSb = (): SupabaseClient => {
    if (!_sb) _sb = getSupabase();
    return _sb;
  };

  let _cache: ContainerMappingCache | undefined = opts.cache;
  const getCache = (): ContainerMappingCache => {
    if (!_cache) _cache = new ContainerMappingCache(getSb());
    return _cache;
  };

  const defaultProvisioner: ProvisionerFn = async (args) => {
    if (config.provisioner === 'local') {
      await provisionContainerLocal({
        userId: args.userId,
        sb: getSb(),
        cache: getCache(),
        localContainerUrl: config.localContainerUrl,
      });
    } else {
      await provisionContainer({
        ...args,
        sb: getSb(),
        cache: getCache(),
        azure: azureModule,
      });
    }
  };

  const provisioner = opts.provisioner ?? defaultProvisioner;

  const sessionMw = requireSession({
    secret: config.session.secret,
    cookieName: config.session.cookieName,
  });

  // try to resolve sb without crashing healthz when env is missing
  let sbResolved: SupabaseClient | null;
  try {
    sbResolved = opts.sb ?? getSupabase();
  } catch {
    sbResolved = null;
  }

  if (sbResolved) {
    // Session 路由(/me, /logout)
    app.use(buildSessionRoutes({
      sb: sbResolved,
      sessionSecret: config.session.secret,
      cookieName: config.session.cookieName,
      ttlHours: config.session.ttlHours,
    }));
    // OAuth provider 路由(动态 :provider 分发到 registry)
    app.use(buildOAuthRouter({
      sb: sbResolved,
      providers,
      sessionSecret: config.session.secret,
      cookieName: config.session.cookieName,
      ttlHours: config.session.ttlHours,
      publicBaseUrl: config.auth.publicBaseUrl,
      frontendBaseUrl: config.auth.frontendBaseUrl,
    }));
    app.use(buildPurchaseRouter(sbResolved, getCache(), provisioner, sessionMw));
    app.use(buildThreadsRouter(sbResolved, sessionMw));
    app.use(buildChatRouter(sbResolved, getCache(), sessionMw, opts.hub));
    // 微信 iLink 扫码绑定路由 — 仅启动时挂 (测试可省 pollMgr 跳过)
    if (opts.pollMgr) {
      app.use(buildWechatBindRouter({
        dao: makeWechatBindingDao(sbResolved),
        pollMgr: opts.pollMgr,
        sessionMw,
      }));
    }
  }
  app.use(buildStatusRouter(getCache, sessionMw));

  // 同进程托管 web 静态产物 (部署到 App Service 时前后端同源)。
  // WEB_DIST_PATH 显式指定优先; 否则按 zip 部署后的相对位置 (web-dist/ 与 dist/ 并列) 找; 找不到就跳过 (本地 dev 走 Vite)
  const webDist = process.env['WEB_DIST_PATH']
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web-dist');
  if (existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist));
    // SPA fallback: 排除 API/auth/healthz, 其它都回 index.html 给 React Router
    app.get(/^(?!\/api\/|\/healthz).*/, (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  return app;
};

// 启动入口: 本地 dev (tsx watch src/entry-dev.ts) 和生产 bundle (entry-prod.ts) 都
// import 这里的 start()。index.ts 自己不带顶层启动副作用——避免被 vite bundle 时
// `import.meta.url` 跟生产 entry 互相匹配导致 start() 被调两次。
export const start = async (): Promise<void> => {
  validateConfig();
  const sb = getSupabase();
  const cache = new ContainerMappingCache(sb);

  if (config.provisioner === 'azure') {
    console.log('[gateway] recovering stuck provisioning rows...');
    await recoverProvisioning(sb, azureModule);
  }
  console.log('[gateway] loading cache...');
  await cache.loadAll();

  // SSE 通知 hub 在 PollManager 之前构造 (handleInbound 工厂要它)
  const hub = new ThreadStreamHub();

  // 微信 iLink: PollManager 在 listen 前 startAll,扫 DB 拉所有 is_active=true 绑定起循环
  const wechatDao = makeWechatBindingDao(sb);
  const pollMgr = new PollManager({
    dao: wechatDao,
    onMessageFor: makeHandleInbound({ dao: wechatDao, sb, cache, hub }),
  });
  await pollMgr.startAll();

  const app = createApp({ cache, sb, pollMgr, hub });
  const server = app.listen(config.port, () => {
    console.log(`[gateway] listening on :${config.port}`);
  });

  // 优雅停机: 先停 PollManager (避免停机过程中还在拉新消息) 再关 HTTP server
  const shutdown = (signal: string) => {
    void (async () => {
      console.log(`[gateway] ${signal} received, shutting down...`);
      await pollMgr.stopAll();
      server.close(() => {
        console.log('[gateway] server closed');
        process.exit(0);
      });
      // 5s 兜底,避免 server.close 挂死
      setTimeout(() => process.exit(1), 5000).unref();
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};