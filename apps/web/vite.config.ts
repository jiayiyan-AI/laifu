import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,                    // 前端 = 3000 (符合 Next.js/CRA/Astro 约定)
    proxy: {
      '/api': {
        target: 'http://localhost:9000',   // 后端 (gateway) = 9000
        changeOrigin: true,
      },
    },
  },
});
