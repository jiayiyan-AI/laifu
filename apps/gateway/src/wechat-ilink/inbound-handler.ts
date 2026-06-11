/**
 * 收到 iLink 入站消息 → 异步 dispatch hermes Agent → 回调完成后 iLink 回复。
 *
 * 工厂模式: makeHandleInbound(deps) 返一个 OnMessageFactory,PollManager 会
 * 对每个 binding 调一次拿到 onMessage 回调注给 pollLoop。
 *
 * 流程 (异步化):
 *   1. parseInbound → 跳过 echo / 生成中 / 非 text
 *   2. 若 binding.thread_id 缺,新建 thread (source='wechat') + DAO.bindThread 回写
 *   3. 插入 user 消息到 Postgres + 创建 agent loop
 *   4. 异步 dispatch: 只等 202 ack,不等结果
 *   5. 结果通过回调路径 (internal-callback.ts) 返回,触发 sendText 回微信
 *
 * 微信回复上下文 (context_token + to_user_id) 存入进程内 Map，
 * 回调路由通过 wechatReplier 取用。
 */
import { parseInbound } from './inbound.js';
import type { OnMessageFactory } from './poll-manager.js';
import type { WechatBindingDao } from '../db/wechat-binding-dao.js';
import type { ThreadsDao } from '../db/threads-dao.js';
import type { MessageDao } from '../db/message-dao.js';
import type { AgentLoopDao } from '../db/agent-loop-dao.js';
import type { ContainerMappingCache } from '../db/cache.js';
import type { UsageDao } from '../db/usage-dao.js';
import { dispatchHermesChat } from '../lib/aca-call.js';
import { genId } from '@lingxi/db';
import { storePendingLoop } from '../lib/pending-loops.js';
import { log } from '../lib/logger.js';

const FALLBACK_TEXT = '处理失败，请稍后再试。';
const CONTAINER_NOT_READY_TEXT = '助理还在初始化，请稍后再试。';
const QUOTA_EXHAUSTED_TEXT = '你的额度已用完，请联系管理员充值后继续使用。';

/**
 * 进程内存储微信回复上下文，keyed by loop_id。
 * 回调路由通过 wechatReplier 使用此 map 发送回复。
 * 进程重启时丢失 — reaper 会将对应 loop 标 fail，用户下次发消息即可恢复。
 */
export const wechatReplyContexts = new Map<string, {
  toUserId: string;
  contextToken: string;
  client: { sendText: (a: { to_user_id: string; text: string; context_token: string }) => Promise<void> };
}>();

interface HandleInboundDeps {
  dao: WechatBindingDao;
  threadsDao: ThreadsDao;
  messageDao: MessageDao;
  agentLoopDao: AgentLoopDao;
  cache: ContainerMappingCache;
  fetchImpl?: typeof fetch;
  usageDao?: UsageDao;
}

const resolveThread = async (
  deps: HandleInboundDeps,
  binding: { id: string; user_id: string; thread_id: string | null },
): Promise<string> => {
  if (binding.thread_id) return binding.thread_id;
  const id = genId.thread;
  await deps.threadsDao.create({ id, user_id: binding.user_id, source: 'wechat', title: '微信' });
  await deps.dao.bindThread(binding.id, id);
  binding.thread_id = id;
  return id;
};

export const makeHandleInbound = (deps: HandleInboundDeps): OnMessageFactory => {
  return (binding, client) => async (raw: unknown) => {
    const msg = parseInbound(raw);
    if (!msg) return;

    let threadId: string;
    try {
      threadId = await resolveThread(deps, binding);
    } catch (e) {
      console.error('[handleInbound] resolveThread failed:', e);
      await safeSendText(client, msg, FALLBACK_TEXT);
      return;
    }

    // 配额检查
    if (deps.usageDao) {
      try {
        const b = await deps.usageDao.getBalance(binding.user_id);
        if (b.used_cny_month >= b.free_quota_cny_month && b.balance_cny <= 0) {
          await safeSendText(client, msg, QUOTA_EXHAUSTED_TEXT);
          return;
        }
      } catch (e) {
        log.warn({ event: 'wechat.quota.check.failed', user_id: binding.user_id, err: String(e) });
      }
    }

    // 容器 ready 检查
    const mapping = deps.cache.get(binding.user_id);
    if (!mapping || mapping.status !== 'ready' || !mapping.container_url) {
      await safeSendText(client, msg, CONTAINER_NOT_READY_TEXT);
      return;
    }

    // 插入 user 消息 + 创建 agent loop
    const userMsgId = genId.message;
    const loopId = genId.agentLoop;

    try {
      await deps.messageDao.insert({
        id: userMsgId,
        thread_id: threadId,
        role: 'user',
        content_type: 'text',
        content: msg.text,
        source: 'wechat',
      });
      await deps.agentLoopDao.create({ id: loopId, thread_id: threadId, message_id: userMsgId });
    } catch (e) {
      console.error('[handleInbound] DB insert failed:', e);
      await safeSendText(client, msg, FALLBACK_TEXT);
      return;
    }

    // 保存微信回复上下文
    wechatReplyContexts.set(loopId, {
      toUserId: msg.from_user_id,
      contextToken: msg.context_token,
      client,
    });

    // 存入 pending loop 上下文
    storePendingLoop({ loopId, threadId, userId: binding.user_id, source: 'wechat' });

    // 异步 dispatch
    const sessionId = `wechat:${threadId}`;
    const dispatch = await dispatchHermesChat({
      containerUrl: mapping.container_url,
      userId: binding.user_id,
      threadId,
      source: 'wechat',
      sessionId,
      message: msg.text,
      loopId,
      fetchImpl: deps.fetchImpl,
    });

    if (!dispatch.ok) {
      wechatReplyContexts.delete(loopId);
      await deps.agentLoopDao.complete(loopId, 'fail');
      await safeSendText(client, msg, FALLBACK_TEXT);
    }
  };
};

const safeSendText = async (
  client: { sendText: (a: { to_user_id: string; text: string; context_token: string }) => Promise<void> },
  msg: { from_user_id: string; context_token: string },
  text: string,
): Promise<void> => {
  try {
    await client.sendText({
      to_user_id: msg.from_user_id,
      text,
      context_token: msg.context_token,
    });
  } catch (e) {
    console.error('[handleInbound] sendText failed:', e);
  }
};
