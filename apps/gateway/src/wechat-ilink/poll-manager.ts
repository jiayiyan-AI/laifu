/**
 * PollManager —— 进程内单例,管所有活跃 wechat 绑定的 iLink 长轮询循环。
 */
import { pollLoop } from './poll-loop.js';
import { makeIlinkClient, type IlinkClient } from './client.js';
import { dao } from '../db/index.js';
import type { WechatBinding } from '../db/wechat-binding-dao.js';

/**
 * 工厂签名: 收到 (binding, client) 后返回 inbound 回调。
 */
export type OnMessageFactory = (
  binding: WechatBinding,
  client: IlinkClient,
) => (raw: unknown) => Promise<void>;

export interface PollManagerOpts {
  /** 每个 binding 一个 inbound 回调工厂 */
  onMessageFor: OnMessageFactory;
  /** 注入用,测试里可替成 mock。 */
  clientFactory?: (opts: { botToken: string; baseUrl: string }) => IlinkClient;
  /** 注入用,测试里可替成立即解析 / hang 控制。 */
  runLoop?: typeof pollLoop;
}

export class PollManager {
  private pollers = new Map<string, AbortController>();
  private readonly opts: Required<PollManagerOpts>;

  constructor(opts: PollManagerOpts) {
    this.opts = {
      onMessageFor: opts.onMessageFor,
      clientFactory: opts.clientFactory ?? makeIlinkClient,
      runLoop: opts.runLoop ?? pollLoop,
    };
  }

  /** 启动时扫 DB 拉所有活跃绑定,逐个起循环。 */
  async startAll(): Promise<void> {
    const bindings = await dao.wechatBindings.listActive();
    for (const b of bindings) this.startOne(b);
    console.log(`[PollManager] started ${bindings.length} pollers`);
  }

  /** 起单个 binding 的循环。幂等:同 id 重入直接 no-op。 */
  startOne(binding: WechatBinding): void {
    if (this.pollers.has(binding.id)) return;
    const ac = new AbortController();
    this.pollers.set(binding.id, ac);

    const client = this.opts.clientFactory({
      botToken: binding.bot_token,
      baseUrl: binding.base_url,
    });

    this.opts.runLoop({
      client,
      initialCursor: binding.updates_cursor,
      signal: ac.signal,
      onMessage: this.opts.onMessageFor(binding, client),
      onCursorUpdate: (c) => dao.wechatBindings.updateCursor(binding.id, c),
      onSessionExpired: async () => {
        await dao.wechatBindings.deactivate(binding.id);
        this.pollers.delete(binding.id);
        console.log(`[PollManager] binding ${binding.id} session expired, deactivated`);
      },
    })
      .then(() => { this.pollers.delete(binding.id); })
      .catch((e: unknown) => {
        const err = e as { name?: string };
        if (err.name === 'AbortError') {
          this.pollers.delete(binding.id);
          return;
        }
        console.error(`[PollManager] poller ${binding.id} crashed:`, e);
        this.pollers.delete(binding.id);
      });
  }

  /** 停单个 (解绑/session_expired 调用)。 */
  stopOne(bindingId: string): void {
    const ac = this.pollers.get(bindingId);
    if (!ac) return;
    ac.abort();
    this.pollers.delete(bindingId);
  }

  /** 停所有 (SIGTERM 调用)。 */
  async stopAll(): Promise<void> {
    for (const [, ac] of this.pollers) ac.abort();
    this.pollers.clear();
  }

  size(): number { return this.pollers.size; }
}
