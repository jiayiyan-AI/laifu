/**
 * 收到 iLink 入站消息 → 异步 dispatch hermes Agent → 回调完成后 iLink 回复。
 *
 * 工厂模式: makeHandleInbound(opts?) 返一个 OnMessageFactory,PollManager 会
 * 对每个 binding 调一次拿到 onMessage 回调注给 pollLoop。
 */
import { parseInbound } from './inbound.js';
import type { OnMessageFactory } from './poll-manager.js';
import { dao } from '../db/index.js';
import { dispatchHermesChat } from '../lib/aca-call.js';
import { genId } from '@lingxi/db';
import { storePendingLoop, emitLoopEvent, HARD_DEADLINE_MS } from '../lib/pending-loops.js';
import { log } from '../lib/logger.js';

const FALLBACK_TEXT = '处理失败，请稍后再试。';
const CONTAINER_NOT_READY_TEXT = '助理还在初始化，请稍后再试。';
const QUOTA_EXHAUSTED_TEXT = '你的额度已用完，请联系管理员充值后继续使用。';

/**
 * 进程内存储微信回复上下文，keyed by loop_id。
 * 回调路由通过 wechatReplier 使用此 map 发送回复。
 * 进程重启时丢失 — boot 的 dao.agentLoops.failOrphans() 会把超时未完成的 loop 标 fail,
 * 用户下次发消息即可恢复。
 */
export const wechatReplyContexts = new Map<string, {
  toUserId: string;
  contextToken: string;
  client: { sendText: (a: { to_user_id: string; text: string; context_token: string }) => Promise<void> };
}>();

export interface HandleInboundOpts {
  fetchImpl?: typeof fetch;
}

const resolveThread = async (
  binding: { id: string; user_id: string; thread_id: string | null },
): Promise<string> => {
  if (binding.thread_id) return binding.thread_id;
  const id = genId.thread;
  await dao.threads.create({ id, user_id: binding.user_id, source: 'wechat', title: '微信' });
  await dao.wechatBindings.bindThread(binding.id, id);
  binding.thread_id = id;
  return id;
};

export const makeHandleInbound = (opts?: HandleInboundOpts): OnMessageFactory => {
  return (binding, client) => async (raw: unknown) => {
    const msg = parseInbound(raw);
    if (!msg) return;

    let threadId: string;
    try {
      threadId = await resolveThread(binding);
    } catch (e) {
      console.error('[handleInbound] resolveThread failed:', e);
      await safeSendText(client, msg, FALLBACK_TEXT);
      return;
    }

    // 配额检查
    try {
      const b = await dao.usage.getBalance(binding.user_id);
      if (b.used_cny_month >= b.free_quota_cny_month && b.balance_cny <= 0) {
        await safeSendText(client, msg, QUOTA_EXHAUSTED_TEXT);
        return;
      }
    } catch (e) {
      log.warn({ event: 'wechat.quota.check.failed', user_id: binding.user_id, err: String(e) });
    }

    // 容器 ready 检查
    const mapping = dao.cache.get(binding.user_id);
    if (!mapping || mapping.status !== 'ready' || !mapping.container_url) {
      await safeSendText(client, msg, CONTAINER_NOT_READY_TEXT);
      return;
    }

    // 插入 user 消息 + 创建 agent loop
    const userMsgId = genId.message;
    const loopId = genId.agentLoop;

    try {
      await dao.messages.insert({
        id: userMsgId,
        thread_id: threadId,
        role: 'user',
        content_type: 'text',
        content: msg.text,
        source: 'wechat',
      });
      await dao.agentLoops.create({ id: loopId, thread_id: threadId, message_id: userMsgId });
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

    // 存入 pending loop 上下文 + 启动 hard deadline timer
    storePendingLoop(
      { loopId, threadId, userId: binding.user_id, source: 'wechat' },
      {
        hardDeadlineMs: HARD_DEADLINE_MS,
        onDeadline: async () => {
          // 不动 iterated_at —— 晚到的 result callback 仍可通过 recordResult() 翻盘补回复。
          // 微信侧 fallback 文案不在本次范围,用户超时就是没回复 (DB row 已标 fail)。
          const changed = await dao.agentLoops.complete(loopId, 'fail').catch(() => false);
          if (changed) {
            log.warn({ event: 'loop.deadline.fired', loop_id: loopId, thread_id: threadId, user_id: binding.user_id, source: 'wechat' });
            wechatReplyContexts.delete(loopId);
            emitLoopEvent(loopId, { type: 'fail', error: '响应超时' });
          }
        },
      },
    );

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
      fetchImpl: opts?.fetchImpl,
    });

    if (!dispatch.ok) {
      wechatReplyContexts.delete(loopId);
      await dao.agentLoops.complete(loopId, 'fail');
      // 立刻释放 pending ctx + deadline timer
      emitLoopEvent(loopId, { type: 'fail', error: dispatch.error ?? `dispatch failed (${dispatch.status})` });
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
