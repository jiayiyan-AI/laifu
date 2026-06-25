/**
 * 飞书入站消息 → 异步 dispatch hermes Agent → 回调完成后回飞书。
 *
 * 完全对标 wechat-ilink/inbound-handler.ts 的入站处理:
 *   - 只服务绑定者本人 (open_id 鉴权)
 *   - 进程内 message_id 去重
 *   - 走和微信完全相同的异步 dispatch + 回调链
 *     (dao.cache.get 拿 containerUrl → storePendingLoop → dispatchHermesChat)
 *
 * 飞书侧支持文本 + 图片 (无图文聚合 / slash 拦截 / context_token)。
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
import type { InboxAttachmentRef } from '@lingxi/shared';
import { ensureContainerWarm } from '../lib/container-warm-cache.js';
import { uploadImageStream } from '../lib/inbox-image-uploader.js';
import { buildInboxPrompt } from '../lib/inbox-image-prompt.js';
import { classifyMessage, runIntercept } from '../lib/slash-filter.js';
import { dropThreadSilently } from '../lib/drop-thread.js';
import {
  openFeishuImageStream,
  FeishuMediaTooLargeError,
  FEISHU_IMAGE_MAX_BYTES,
} from './feishu-media-fetcher.js';

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
 * 有界: 超过 SEEN_MAX 整清, 防 Always-On 进程长跑内存泄漏。
 */
const SEEN_MAX = 5000;
const seen = new Set<string>();

/** 返回 true=新消息(已加入); false=已见过(重复)。 */
const markSeen = (id: string): boolean => {
  if (seen.has(id)) return false;
  if (seen.size >= SEEN_MAX) seen.clear();
  seen.add(id);
  return true;
};

/** 测试 reset 用。生产代码不要调。 */
export const __resetSeenForTests = (): void => {
  seen.clear();
};

/** 飞书 im.message.receive_v1 事件里我们需要的字段。 */
interface FeishuInboundEvent {
  sender?: { sender_id?: { open_id?: string } };
  message?: {
    message_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
  };
}

/** 飞书 text 消息 content 是 JSON `{"text":"..."}`; 解析失败 / 空 → null。 */
const parseFeishuText = (content: string): string | null => {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return null; }
  if (parsed && typeof parsed === 'object' && 'text' in parsed) {
    const t: unknown = parsed.text;
    if (typeof t === 'string' && t.trim().length > 0) return t.trim();
  }
  return null;
};

/** 飞书 image 消息 content 是 JSON `{"image_key":"img_v2_..."}`; 解析失败 / 缺 key → null。 */
const parseImageKey = (content: string): string | null => {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return null; }
  if (parsed && typeof parsed === 'object' && 'image_key' in parsed) {
    const k: unknown = parsed.image_key;
    if (typeof k === 'string' && k.length > 0) return k;
  }
  return null;
};

/**
 * 飞书 post(富文本/图文混排) 消息 content 是 JSON:
 *   { title?, content: [[ {tag:'text',text}, {tag:'img',image_key}, ... ], ... ] }
 * 抽出所有 text 段(按段落换行拼接) + 所有 img 的 image_key。解析失败 → null。
 */
const parsePostContent = (content: string): { text: string; imageKeys: string[] } | null => {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || !('content' in parsed)) return null;
  const paragraphs: unknown = parsed.content;
  if (!Array.isArray(paragraphs)) return null;

  const lines: string[] = [];
  const imageKeys: string[] = [];
  for (const para of paragraphs) {
    if (!Array.isArray(para)) continue;
    let line = '';
    for (const run of para) {
      if (!run || typeof run !== 'object' || !('tag' in run)) continue;
      const tag: unknown = run.tag;
      if (tag === 'text' && 'text' in run) {
        const t: unknown = run.text;
        if (typeof t === 'string') line += t;
      } else if (tag === 'img' && 'image_key' in run) {
        const k: unknown = run.image_key;
        if (typeof k === 'string' && k.length > 0) imageKeys.push(k);
      }
    }
    if (line) lines.push(line);
  }
  return { text: lines.join('\n').trim(), imageKeys };
};

interface FeishuImageFetchInput {
  binding: FeishuBinding;
  client: Lark.Client;
  senderOpenId: string;
  messageId: string;
  imageKeys: string[];
  containerUrl: string;
}

/**
 * 逐张下载飞书图片 → 上传容器 /inbox/image → 产出 cache_path 列表。**自行吞错**(失败写 fetchErrors), 不 throw。
 * 图片过大单独提示用户(不进 fetchErrors, 避免上层再叠加通用失败文案)。
 * **故意串行**: 容器 maxReplicas=1, 同时多个 POST 在单 replica 上 fight CPU + sync fs write。
 */
const fetchFeishuImages = async (
  input: FeishuImageFetchInput,
): Promise<{ attachments: InboxAttachmentRef[]; fetchErrors: string[] }> => {
  const { binding, client, senderOpenId, messageId, imageKeys, containerUrl } = input;
  const attachments: InboxAttachmentRef[] = [];
  const fetchErrors: string[] = [];

  // 先唤醒容器: 下载虽走飞书 API, 但随后要 POST 容器, 冷启动期会被挂住。
  try {
    await ensureContainerWarm(binding.user_id, containerUrl);
  } catch (e) {
    log.warn({ event: 'feishu.image.wake.failed', user_id: binding.user_id, err: String(e) });
    fetchErrors.push('容器唤醒失败');
    return { attachments, fetchErrors };
  }

  for (const imageKey of imageKeys) {
    try {
      const stream = await openFeishuImageStream(client, messageId, imageKey, { maxBytes: FEISHU_IMAGE_MAX_BYTES });
      const up = await uploadImageStream({
        containerUrl,
        userId: binding.user_id,
        body: stream.body,
        contentType: stream.content_type,
        maxBytes: FEISHU_IMAGE_MAX_BYTES,
        channel: 'feishu',
      });
      attachments.push({ kind: 'image', cache_path: up.cache_path, content_type: up.content_type, size: up.size });
    } catch (e) {
      if (e instanceof FeishuMediaTooLargeError) {
        await safeSend(
          client, senderOpenId,
          `图片过大 (${(e.actual / 1e6).toFixed(1)} MB，上限 ${(e.limit / 1e6).toFixed(0)} MB)，请压缩或截图后重发。`,
        );
      } else {
        log.warn({ event: 'feishu.image.fetch.failed', user_id: binding.user_id, err: e instanceof Error ? e.message : String(e) });
        fetchErrors.push(e instanceof Error ? e.message : String(e));
      }
    }
  }
  return { attachments, fetchErrors };
};

interface FeishuDispatchInput {
  binding: FeishuBinding;
  client: Lark.Client;
  senderOpenId: string;
  threadId: string;
  containerUrl: string;
  dbContent: string;   // 入库 content
  promptText: string;  // 派发给 hermes
}

/** 写库 → 建 loop → 存 pending(挂超时) → dispatchHermesChat。失败回兜底文案。主路径与 /new args 共用。 */
const dispatchFeishu = async (input: FeishuDispatchInput): Promise<void> => {
  const { binding, client, senderOpenId, threadId, containerUrl, dbContent, promptText } = input;

  const userMsgId = genId.message;
  const loopId = genId.agentLoop;
  try {
    await dao.messages.insert({
      id: userMsgId,
      thread_id: threadId,
      role: 'user',
      content_type: 'text',
      content: dbContent,
      source: 'feishu',
    });
    await dao.agentLoops.create({ id: loopId, thread_id: threadId, message_id: userMsgId });
  } catch (e) {
    console.error('[feishuInbound] DB insert failed:', e);
    await safeSend(client, senderOpenId, FALLBACK_TEXT);
    return;
  }

  feishuReplyContexts.set(loopId, { toOpenId: senderOpenId, client });

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

  const sessionId = `feishu:${threadId}`;
  const dispatch = await dispatchHermesChat({
    containerUrl,
    userId: binding.user_id,
    threadId,
    source: 'feishu',
    sessionId,
    message: promptText,
    loopId,
  });

  if (!dispatch.ok) {
    feishuReplyContexts.delete(loopId);
    await dao.agentLoops.complete(loopId, 'fail');
    emitLoopEvent(loopId, { type: 'fail', error: dispatch.error ?? `dispatch failed (${dispatch.status})` });
    await safeSend(client, senderOpenId, FALLBACK_TEXT);
  }
};

/**
 * 飞书 `/new`: 真开新会话 (建新 thread + bindThread)。对齐 wechat handleWechatNew —— IM 里没有
 * web UI 的"新对话"按钮, 只能靠 slash 开新会话。带 args 则把后续文案作为新会话首条派发。
 */
const handleFeishuNew = async (
  binding: FeishuBinding,
  client: Lark.Client,
  senderOpenId: string,
  args: string,
  dropOld = false,
): Promise<void> => {
  // /drop: 先把当前 thread 静默删掉 (DB + ACA session, fire-and-forget, 不等待不管成败)
  const oldThreadId = binding.thread_id;
  if (dropOld && oldThreadId) {
    const m = dao.cache.get(binding.user_id);
    const containerUrl = m?.status === 'ready' && m.container_url ? m.container_url : null;
    dropThreadSilently({ userId: binding.user_id, threadId: oldThreadId, source: 'feishu', containerUrl });
  }
  const newThreadId = genId.thread;
  try {
    await dao.threads.create({ id: newThreadId, user_id: binding.user_id, source: 'feishu', title: '飞书' });
    await dao.feishuBindings.bindThread(binding.id, newThreadId);
  } catch (e) {
    console.error('[feishuInbound] /new create thread failed:', e);
    await safeSend(client, senderOpenId, FALLBACK_TEXT);
    return;
  }
  binding.thread_id = newThreadId; // in-memory 同步, 后续轮次直接复用
  log.info({ event: 'feishu.slash.new', user_id: binding.user_id, new_thread_id: newThreadId, has_args: args.length > 0 });
  const opened = dropOld ? '已删除当前会话并开启新会话' : '已开启新会话';

  if (!args) {
    await safeSend(client, senderOpenId, `✓ ${opened}，你可以开始新的对话了。`);
    return;
  }
  // 带 args: 容器 ready → 先确认已开新会话 → 派发首条
  const mapping = dao.cache.get(binding.user_id);
  if (!mapping || mapping.status !== 'ready' || !mapping.container_url) {
    await safeSend(client, senderOpenId, CONTAINER_NOT_READY_TEXT);
    return;
  }
  await safeSend(client, senderOpenId, `✓ ${opened}，正在处理你的消息…`);
  await dispatchFeishu({
    binding, client, senderOpenId,
    threadId: newThreadId,
    containerUrl: mapping.container_url,
    dbContent: args,
    promptText: args,
  });
};

export const makeFeishuInbound = () => {
  return (binding: FeishuBinding, client: Lark.Client) => async (raw: unknown): Promise<void> => {
    const evt = raw as FeishuInboundEvent;
    const messageId = evt.message?.message_id;
    const senderOpenId = evt.sender?.sender_id?.open_id;
    const messageType = evt.message?.message_type;
    const content = evt.message?.content;

    // 缺关键字段 → 丢弃
    if (!messageId || !senderOpenId || !messageType || !content) return;

    // MVP 只处理私聊 (p2p), 群聊消息忽略
    if (evt.message?.chat_type !== 'p2p') return;

    // 鉴权: 只服务绑定者本人, 别人发的直接忽略 (不回, 不服务)
    if (senderOpenId !== binding.owner_open_id) return;

    // 去重: 同 message_id 已见过 → return (有界 Set, 防长跑内存泄漏)
    if (!markSeen(messageId)) return;

    // 解析消息 → { text, imageKeys }; text / image / post 都支持, 其余类型提示一次
    let text = '';
    let imageKeys: string[] = [];
    if (messageType === 'text') {
      text = parseFeishuText(content) ?? '';
    } else if (messageType === 'image') {
      const k = parseImageKey(content);
      if (k) imageKeys = [k];
    } else if (messageType === 'post') {
      const post = parsePostContent(content);
      if (post) { text = post.text; imageKeys = post.imageKeys; }
    } else {
      await safeSend(client, senderOpenId, TEXT_ONLY_TEXT);
      return;
    }

    // Hermes slash 拦截 (详见 lib/slash-filter.ts) — 与微信一致:
    //   /new 真生效 (网关建新 thread + bindThread); 其余 intercept 走通用 render 文案。
    const slash = classifyMessage(text);
    if (slash.kind === 'intercept') {
      if (slash.cmd === 'new') {
        await handleFeishuNew(binding, client, senderOpenId, slash.args);
        return;
      }
      if (slash.cmd === 'drop') {
        await handleFeishuNew(binding, client, senderOpenId, slash.args, true);
        return;
      }
      const reply = await runIntercept(slash, { userId: binding.user_id, threadId: binding.thread_id ?? '' });
      log.info({ event: 'feishu.slash.intercepted', user_id: binding.user_id, cmd: slash.cmd, log_tag: slash.logTag });
      await safeSend(client, senderOpenId, reply);
      return;
    }

    // 无文字且无图 → 丢弃 (空消息 / 坏 content)
    if (!text && imageKeys.length === 0) return;

    // 1 用户 1 thread: 无 thread 说明绑定尚未完成, 不 dispatch
    const threadId = binding.thread_id;
    if (!threadId) return;

    log.info({
      event: 'feishu.inbound.arrived',
      thread_id: threadId,
      from_open_id: senderOpenId,
      message_id: messageId,
      has_image: imageKeys.length > 0,
      image_count: imageKeys.length,
      text_len: text.length,
    });

    // 容器 ready 闸 (同步, 不 ready → 提示并丢弃; 图片下载后还要 POST 容器, 也要容器活着)
    const mapping = dao.cache.get(binding.user_id);
    if (!mapping || mapping.status !== 'ready' || !mapping.container_url) {
      await safeSend(client, senderOpenId, CONTAINER_NOT_READY_TEXT);
      return;
    }
    const containerUrl = mapping.container_url;

    // 有图: 下载 → 上传 → 拼本地路径 prompt; 纯文本: 原样
    let promptText: string;
    if (imageKeys.length > 0) {
      const { attachments, fetchErrors } = await fetchFeishuImages({ binding, client, senderOpenId, messageId, imageKeys, containerUrl });
      if (attachments.length === 0 && !text) {
        // 无文字且图全失败: 太大已单独提示(fetchErrors 空)→ 静默; 其他失败 → 通用文案
        if (fetchErrors.length > 0) await safeSend(client, senderOpenId, '图片处理失败了，请稍后重发试试~');
        return;
      }
      promptText = buildInboxPrompt(text, attachments, fetchErrors);
    } else {
      promptText = text;
    }
    const dbContent = promptText;

    // 写库 + 建 loop + 派发 (复用 dispatchFeishu, 与 /new args 同一路径)
    await dispatchFeishu({ binding, client, senderOpenId, threadId, containerUrl, dbContent, promptText });
  };
};

const safeSend = async (client: Lark.Client, toOpenId: string, text: string): Promise<void> => {
  try {
    await sendFeishuMessage(client, toOpenId, text);
  } catch (e) {
    console.error('[feishuInbound] sendFeishuMessage failed:', e);
  }
};
