/**
 * 收到 iLink 入站消息 → 跑 hermes Agent → iLink 回复。
 *
 * 工厂模式: makeHandleInbound(deps) 返一个 OnMessageFactory,PollManager 会
 * 对每个 binding 调一次拿到 onMessage 回调注给 pollLoop。
 *
 * 流程 (1 用户 1 thread 简化):
 *   1. parseInbound → 跳过 echo / 生成中 / 非 text
 *   2. 若 binding.thread_id 缺,新建 thread (source='wechat') + DAO.bindThread 回写
 *   3. 容器 ready 时调 hermes POST /chat,session_id='wechat:<thread_id>'
 *      hermes 报错 / 容器没起 → 发兜底文案,不阻断循环
 *   4. client.sendText 把回复发回原对话; sendText 报错只 log 不抛
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ContainerChatResponse } from '@lingxi/shared';
import { parseInbound } from './inbound.js';
import type { OnMessageFactory } from './poll-manager.js';
import type { WechatBindingDao } from '../db/wechat-binding-dao.js';
import type { ContainerMappingCache } from '../db/cache.js';
import type { ThreadStreamHub } from '../lib/thread-stream.js';

const FALLBACK_TEXT = '处理失败,请稍后再试。';
const CONTAINER_NOT_READY_TEXT = '助理还在初始化,请稍后再试。';

const newThreadId = (): string =>
  `thr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

interface HandleInboundDeps {
  dao: WechatBindingDao;
  sb: SupabaseClient;
  cache: ContainerMappingCache;
  /** SSE 通知 hub; 处理完一条消息后 emit('thread-updated') 让 web UI 自动刷新。 */
  hub?: ThreadStreamHub;
  /** 注入用,测试里替成 vi.fn 控制 hermes 行为。 */
  fetchImpl?: typeof fetch;
}

const resolveThread = async (
  deps: HandleInboundDeps,
  binding: { id: string; user_id: string; thread_id: string | null },
): Promise<string> => {
  if (binding.thread_id) return binding.thread_id;
  const id = newThreadId();
  const { error } = await deps.sb.from('threads').insert({
    id,
    user_id: binding.user_id,
    source: 'wechat',
    title: '微信',
    archived: false,
  });
  if (error) throw new Error(`thread insert failed: ${error.message}`);
  await deps.dao.bindThread(binding.id, id);
  binding.thread_id = id;                       // in-memory 更新,下一条消息复用
  return id;
};

const callHermes = async (
  deps: HandleInboundDeps,
  userId: string,
  threadId: string,
  userText: string,
): Promise<string | null> => {
  const mapping = deps.cache.get(userId);
  if (!mapping || mapping.status !== 'ready' || !mapping.container_url) {
    return null;                                // 让上游用 CONTAINER_NOT_READY_TEXT
  }
  const sessionId = `wechat:${threadId}`;
  const fetcher = deps.fetchImpl ?? fetch;
  const resp = await fetcher(`${mapping.container_url}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: userText,
      session_id: sessionId,
      source: 'wechat',
    }),
  });
  if (!resp.ok) throw new Error(`hermes /chat returned ${resp.status}`);
  const body = await resp.json() as ContainerChatResponse;
  if (typeof body.reply !== 'string') throw new Error('hermes missing reply');
  return body.reply;
};

export const makeHandleInbound = (deps: HandleInboundDeps): OnMessageFactory => {
  return (binding, client) => async (raw: unknown) => {
    const msg = parseInbound(raw);
    if (!msg) return;

    // 1. resolve thread
    let threadId: string;
    try {
      threadId = await resolveThread(deps, binding);
    } catch (e) {
      console.error('[handleInbound] resolveThread failed:', e);
      // thread 都建不出来,没法跑 hermes;给用户回个兜底
      await safeSendText(client, msg, FALLBACK_TEXT);
      return;
    }

    // 2. 跑 hermes
    let replyText: string;
    try {
      const r = await callHermes(deps, binding.user_id, threadId, msg.text);
      replyText = r ?? CONTAINER_NOT_READY_TEXT;
    } catch (e) {
      console.error('[handleInbound] hermes call failed:', e);
      replyText = FALLBACK_TEXT;
    }

    // 3. 回复
    await safeSendText(client, msg, replyText);

    // 4. 通知 web UI 该 thread 有更新 (hermes SQLite 此时已落 user+assistant 两条)
    //    push notification only — 不带正文,前端收到 event 后调一次 /messages 拉历史
    deps.hub?.emit(threadId, 'thread-updated', { thread_id: threadId });
  };
};

const safeSendText = async (
  client: { sendText: (a: any) => Promise<void> },
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
