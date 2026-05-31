/**
 * Node 18+ 的 fetch (undici) 默认不读 HTTPS_PROXY env。
 * 启动时读一下,如果有就装全局 ProxyAgent,让后续所有 fetch() 自动走代理。
 *
 * 用法: 在 index.ts 顶部 import 一次即可。
 *   export HTTPS_PROXY=http://127.0.0.1:7890 && pnpm dev
 * 或 .env.local 里设 HTTPS_PROXY=http://127.0.0.1:7890
 */
import { setGlobalDispatcher, ProxyAgent } from 'undici';

const proxyUrl =
  process.env['HTTPS_PROXY'] ||
  process.env['https_proxy'] ||
  process.env['HTTP_PROXY'] ||
  process.env['http_proxy'];

if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log(`[gateway] HTTP proxy: ${proxyUrl}`);
}
