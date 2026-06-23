/**
 * FeishuConnectionManager — 进程内单例,管所有活跃飞书绑定的 WS 长连接。
 *
 * 对标 wechat-ilink/poll-manager.ts (N 条 HTTP 轮询) 的飞书版:
 * 微信是 N 条 HTTP 长轮询, 飞书是 N 条 WebSocket 长连接。
 * 公开方法签名与 PollManager 对齐:
 *   startAll / startOne / stopOne / stopAll / size
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { dao } from '../db/index.js';
import { createFeishuWSClient, createFeishuClient } from './client.js';
import type { FeishuBinding } from '../db/feishu-binding-dao.js';

/**
 * 工厂签名: 收到 (binding, client) 后返回 inbound 回调。
 * 与 inbound-handler.ts 的 makeFeishuInbound 返回值对齐。
 */
export type OnMessageFactory = (
  binding: FeishuBinding,
  client: Lark.Client,
) => (evt: unknown) => Promise<void>;

export interface FeishuConnManagerOpts {
  /** 每个 binding 一个 inbound 回调工厂 */
  onMessageFor: OnMessageFactory;
  /** 测试注入: 替换 WSClient 构造 */
  wsFactory?: (b: FeishuBinding) => Lark.WSClient;
  /** 测试注入: 替换 HTTP Client 构造 */
  clientFactory?: (b: FeishuBinding) => Lark.Client;
}

export class FeishuConnectionManager {
  private connections = new Map<string, Lark.WSClient>();
  private readonly opts: Required<FeishuConnManagerOpts>;

  constructor(opts: FeishuConnManagerOpts) {
    this.opts = {
      onMessageFor: opts.onMessageFor,
      wsFactory: opts.wsFactory ?? ((b) => createFeishuWSClient({
        appId: b.app_id,
        appSecret: b.app_secret,
        domain: (b.domain === 'lark' ? 'lark' : 'feishu') as 'feishu' | 'lark',
      })),
      clientFactory: opts.clientFactory ?? ((b) => createFeishuClient({
        appId: b.app_id,
        appSecret: b.app_secret,
        domain: (b.domain === 'lark' ? 'lark' : 'feishu') as 'feishu' | 'lark',
      })),
    };
  }

  /** 启动时扫 DB 拉所有活跃绑定,逐个起 WS 连接。 */
  async startAll(): Promise<void> {
    const bindings = await dao.feishuBindings.listActive();
    for (const b of bindings) this.startOne(b);
    console.log(`[FeishuConnectionManager] started ${bindings.length} connections`);
  }

  /**
   * 起单个 binding 的 WS 长连接。幂等: 同 id 重入直接 no-op。
   *
   * 内部流程:
   *   1. 构造 Lark.WSClient + Lark.Client (可由工厂注入)
   *   2. 构造 EventDispatcher,注册 im.message.receive_v1 → onMessageFor(binding, client)
   *   3. ws.start({ eventDispatcher }) 启动 WS (不 await, 连接在后台保持)
   *   4. 把 WSClient 存入内部 Map (键: binding.id)
   */
  startOne(binding: FeishuBinding): void {
    if (this.connections.has(binding.id)) return;

    const ws = this.opts.wsFactory(binding);
    const client = this.opts.clientFactory(binding);
    const handle = this.opts.onMessageFor(binding, client);

    const dispatcher = new Lark.EventDispatcher({});
    dispatcher.register({
      'im.message.receive_v1': async (data) => {
        await handle(data);
      },
    });

    // start 返回 Promise<void> 但连接是持久的 (阻塞直到断开/关闭)
    // 不 await: 后台运行,错误静默记录
    ws.start({ eventDispatcher: dispatcher }).catch((e: unknown) => {
      console.error(`[FeishuConnectionManager] ws for binding ${binding.id} errored:`, e);
      this.connections.delete(binding.id);
    });

    this.connections.set(binding.id, ws);
  }

  /**
   * 停单个连接 (解绑 / 外部停用时调用)。
   * SDK WSClient 无 stop() 方法, 用 close() 关闭底层 WebSocket。
   */
  stopOne(bindingId: string): void {
    const ws = this.connections.get(bindingId);
    if (!ws) return;
    try {
      ws.close();
    } catch (e) {
      // SDK 可能在未连接时抛, 吞掉
      console.warn(`[FeishuConnectionManager] close for binding ${bindingId} threw:`, e);
    }
    this.connections.delete(bindingId);
  }

  /** 停所有连接 (SIGTERM 调用)。 */
  async stopAll(): Promise<void> {
    for (const [id] of this.connections) this.stopOne(id);
    this.connections.clear();
  }

  size(): number { return this.connections.size; }
}
