import express, { type Express } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { healthzRouter } from './api/healthz.js';
import { buildStatusRouter } from './api/status.js';
import { buildPurchaseRouter, type ProvisionerFn } from './api/purchase.js';
import { ContainerMappingCache } from './db/cache.js';
import { config, validateConfig } from './config.js';
import { getSupabase } from './db/supabase.js';
import { provisionContainer } from './provisioning/manager.js';
import * as azureModule from './provisioning/azure.js';
import { recoverProvisioning } from './provisioning/recovery.js';
import { provisionContainerLocal } from './provisioning/local.js';

export interface CreateAppOptions {
  cache?: ContainerMappingCache;
  sb?: SupabaseClient;
  provisioner?: ProvisionerFn;
}

export const createApp = (opts: CreateAppOptions = {}): Express => {
  const app = express();
  app.use(express.json());

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

  app.use(buildStatusRouter(getCache));

  // 尝试解析 sb；若 opts.sb 未提供且 env 未配置则跳过 purchase 路由注册
  // 这样 healthz 测试（无 env、无 opts.sb）不会因为 getSupabase() 抛出而崩溃
  let sbResolved: SupabaseClient | null;
  try {
    sbResolved = opts.sb ?? getSupabase();
  } catch {
    sbResolved = null; // env not configured; purchase will be unavailable
  }

  if (sbResolved) {
    app.use(buildPurchaseRouter(sbResolved, getCache(), provisioner));
  }

  return app;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  validateConfig();
  const sb = getSupabase();
  const cache = new ContainerMappingCache(sb);

  (async () => {
    if (config.provisioner === 'azure') {
      console.log('[gateway] recovering stuck provisioning rows...');
      await recoverProvisioning(sb, azureModule);
    }
    console.log('[gateway] loading cache...');
    await cache.loadAll();
    const app = createApp({ cache, sb });
    app.listen(config.port, () => {
      console.log(`[gateway] listening on :${config.port}`);
    });
  })().catch((err) => {
    console.error('[gateway] startup failed:', err);
    process.exit(1);
  });
}
