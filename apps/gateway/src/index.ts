import express, { type Express } from 'express';
import { healthzRouter } from './api/healthz.js';
import { config, validateConfig } from './config.js';

export const createApp = (): Express => {
  const app = express();
  app.use(express.json());
  app.use(healthzRouter);
  return app;
};

// 入口（仅在直接运行时启动，单元测试 import 不会触发）
if (import.meta.url === `file://${process.argv[1]}`) {
  validateConfig();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[gateway] listening on :${config.port}`);
  });
}
