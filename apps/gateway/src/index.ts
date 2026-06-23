// ⚠️ 必须在所有 fetch() 调用之前,否则代理装不上
import './lib/proxy-bootstrap.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { dao, getDb } from './db/index.js';
import { genId } from '@lingxi/db';
import { runWithTrace } from './lib/trace-context.js';
import { healthzRouter } from './api/healthz.js';
import { buildStatusRouter } from './api/status.js';
import { buildPurchaseRouter } from './api/purchase.js';
import { buildThreadsRouter } from './api/threads.js';
import { buildChatRouter } from './api/chat.js';
import { buildCallbackRouter } from './api/internal-callback.js';
import { buildMeUsageRouter } from './api/me-usage.js';
import { buildEntitlementsRouter } from './api/entitlements.js';
import { buildMeEntitlementsRouter } from './api/me-entitlements.js';
import { buildMeRuntimeConfigRouter } from './api/me-runtime-config.js';
import { buildAuthRefreshRouter } from './api/auth-refresh.js';
import { buildCloudRouter } from './api/cloud.js';
import { buildEmailRouter, makeEmailEntitlementMiddleware } from './api/email.js';
import { getEmailProvider } from './lib/email/index.js';
import { ensureEmailAddress } from './api/email-provision.js';
import { makeContainerTokenMiddleware } from './auth/container-token.js';
import { getBlobServiceClient, getUserDelegationKeyCache } from './lib/blob-service-client.js';
import { loadPricing } from './lib/pricing.js';
import { config, validateConfig } from './config.js';
import { recoverProvisioning } from './provisioning/recovery.js';
import { sweepReconcileAll } from './provisioning/reconcile.js';
import * as azureModule from './provisioning/azure.js';
import { requireSession } from './auth/middleware.js';
import { buildSessionRoutes } from './auth/session-routes.js';
import { buildOAuthRouter } from './auth/oauth-router.js';
import { buildPasswordRoutes } from './auth/password-routes.js';
import { providers } from './auth/providers/index.js';
import { buildWechatBindRouter } from './api/wechat-bind.js';
import { PollManager } from './wechat-ilink/poll-manager.js';
import { makeHandleInbound, wechatReplyContexts } from './wechat-ilink/inbound-handler.js';
import { HARD_DEADLINE_MS } from './lib/pending-loops.js';
import { loadPromptStore } from './lib/prompt-store.js';

export interface CreateAppOptions {
  /**
   * 微信 iLink 长轮询管理器。本地启动时构造,测试里可省略 — 省了就不挂
   * /api/wechat/* 路由,其它端点不受影响。
   */
  pollMgr?: PollManager;
}

export const createApp = (opts: CreateAppOptions = {}): Express => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  // 请求级 trace 上下文: 优先续用入站 X-Trace-Id (容器回调会带), 否则现签一个。
  // 挂在路由之前 → 之后所有 handler / 出站调用 / 日志都在同一 trace 上下文里。
  app.use((req, _res, next) => {
    const incoming = req.header('x-trace-id')?.trim();
    runWithTrace({ trace_id: incoming || genId.trace }, () => next());
  });

  app.use(healthzRouter);
  const sessionMw = requireSession({
    secret: config.session.secret,
    cookieName: config.session.cookieName,
  });

  // try to resolve db without crashing healthz when env is missing
  let dbAvailable: boolean;
  try {
    getDb();
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }

  if (dbAvailable) {
    // 加载 pricing 表到内存 cache (不阻塞 app 创建, 但在第一次请求前完成)
    void loadPricing(getDb());

    // 动态 prompt 仓库
    const promptsDir = process.env['PROMPTS_DIR']
      ?? path.resolve(process.cwd(), 'prompts');
    const promptStore = loadPromptStore(promptsDir);

    // Session 路由(/me, /logout)
    app.use(buildSessionRoutes({
      sessionSecret: config.session.secret,
      cookieName: config.session.cookieName,
      ttlHours: config.session.ttlHours,
    }));
    // 账号密码登录路由(主要登录方式)
    app.use(buildPasswordRoutes({
      sessionSecret: config.session.secret,
      cookieName: config.session.cookieName,
      ttlHours: config.session.ttlHours,
    }));
    // OAuth provider 路由(动态 :provider 分发到 registry)
    app.use(buildOAuthRouter({
      providers,
      sessionSecret: config.session.secret,
      cookieName: config.session.cookieName,
      ttlHours: config.session.ttlHours,
      publicBaseUrl: config.auth.publicBaseUrl,
      frontendBaseUrl: config.auth.frontendBaseUrl,
    }));
    app.use(buildPurchaseRouter(sessionMw));
    app.use(buildThreadsRouter(sessionMw));
    app.use(buildChatRouter(sessionMw));
    app.use(buildMeUsageRouter(sessionMw));
    // 微信 iLink 扫码绑定路由
    if (opts.pollMgr) {
      app.use(buildWechatBindRouter({
        pollMgr: opts.pollMgr,
        sessionMw,
      }));
    }

    // 内部回调路由 (容器异步完成后回调, JWT 鉴权)
    const containerAuth = makeContainerTokenMiddleware({
      secret: config.auth.gatewaySecret,
      tokenVersionFetcher: (uid: string) => dao.entitlements.getTokenVersion(uid),
    });
    // 微信回复能力
    const wechatReplier = async (threadId: string, text: string): Promise<void> => {
      for (const [loopId, ctx] of wechatReplyContexts) {
        const loop = await dao.agentLoops.getById(loopId);
        if (loop && loop.thread_id === threadId) {
          try {
            await ctx.client.sendText({
              to_user_id: ctx.toUserId,
              text,
              context_token: ctx.contextToken,
            });
          } finally {
            wechatReplyContexts.delete(loopId);
          }
          return;
        }
      }
    };
    app.use(buildCallbackRouter({ containerAuth, wechatReplier }));

    // P1 routes (entitlements + container-side + token refresh)
    app.use(buildEntitlementsRouter({
      sessionMw,
      onEnable: async (userId: string, feature: string) => {
        if (feature === 'email') {
          await ensureEmailAddress(userId);
        }
      },
    }));

    app.use(buildMeEntitlementsRouter({ secret: config.auth.gatewaySecret }));

    // Blob 依赖(云盘 + 邮件附件共用)。无 Azure 配置时为 null,附件相关端点回 501。
    const blobDeps = (config.azure.storageAccount && config.cloud.blobEndpoint)
      ? {
          blobServiceClient: getBlobServiceClient({ accountName: config.azure.storageAccount, blobEndpoint: config.cloud.blobEndpoint }),
          udkCache: getUserDelegationKeyCache({ accountName: config.azure.storageAccount, blobEndpoint: config.cloud.blobEndpoint, udkLifetimeSeconds: config.cloud.udkLifetimeSeconds }),
        }
      : null;
    if (blobDeps) {
      blobDeps.blobServiceClient.getContainerClient(config.email.attachmentContainer).createIfNotExists().catch(() => {});
    }

    // 邮件能力 (B1): inbound webhook (Basic-Auth) + 容器侧 list/get/send (containerAuth + email entitlement)
    {
      const emailProvider = getEmailProvider({
        provider: config.email.provider,
        resendApiKey: config.email.resendApiKey,
        domain: config.email.domain,
      });
      const emailContainerAuth = makeContainerTokenMiddleware({
        secret: config.auth.gatewaySecret,
        tokenVersionFetcher: (uid: string) => dao.entitlements.getTokenVersion(uid),
      });
      app.use(buildEmailRouter({
        provider: emailProvider,
        config: {
          domain: config.email.domain,
          fromDefaultName: config.email.fromDefaultName,
          inboundWebhookSecret: config.email.inboundWebhookSecret,
        },
        containerAuth: emailContainerAuth,
        requireEmailEntitlement: makeEmailEntitlementMiddleware(),
        attachments: blobDeps ? {
          udkCache: blobDeps.udkCache,
          accountName: config.azure.storageAccount,
          container: config.email.attachmentContainer,
          blobEndpoint: config.cloud.blobEndpoint,
          writeSasTtlSeconds: config.cloud.writeSasTtlSeconds,
          readSasTtlSeconds: config.cloud.readSasTtlSeconds,
        } : undefined,
      }));
      console.log(`[gateway] email routes mounted (provider=${config.email.provider}, domain=${config.email.domain})`);
    }

    app.use(buildMeRuntimeConfigRouter({
      secret: config.auth.gatewaySecret,
      prompts: promptStore,
    }));

    app.use(buildAuthRefreshRouter({ secret: config.auth.gatewaySecret }));

    // P2: cloud data plane (SAS / list / download)
    // Only wire when cloud config is populated (otherwise local-dev without Azure creds would crash).
    if (blobDeps) {
      app.use(buildCloudRouter({
        secret: config.auth.gatewaySecret,
        config: {
          accountName: config.azure.storageAccount,
          container: config.cloud.container,
          blobEndpoint: config.cloud.blobEndpoint,
          writeSasTtlSeconds: config.cloud.writeSasTtlSeconds,
          readSasTtlSeconds: config.cloud.readSasTtlSeconds,
        },
        udkCache: blobDeps.udkCache,
        blobServiceClient: blobDeps.blobServiceClient,
        sessionMw,
      }));
      console.log('[gateway] cloud routes mounted (account=' + config.azure.storageAccount + ')');
    } else {
      console.log('[gateway] cloud routes skipped (AZURE_STORAGE_ACCOUNT not set)');
    }

    app.use(buildStatusRouter(sessionMw));
  } else {
    // DB unavailable (test/healthz-only)
    app.use(buildStatusRouter(sessionMw));
  }

  // 同进程托管 web 静态产物
  const webDist = process.env['WEB_DIST_PATH']
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web-dist');
  if (existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api\/|\/healthz).*/, (_req, res) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  return app;
};

export const start = async (): Promise<void> => {
  validateConfig();

  if (config.provisioner === 'azure') {
    console.log('[gateway] recovering stuck provisioning rows...');
    await recoverProvisioning(azureModule);
  }
  console.log('[gateway] loading cache...');
  await dao.cache.loadAll();

  // 部署带新 POLICY_HASH 的 gateway 后, 后台主动把存量 stale 用户的 ACA 拉齐 (不阻塞 listen)。
  // 稳态 (全员命中) 零 ARM 调用; 没扫到的由 chat/inbound 入口的 lazy reconcile 兜底。
  if (config.provisioner === 'azure') {
    void sweepReconcileAll().catch((err) => console.error('[gateway] sweep error:', err));
  }

  // 加载 pricing 表到内存 cache
  await loadPricing(getDb());

  // 微信 iLink
  const pollMgr = new PollManager({
    onMessageFor: makeHandleInbound(),
  });
  await pollMgr.startAll();

  const app = createApp({ pollMgr });
  const server = app.listen(config.port, () => {
    console.log(`[gateway] listening on :${config.port}`);
  });

  // 一次性扫尾: 上次崩溃丢的 in-flight loop —— 它们的 per-loop deadline timer 随进程一起没了,
  // 这里把超过 HARD_DEADLINE_MS 还没完成的 row 全标 fail
  // 每个新 loop 自己挂一个 setTimeout 到 ctx 上 (见 lib/pending-loops.ts)。
  try {
    const swept = await dao.agentLoops.failOrphans(HARD_DEADLINE_MS);
    if (swept > 0) console.log(`[boot] swept ${swept} orphan loops`);
  } catch (err) {
    console.error('[boot] failOrphans error:', err);
  }

  // 优雅停机
  const shutdown = (signal: string) => {
    void (async () => {
      console.log(`[gateway] ${signal} received, shutting down...`);
      await pollMgr.stopAll();
      server.close(() => {
        console.log('[gateway] server closed');
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 5000).unref();
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};
