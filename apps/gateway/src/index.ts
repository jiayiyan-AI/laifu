import express, { type Express } from 'express';
import { healthzRouter } from './api/healthz.js';
import { buildStatusRouter } from './api/status.js';
import { ContainerMappingCache } from './db/cache.js';
import { config, validateConfig } from './config.js';
import { getSupabase } from './db/supabase.js';

export interface CreateAppOptions {
  cache?: ContainerMappingCache;
}

export const createApp = (opts: CreateAppOptions = {}): Express => {
  const app = express();
  app.use(express.json());

  app.use(healthzRouter);

  // Unit test 可以传入预设的 cache；正式跑用真实 Supabase（懒加载，避免测试时报错）
  let _cache: ContainerMappingCache | undefined = opts.cache;
  const getCache = (): ContainerMappingCache => {
    if (!_cache) _cache = new ContainerMappingCache(getSupabase());
    return _cache;
  };

  app.use(buildStatusRouter(getCache));

  return app;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  validateConfig();
  const sb = getSupabase();
  const cache = new ContainerMappingCache(sb);
  cache.loadAll().then(() => {
    const app = createApp({ cache });
    app.listen(config.port, () => {
      console.log(`[gateway] listening on :${config.port}`);
    });
  }).catch((err) => {
    console.error('[gateway] failed to load cache:', err);
    process.exit(1);
  });
}
