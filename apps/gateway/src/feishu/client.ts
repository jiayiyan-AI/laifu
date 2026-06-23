/**
 * feishu/client.ts — 零 openclaw 依赖的 Lark SDK 封装
 *
 * 从 openclaw/extensions/feishu/src/client.ts 移植，去除:
 *   - readPluginPackageVersion  → UA 用硬编码常量
 *   - resolveAmbientNodeProxyAgent → 先不接代理
 *   - openclaw/plugin-sdk/* import
 *   - config-schema 多来源超时逻辑 → 固定 30s
 *   - 客户端缓存（对 laifu 业务暂不需要，保持简单）
 */

import * as Lark from '@larksuiteoapi/node-sdk';

/** 固定 User-Agent，覆盖 SDK 默认的 oapi-node-sdk/x.y.z */
const FEISHU_UA = 'laifu-feishu/1';

/** HTTP 超时：固定 30s（简化版，移除 openclaw 多来源配置逻辑） */
const HTTP_TIMEOUT_MS = 30_000;

// 覆盖 SDK defaultHttpInstance 上的 User-Agent 拦截器（LIFO 顺序问题）。
// 参照 openclaw 客户端：先清空 handlers[]，再注册自己的拦截器。
{
  const inst = Lark.defaultHttpInstance as {
    interceptors?: {
      request: { handlers: unknown[]; use: (fn: (req: unknown) => unknown) => void };
    };
  };
  if (inst.interceptors?.request) {
    inst.interceptors.request.handlers = [];
    inst.interceptors.request.use((req: unknown) => {
      const r = req as { headers?: Record<string, string> };
      if (r.headers) {
        r.headers['User-Agent'] = FEISHU_UA;
      }
      return req;
    });
  }
}

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

export interface FeishuCreds {
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark';
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

function resolveDomain(domain: 'feishu' | 'lark'): Lark.Domain {
  return domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;
}

/**
 * 创建一个包裹 defaultHttpInstance 的 timeout-aware http instance。
 * 固定超时 HTTP_TIMEOUT_MS（30s）。
 */
function createTimeoutHttpInstance(): Lark.HttpInstance {
  const base = Lark.defaultHttpInstance;
  const timeout = HTTP_TIMEOUT_MS;

  function injectTimeout<D>(opts?: Lark.HttpRequestOptions<D>): Lark.HttpRequestOptions<D> {
    return { timeout, ...opts } as Lark.HttpRequestOptions<D>;
  }

  return {
    request: (opts) => base.request(injectTimeout(opts)),
    get: (url, opts) => base.get(url, injectTimeout(opts)),
    post: (url, data, opts) => base.post(url, data, injectTimeout(opts)),
    put: (url, data, opts) => base.put(url, data, injectTimeout(opts)),
    patch: (url, data, opts) => base.patch(url, data, injectTimeout(opts)),
    delete: (url, opts) => base.delete(url, injectTimeout(opts)),
    head: (url, opts) => base.head(url, injectTimeout(opts)),
    options: (url, opts) => base.options(url, injectTimeout(opts)),
  };
}

// ---------------------------------------------------------------------------
// 导出 API
// ---------------------------------------------------------------------------

/**
 * 创建飞书 HTTP Client（自建应用类型，带 30s 超时）。
 */
export function createFeishuClient(c: FeishuCreds): Lark.Client {
  return new Lark.Client({
    appId: c.appId,
    appSecret: c.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: resolveDomain(c.domain),
    httpInstance: createTimeoutHttpInstance(),
  });
}

/**
 * 创建飞书 WebSocket Client（不传代理 agent，先不接 proxy）。
 */
export function createFeishuWSClient(c: FeishuCreds): Lark.WSClient {
  return new Lark.WSClient({
    appId: c.appId,
    appSecret: c.appSecret,
    domain: resolveDomain(c.domain),
    loggerLevel: Lark.LoggerLevel.info,
  });
}

/**
 * im.message.create，receive_id_type=open_id，发纯文本。
 */
export async function sendFeishuMessage(
  client: Lark.Client,
  toOpenId: string,
  text: string,
): Promise<void> {
  await client.im.message.create({
    params: { receive_id_type: 'open_id' },
    data: {
      receive_id: toOpenId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  });
}
