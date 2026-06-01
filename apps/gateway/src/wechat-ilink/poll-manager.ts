/**
 * PollManager —— 进程内单例,管所有活跃 wechat 绑定的 iLink 长轮询循环。
 *
 * 生命周期:
 *   gateway 启动 → startAll() (DB 扫 is_active=true 逐个起 startOne)
 *   用户扫码绑定成功 → startOne(newBinding) 立即开循环
 *   解绑 / session_expired → stopOne(id) 取消 + DAO.deactivate
 *   SIGTERM/SIGINT → stopAll() 取消所有 + 等清理
 *
 * 每个 binding 一个 AbortController,abort 时 pollLoop 立刻退。
 * floating promise + .catch 兜底,任何异常都不会 unhandledRejection。
 */
import { pollLoop } from './poll-loop.js';
import { makeIlinkClient, type IlinkClient } from './client.js';
import type { WechatBinding, WechatBindingDao } from '../db/wechat-binding-dao.js';

export type OnMessageFactory = (binding: WechatBinding) => (raw: unknown) => Promise<void>;

export interface PollManagerOpts {
  dao: WechatBindingDao;
  /** 每个 binding 一个 inbound 回调工厂; B6 实现 (resolve thread → hermes → sendText)。 */
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
      dao: opts.dao,
      onMessageFor: opts.onMessageFor,
      clientFactory: opts.clientFactory ?? makeIlinkClient,
      runLoop: opts.runLoop ?? pollLoop,
    };
  }

  /** 启动时扫 DB 拉所有活跃绑定,逐个起循环。 */
  async startAll(): Promise<void> {
    const bindings = await this.opts.dao.listActive();
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

    // floating promise: 不 await,后台跑。.catch 兜底防 unhandledRejection。
    this.opts.runLoop({
      client,
      initialCursor: binding.updates_cursor,
      signal: ac.signal,
      onMessage: this.opts.onMessageFor(binding),
      onCursorUpdate: (c) => this.opts.dao.updateCursor(binding.id, c),
      onSessionExpired: async () => {
        await this.opts.dao.deactivate(binding.id);
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
