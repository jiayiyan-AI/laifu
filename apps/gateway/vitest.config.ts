import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // 每个测试后自动 vi.unstubAllGlobals(): 测试用 vi.stubGlobal('fetch', mock)
    // 注入 HTTP 桩, 不必各文件手写 afterEach 还原。
    unstubGlobals: true,
  },
});
