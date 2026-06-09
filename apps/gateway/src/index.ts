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
import { buildMeUsageRouter } from './api/me-usage.js';
import { buildEntitlementsRouter } from './api/entitlements.js';
import { buildMeEntitlementsRouter } from './api/me-entitlements.js';
import { buildMeRuntimeConfigRouter } from './api/me-runtime-config.js';
import { buildAuthRefreshRouter } from './api/auth-refresh.js';
import { buildCloudRouter } from './api/cloud.js';
import { buildEmailRouter, makeEmailEntitlementMiddleware } from './api/email.js';
import { getEmailProvider } from './lib/email/index.js';
import { makeEmailDao } from './db/email-dao.js';
import { ensureEmailAddress } from './api/email-provision.js';
import { makeContainerTokenMiddleware } from './auth/container-token.js';
import { getBlobServiceClient, getUserDelegationKeyCache } from './lib/blob-service-client.js';
import { ContainerMappingCache } from './db/cache.js';
import { makeEntitlementsDao } from './db/entitlements-dao.js';
import { makeUsageDao } from './db/usage-dao.js';
import { loadPricing } from './lib/pricing.js';
import { makeObservedStateDao } from './db/observed-state-dao.js';
import { config, validateConfig } from './config.js';
import { getSupabase } from './db/supabase.js';
import { provisionContainer } from './provisioning/manager.js';
import { provisionContainerLocal } from './provisioning/local.js';
import { recoverProvisioning } from './provisioning/recovery.js';
import * as azureModule from './provisioning/azure.js';
import {
  signTokenAndInjectLocal,
  restartContainerAppLocal,
} from './provisioning/local.js';
import { requireSession } from './auth/middleware.js';
import { buildSessionRoutes } from './auth/session-routes.js';
import { buildOAuthRouter } from './auth/oauth-router.js';
import { providers } from './auth/providers/index.js';
import { buildWechatBindRouter } from './api/wechat-bind.js';
import { PollManager } from './wechat-ilink/poll-manager.js';
import { makeHandleInbound } from './wechat-ilink/inbound-handler.js';
import { makeWechatBindingDao } from './db/wechat-binding-dao.js';
import { ThreadStreamHub } from './lib/thread-stream.js';
import { loadPromptStore } from './lib/prompt-store.js';

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
    // signTokenAndRestart: 传给 provisioner 的最后一步 hook, 负责签 LAIFU_USER_TOKEN +
    // restart 容器让 entrypoint 拉 runtime-config。详见 manager.ts SignTokenAndRestart 注释。
    const signTokenAndRestart = async (userId: string, tokenVersion: number) => {
      if (config.provisioner === 'azure') {
        await azureModule.signTokenAndInjectAzure(userId, tokenVersion);
        await azureModule.restartContainerAppAzure(userId);
      } else {
        await signTokenAndInjectLocal(userId, tokenVersion);
        await restartContainerAppLocal(userId);
      }
    };

    if (config.provisioner === 'local') {
      await provisionContainerLocal({
        userId: args.userId,
        sb: getSb(),
        cache: getCache(),
        localContainerUrl: config.localContainerUrl,
        signTokenAndRestart,
      });
    } else {
      await provisionContainer({
        ...args,
        sb: getSb(),
        cache: getCache(),
        azure: azureModule,
        signTokenAndRestart,
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
    // 加载 pricing 表到内存 cache (不阻塞 app 创建, 但在第一次请求前完成)
    void loadPricing(sbResolved);

    // P1 DAOs (instantiated once per app)
    const entitlementsDao = makeEntitlementsDao(sbResolved);
    const usageDao = makeUsageDao(sbResolved);
    const observedStateDao = makeObservedStateDao(sbResolved);

    // 动态 prompt 仓库 (启动时扫盘一次, 不做 hot-reload):
    //   - dev: apps/gateway/prompts/ (源码目录)
    //   - prod: build-deploy 会把这个目录复制到 deploy 包根, 通过 PROMPTS_DIR env 指向
    // 路径解析: 先看 PROMPTS_DIR env, 再 fallback 到 cwd/prompts。
    const promptsDir = process.env['PROMPTS_DIR']
      ?? path.resolve(process.cwd(), 'prompts');
    const promptStore = loadPromptStore(promptsDir);

    // P1 provisioner-aware helpers (real Azure or local mock)
    const signAndInject = config.provisioner === 'azure'
      ? azureModule.signTokenAndInjectAzure
      : signTokenAndInjectLocal;
    const restartContainer = config.provisioner === 'azure'
      ? azureModule.restartContainerAppAzure
      : restartContainerAppLocal;

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
    app.use(buildChatRouter(sbResolved, getCache(), sessionMw, opts.hub, usageDao));
    app.use(buildMeUsageRouter(usageDao, sessionMw));
    // 微信 iLink 扫码绑定路由 — 仅启动时挂 (测试可省 pollMgr 跳过)
    if (opts.pollMgr) {
      app.use(buildWechatBindRouter({
        dao: makeWechatBindingDao(sbResolved),
        pollMgr: opts.pollMgr,
        sessionMw,
      }));
    }

    // emailDao 提前构造: entitlements onEnable 钩子(email 自动分配 handle)与下方 email 路由共用。
    const emailDao = makeEmailDao(sbResolved);

    // P1 routes (entitlements + container-side + token refresh)
    app.use(buildEntitlementsRouter({
      entitlements: entitlementsDao,
      restartContainer,
      signTokenAndInject: signAndInject,
      sessionMw,
      onEnable: async (userId, feature) => {
        if (feature === 'email') {
          await ensureEmailAddress(emailDao, userId);
        }
      },
    }));

    app.use(buildMeEntitlementsRouter({
      secret: config.auth.gatewaySecret,
      entitlements: entitlementsDao,
      observedState: observedStateDao,
    }));

    // 邮件能力 (B1): inbound webhook (Basic-Auth) + 容器侧 list/get/send (containerAuth + email entitlement)
    {
      const emailProvider = getEmailProvider({
        provider: config.email.provider,
        postmarkServerToken: config.email.postmarkServerToken,
      });
      const emailContainerAuth = makeContainerTokenMiddleware({
        secret: config.auth.gatewaySecret,
        tokenVersionFetcher: (uid) => entitlementsDao.getTokenVersion(uid),
      });
      app.use(buildEmailRouter({
        dao: emailDao,
        provider: emailProvider,
        config: {
          domain: config.email.domain,
          fromDefaultName: config.email.fromDefaultName,
          inboundWebhookSecret: config.email.inboundWebhookSecret,
        },
        containerAuth: emailContainerAuth,
        requireEmailEntitlement: makeEmailEntitlementMiddleware(entitlementsDao),
      }));
      console.log(`[gateway] email routes mounted (provider=${config.email.provider}, domain=${config.email.domain})`);
    }

    app.use(buildMeRuntimeConfigRouter({
      secret: config.auth.gatewaySecret,
      entitlements: entitlementsDao,
      prompts: promptStore,
    }));

    app.use(buildAuthRefreshRouter({
      secret: config.auth.gatewaySecret,
      getTokenVersion: (uid) => entitlementsDao.getTokenVersion(uid),
    }));

    // P2: cloud data plane (SAS / list / download)
    // Only wire when cloud config is populated (otherwise local-dev without Azure creds would crash).
    if (config.azure.storageAccount && config.cloud.blobEndpoint) {
      const blobServiceClient = getBlobServiceClient({
        accountName: config.azure.storageAccount,
        blobEndpoint: config.cloud.blobEndpoint,
      });
      const udkCache = getUserDelegationKeyCache({
        accountName: config.azure.storageAccount,
        blobEndpoint: config.cloud.blobEndpoint,
        udkLifetimeSeconds: config.cloud.udkLifetimeSeconds,
      });

      app.use(buildCloudRouter({
        secret: config.auth.gatewaySecret,
        config: {
          accountName: config.azure.storageAccount,
          container: config.cloud.container,
          blobEndpoint: config.cloud.blobEndpoint,
          writeSasTtlSeconds: config.cloud.writeSasTtlSeconds,
          readSasTtlSeconds: config.cloud.readSasTtlSeconds,
        },
        entitlements: entitlementsDao,
        udkCache,
        blobServiceClient,
        sessionMw,
      }));
      console.log('[gateway] cloud routes mounted (account=' + config.azure.storageAccount + ')');
    } else {
      console.log('[gateway] cloud routes skipped (AZURE_STORAGE_ACCOUNT not set)');
    }

    app.use(buildStatusRouter(getCache, sessionMw, entitlementsDao, observedStateDao));
  } else {
    // Supabase unavailable (test/healthz-only): mount status without P1 DAO enrichment
    app.use(buildStatusRouter(getCache, sessionMw));
  }

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

  // 加载 pricing 表到内存 cache
  await loadPricing(sb);

  // SSE 通知 hub 在 PollManager 之前构造 (handleInbound 工厂要它)
  const hub = new ThreadStreamHub();

  // 微信 iLink: PollManager 在 listen 前 startAll,扫 DB 拉所有 is_active=true 绑定起循环
  const wechatDao = makeWechatBindingDao(sb);
  const usageDao = makeUsageDao(sb);
  const pollMgr = new PollManager({
    dao: wechatDao,
    onMessageFor: makeHandleInbound({ dao: wechatDao, sb, cache, hub, usageDao }),
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