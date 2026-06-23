/**
 * 飞书入站消息 → 异步 dispatch hermes Agent → 回调完成后回飞书。
 *
 * 完全对标 wechat-ilink/inbound-handler.ts 的入站处理:
 *   - 只服务绑定者本人 (open_id 鉴权)
 *   - 进程内 message_id 去重
 *   - 走和微信完全相同的异步 dispatch + 回调链
 *     (dao.cache.get 拿 containerUrl → storePendingLoop → dispatchHermesChat)
 *
 * 飞书侧比微信简单: 仅文本 (无图片聚合 / slash 拦截 / context_token)。
 * 工厂模式: makeFeishuInbound() 返一个 (binding, client) => onMessage,
 * WS dispatcher 对每个活跃 binding 调一次拿到 onMessage 回调注给事件循环。
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { dao } from '../db/index.js';
import { genId } from '@lingxi/db';
import { dispatchHermesChat } from '../lib/aca-call.js';
import { storePendingLoop, emitLoopEvent, HARD_DEADLINE_MS } from '../lib/pending-loops.js';
import { sendFeishuMessage } from './client.js';
import { log } from '../lib/logger.js';
import type { FeishuBinding } from '../db/feishu-binding-dao.js';

const FALLBACK_TEXT = '处理失败，请稍后再试。';
const CONTAINER_NOT_READY_TEXT = '助理还在初始化，请稍后再试。';
const TEXT_ONLY_TEXT = '当前仅支持文本消息。';

/**
 * 进程内存储飞书回复上下文，keyed by loop_id。
 * 回调路由通过 feishuReplier (index.ts 消费) 使用此 map 发送回复。
 * 进程重启时丢失 — boot 的 dao.agentLoops.failOrphans() 会把超时未完成的 loop 标 fail。
 */
export const feishuReplyContexts = new Map<string, {
  toOpenId: string;
  client: Lark.Client;
}>();

/**
 * 进程内 message_id 去重集合。飞书 WS 在网络抖动 / 重连时会重投同一事件,
 * 必须按 message_id 幂等掉, 否则同一条消息会 dispatch 多次。
 */
const seen = new Set<string>();

/** 测试 reset 用。生产代码不要调。 */
export const __resetSeenForTests = (): void => {
  seen.clear();
};

/** 飞书 im.message.receive_v1 事件里我们需要的字段。 */
interface FeishuInboundEvent {
  sender?: { sender_id?: { open_id?: string } };
  message?: {
    message_id?: string;
    message_type?: string;
    content?: string;
  };
}

export const makeFeishuInbound = () => {
  return (binding: FeishuBinding, client: Lark.Client) => async (raw: unknown): Promise<void> => {
    const evt = raw as FeishuInboundEvent;
    const messageId = evt.message?.message_id;
    const senderOpenId = evt.sender?.sender_id?.open_id;
    const messageType = evt.message?.message_type;
    const content = evt.message?.content;

    // 缺关键字段 → 丢弃
    if (!messageId || !senderOpenId || !messageType || !content) return;

    // 鉴权: 只服务绑定者本人, 别人发的直接忽略 (不回, 不服务)
    if (senderOpenId !== binding.owner_open_id) return;

    // 去重: 同 message_id 已见过 → return
    if (seen.has(messageId)) return;
    seen.add(messageId);

    // 非 text 类型: 提示一次, 不 dispatch
    if (messageType !== 'text') {
      await safeSend(client, senderOpenId, TEXT_ONLY_TEXT);
      return;
    }

    // 解析 text content (飞书 text 消息 content 是 JSON 字符串 `{"text":"..."}`)
    let text: string;
    try {
      const parsed = JSON.parse(content) as { text?: string };
      text = (parsed.text ?? '').trim();
    } catch {
      return;
    }
    if (!text) return;

    // 1 用户 1 thread: 无 thread 说明绑定尚未完成, 不 dispatch
    const threadId = binding.thread_id;
    if (!threadId) return;

    log.info({
      event: 'feishu.inbound.arrived',
      thread_id: threadId,
      from_open_id: senderOpenId,
      message_id: messageId,
      text_len: text.length,
    });

    // 容器 ready 闸 (同步, 不 ready → 提示并丢弃)
    const mapping = dao.cache.get(binding.user_id);
    if (!mapping || mapping.status !== 'ready' || !mapping.container_url) {
      await safeSend(client, senderOpenId, CONTAINER_NOT_READY_TEXT);
      return;
    }
    const containerUrl = mapping.container_url;

    // 插入 user 消息 + 创建 agent loop
    const userMsgId = genId.message;
    const loopId = genId.agentLoop;
    try {
      await dao.messages.insert({
        id: userMsgId,
        thread_id: threadId,
        role: 'user',
        content_type: 'text',
        content: text,
        source: 'feishu',
      });
      await dao.agentLoops.create({ id: loopId, thread_id: threadId, message_id: userMsgId });
    } catch (e) {
      console.error('[feishuInbound] DB insert failed:', e);
      await safeSend(client, senderOpenId, FALLBACK_TEXT);
      return;
    }

    // 保存飞书回复上下文
    feishuReplyContexts.set(loopId, { toOpenId: senderOpenId, client });

    // 存入 pending loop 上下文 + 启动 hard deadline timer
    storePendingLoop(
      { loopId, threadId, userId: binding.user_id, source: 'feishu' },
      {
        hardDeadlineMs: HARD_DEADLINE_MS,
        onDeadline: async () => {
          const changed = await dao.agentLoops.complete(loopId, 'fail').catch(() => false);
          if (changed) {
            log.warn({ event: 'loop.deadline.fired', loop_id: loopId, thread_id: threadId, user_id: binding.user_id, source: 'feishu' });
            feishuReplyContexts.delete(loopId);
            emitLoopEvent(loopId, { type: 'fail', error: '响应超时' });
          }
        },
      },
    );

    // 异步 dispatch
    const sessionId = `feishu:${threadId}`;
    const dispatch = await dispatchHermesChat({
      containerUrl,
      userId: binding.user_id,
      threadId,
      source: 'feishu',
      sessionId,
      message: text,
      loopId,
    });

    if (!dispatch.ok) {
      feishuReplyContexts.delete(loopId);
      await dao.agentLoops.complete(loopId, 'fail');
      emitLoopEvent(loopId, { type: 'fail', error: dispatch.error ?? `dispatch failed (${dispatch.status})` });
      await safeSend(client, senderOpenId, FALLBACK_TEXT);
    }
  };
};

const safeSend = async (client: Lark.Client, toOpenId: string, text: string): Promise<void> => {
  try {
    await sendFeishuMessage(client, toOpenId, text);
  } catch (e) {
    console.error('[feishuInbound] sendFeishuMessage failed:', e);
  }
};
