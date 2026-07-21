/**
 * 收到 iLink 入站消息 → 异步 dispatch hermes Agent → 回调完成后 iLink 回复。
 *
 * 工厂模式: makeHandleInbound() 返一个 OnMessageFactory,PollManager 会
 * 对每个 binding 调一次拿到 onMessage 回调注给 pollLoop。
 */
import { parseInbound } from './inbound.js';
import type { OnMessageFactory } from './poll-manager.js';
import { dao } from '../db/index.js';
import { dispatchHermesChat } from '../lib/aca-call.js';
import { genId } from '@lingxi/db';
import { storePendingLoop, emitLoopEvent, HARD_DEADLINE_MS } from '../lib/pending-loops.js';
import { log } from '../lib/logger.js';
import { classifyMessage, runIntercept } from '../lib/slash-filter.js';
import { dropThreadSilently } from '../lib/drop-thread.js';
import type { InboundPart } from './inbound.js';
import type { InboxAttachmentRef } from '@lingxi/shared';
import { ensureContainerWarm } from '../lib/container-warm-cache.js';
import {
  openDecryptedMediaStream,
  MediaTooLargeError,
  WECHAT_FILE_MAX_BYTES,
  WECHAT_IMAGE_MAX_BYTES,
} from './wechat-media-fetcher.js';
import { uploadInboxStream } from '../lib/inbox-uploader.js';
import { buildInboxPrompt } from '../lib/inbox-image-prompt.js';
import { enqueueThreadTask } from '../lib/thread-serializer.js';
import {
  aggregateInbound,
  flush,
  type AggregatedBurst,
} from './thread-aggregator.js';
import { WechatBinding } from '../db/wechat-binding-dao.js';
import { IlinkClient } from './client.js';
import { runWithTrace } from '../lib/trace-context.js';

type AttachmentPart = Exclude<InboundPart, { kind: 'text' }>;

const FALLBACK_TEXT = '处理失败，请稍后再试。';
const CONTAINER_NOT_READY_TEXT = '助理还在初始化，请稍后再试。';
const QUOTA_EXHAUSTED_TEXT = '你的额度已用完，请联系管理员充值后继续使用。';
const BUSY_QUEUE_TEXT = '正在处理前面的消息，稍等一下再发哦~';

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

/**
 * 软配额检查:本月已用完且余额 ≤0 → true(调用方回 QUOTA 文案并止)。
 * 查询失败按"通过"处理(不因 DB 抖动误伤用户)。在**派发前**(eager 下载图之前)调用,
 * 避免给已超额用户白下图。
 */
const isQuotaExhausted = async (userId: string): Promise<boolean> => {
  try {
    const b = await dao.usage.getBalance(userId);
    return b.used_cny_month >= b.free_quota_cny_month && b.balance_cny <= 0;
  } catch (e) {
    log.warn({ event: 'wechat.quota.check.failed', user_id: userId, err: String(e) });
    return false;
  }
};
/**
 * 构造一条消息的「附件下载+上传容器」任务（eager-fetch）。在 onMessage 内即建、串进聚合层的
 * uploadChain 立刻跑 —— 因 iLink download_url 带 TTL，绝不能拖到 flush 后才取。产出稳定的
 * cache_path，且自行吞错（失败写 fetchErrors），不 throw。
 */
const buildUploadThunk = (
  binding: { id: string; user_id: string },
  client: WechatClient,
  msg: ParsedMsg,
  attachmentParts: AttachmentPart[],
  containerUrl: string,
) => async (): Promise<{ attachments: InboxAttachmentRef[]; fetchErrors: string[] }> => {
  const attachments: InboxAttachmentRef[] = [];
  const fetchErrors: string[] = [];

  try {
    await ensureContainerWarm(binding.user_id, containerUrl);
  } catch (e) {
    log.warn({ event: 'wechat.attachment.wake.failed', user_id: binding.user_id, err: String(e) });
    fetchErrors.push('容器唤醒失败');
    return { attachments, fetchErrors };
  }

  // 故意串行：容器 maxReplicas=1，同时多个 POST 会争用 CPU + sync fs write。
  for (const attachment of attachmentParts) {
    const maxBytes = attachment.kind === 'file' ? WECHAT_FILE_MAX_BYTES : WECHAT_IMAGE_MAX_BYTES;
    try {
      const stream = await openDecryptedMediaStream(attachment, { maxBytes });
      const up = await uploadInboxStream({
        containerUrl,
        userId: binding.user_id,
        body: stream.body,
        contentType: stream.content_type,
        maxBytes,
        kind: attachment.kind,
        channel: 'wechat',
        filename: attachment.kind === 'file' ? attachment.filename : undefined,
      });
      if (attachment.kind === 'file') {
        attachments.push({ kind: 'file', cache_path: up.cache_path, content_type: up.content_type, filename: attachment.filename, size: up.size });
      } else {
        attachments.push({ kind: 'image', cache_path: up.cache_path, content_type: up.content_type, size: up.size });
      }
    } catch (e) {
      const label = attachment.kind === 'file' ? '文件' : '图片';
      if (e instanceof MediaTooLargeError) {
        await safeSendText(
          client, msg,
          `${label}过大 (${(e.actual / 1e6).toFixed(1)} MB，上限 ${(e.limit / 1e6).toFixed(0)} MB)，请压缩后重发。`,
        );
      } else {
        log.warn({ event: `wechat.${attachment.kind}.fetch.failed`, user_id: binding.user_id, err: e instanceof Error ? e.message : String(e) });
        fetchErrors.push(e instanceof Error ? e.message : String(e));
      }
    }
  }
  return { attachments, fetchErrors };
};

/**
 * 派发一个**已合并**的 burst 到 Hermes:配额 → 容器(重取,防窗口期变化) → 写库 → loop → dispatch。
 * 经聚合层 onFlush(图已上传完)或 `/new args` 调用。返回 loopId(占车道)/ null(立即释放车道)。
 */
const dispatchMerged = async (
  binding: { id: string; user_id: string },
  replyTarget: { client: WechatClient; msg: ParsedMsg },
  threadId: string,
  burst: AggregatedBurst,
): Promise<string | null> => {
  const { client, msg } = replyTarget;

  // 配额已在派发前由 onMessage / handleWechatNew 闸过(避免给超额用户白下图), 此处不再查。
  // 容器 ready 重取(窗口期可能缩零/状态变)
  const mapping = dao.cache.get(binding.user_id);
  if (!mapping || mapping.status !== 'ready' || !mapping.container_url) {
    await safeSendText(client, msg, CONTAINER_NOT_READY_TEXT);
    return null;
  }
  const containerUrl = mapping.container_url;

  const joinedText = burst.texts.join('\n');
  const { attachments, fetchErrors } = burst;

  // 无文字且无成功附件 → 不入库不 dispatch。但若附件全失败（含 wake 失败），给用户反馈。
  if (!joinedText && attachments.length === 0) {
    if (fetchErrors.length > 0) {
      await safeSendText(client, msg, '附件处理失败了，请稍后重发试试~');
    }
    return null;
  }

  const promptText = attachments.length > 0 || fetchErrors.length > 0
    ? buildInboxPrompt(joinedText, attachments, fetchErrors)
    : joinedText;

  // 插入 user 消息 + 创建 agent loop。content 与 dispatch 同存 promptText(含图片本地路径标注; 纯图也带前缀), 与 feishu 一致。
  const userMsgId = genId.message;
  const loopId = genId.agentLoop;
  try {
    await dao.messages.insert({
      id: userMsgId,
      thread_id: threadId,
      role: 'user',
      content_type: 'text',
      content: promptText,
      source: 'wechat',
    });
    await dao.agentLoops.create({ id: loopId, thread_id: threadId, message_id: userMsgId });
  } catch (e) {
    console.error('[handleInbound] DB insert failed:', e);
    await safeSendText(client, msg, FALLBACK_TEXT);
    return null;
  }

  // 保存微信回复上下文(用最新一条的 context_token)
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
    containerUrl,
    userId: binding.user_id,
    threadId,
    source: 'wechat',
    sessionId,
    message: promptText,
    loopId,
  });

  if (!dispatch.ok) {
    wechatReplyContexts.delete(loopId);
    await dao.agentLoops.complete(loopId, 'fail');
    emitLoopEvent(loopId, { type: 'fail', error: dispatch.error ?? `dispatch failed (${dispatch.status})` });
    await safeSendText(client, msg, FALLBACK_TEXT);
    return null;
  }

  return loopId;
};

/**
 * 微信侧 `/new` 真正的"开新会话"语义:
 *   1. 创建全新 thread + bindThread 让 binding 指向它
 *   2. 后续这条 binding 收到的消息默认进入这个新 thread
 *   3. 若用户发的是 `/new`(无文案)→ 回 "✓ 已开启新会话"
 *      若是 `/new 顺便问一下...` → 把后续文案作为新会话第一条消息派发给 Hermes
 *
 * 跟 web 端 `/new` 走 reject 文案的语义不同 —— 微信端用户没有"会话列表"UI
 * 来手动新建,只能靠 slash。这是 wechat 渠道特有的能力。
 */
const handleWechatNew = async (
  binding: { id: string; user_id: string; thread_id: string | null },
  client: WechatClient,
  msg: ParsedMsg,
  args: string,
  dropOld = false,
): Promise<void> => {
  // /drop: 先把当前 thread 静默删掉 (DB + ACA session, fire-and-forget, 不等待不管成败)
  const oldThreadId = binding.thread_id;
  if (dropOld && oldThreadId) {
    const m = dao.cache.get(binding.user_id);
    const containerUrl = m?.status === 'ready' && m.container_url ? m.container_url : null;
    dropThreadSilently({ userId: binding.user_id, threadId: oldThreadId, source: 'wechat', containerUrl });
  }
  const newThreadId = genId.thread;
  try {
    await dao.threads.create({ id: newThreadId, user_id: binding.user_id, source: 'wechat', title: '微信' });
    await dao.wechatBindings.bindThread(binding.id, newThreadId);
  } catch (e) {
    console.error('[handleInbound] /new create thread failed:', e);
    await safeSendText(client, msg, FALLBACK_TEXT);
    return;
  }
  // in-memory 同步,后续轮次直接复用,不必再 select binding
  binding.thread_id = newThreadId;
  log.info({ event: 'wechat.slash.new', user_id: binding.user_id, new_thread_id: newThreadId, has_args: args.length > 0 });
  const opened = dropOld ? '已删除当前会话并开启新会话' : '已开启新会话';

  if (!args) {
    await safeSendText(client, msg, `✓ ${opened},你可以开始新的对话了。`);
    return;
  }
  // 带 args: 配额闸 → 先确认新会话已开 → 派发首条消息(避免用户等 LLM 才看到反馈)
  if (await isQuotaExhausted(binding.user_id)) {
    await safeSendText(client, msg, QUOTA_EXHAUSTED_TEXT);
    return;
  }
  await safeSendText(client, msg, `✓ ${opened},正在处理你的消息…`);
  // /new 单条无图: 直接进车道, 无需聚合
  enqueueThreadTask(newThreadId, () =>
    dispatchMerged(binding, { client, msg }, newThreadId, { texts: [args], attachments: [], fetchErrors: [] }),
  );
};

type WechatClient = Parameters<typeof safeSendText>[0];
type ParsedMsg = NonNullable<ReturnType<typeof parseInbound>>;

async function onWechatInbound(
  binding: WechatBinding,
  client: IlinkClient,
  raw: unknown,
) {
  const msg = parseInbound(raw);
  if (!msg) return;

  // parts → text（串联）+ 附件列表；slash 只看 text。
  const text = msg.parts
    .filter((p): p is Extract<InboundPart, { kind: 'text' }> => p.kind === 'text')
    .map((p) => p.text)
    .join('');
  const attachmentParts = msg.parts.filter((p): p is AttachmentPart => p.kind !== 'text');

  // 入站到达埋点：量图文/文件消息被 iLink 拆条后的实际到达间隔。
  log.info({
    event: 'wechat.inbound.arrived',
    thread_id: binding.thread_id ?? null,
    from_user_id: msg.from_user_id,
    message_id: msg.message_id,
    has_attachment: attachmentParts.length > 0,
    attachment_count: attachmentParts.length,
    text_len: text.length,
  });

  // Hermes slash 拦截 (详见 lib/slash-filter.ts) — 微信渠道有两点特殊:
  //   1. /new 真生效 (网关创建新 thread + bindThread) —— 因为微信用户没有
  //      web UI 的"新对话"按钮可用,只能靠这个指令开新会话。
  //   2. 其他 intercept 走通用 render 文案,跟 web 端一致地引导用户。
  const slash = classifyMessage(text);
  if (slash.kind === 'intercept') {
    // slash 抢占: 先结算该 thread 待聚合窗口, 保序(避免 slash 插到未派发 burst 前面)
    if (binding.thread_id) await flush(binding.thread_id);
    if (slash.cmd === 'new') {
      return await handleWechatNew(binding, client, msg, slash.args);
    }
    if (slash.cmd === 'drop') {
      return await handleWechatNew(binding, client, msg, slash.args, true);
    }
    const reply = await runIntercept(slash, {
      userId: binding.user_id,
      threadId: binding.thread_id ?? '',
    });
    log.info({ event: 'wechat.slash.intercepted', user_id: binding.user_id, cmd: slash.cmd, log_tag: slash.logTag });
    await safeSendText(client, msg, reply);
    return;
  }

  let threadId: string;
  try {
    threadId = await resolveThread(binding);
  } catch (e) {
    console.error('[handleInbound] resolveThread failed:', e);
    await safeSendText(client, msg, FALLBACK_TEXT);
    return;
  }

  // 容器 ready 闸(同步, 不 ready → 提示并丢弃, 不进聚合 —— 后面 upload 也要容器活着)
  const mapping = dao.cache.get(binding.user_id);
  if (!mapping || mapping.status !== 'ready' || !mapping.container_url) {
    await safeSendText(client, msg, CONTAINER_NOT_READY_TEXT);
    return;
  }
  const containerUrl = mapping.container_url;

  // unsupported 类型（voice/video）即时提示一次，不阻塞 text/attachment。
  if (msg.unsupported_hints.length > 0) {
    await safeSendText(client, msg, msg.unsupported_hints.join('\n'));
  }

  const hasAttachment = attachmentParts.length > 0;
  // 纯 unsupported / 空消息：提示已发，无内容可派发，不进聚合。
  if (!text && !hasAttachment) return;

  // 软配额闸(派发前, eager 下载图之前): 超额则提示并止, 不白下图。
  if (await isQuotaExhausted(binding.user_id)) {
    await safeSendText(client, msg, QUOTA_EXHAUSTED_TEXT);
    return;
  }

  // 进聚合窗口：附件 eager-fetch 串进 uploadChain；窗口静默到期 flush → 合并 burst 进车道。
  aggregateInbound(threadId, {
    text,
    hasImage: hasAttachment,
    upload: hasAttachment ? buildUploadThunk(binding, client, msg, attachmentParts, containerUrl) : undefined,
    onFlush: (burst) => {
      const accepted = enqueueThreadTask(threadId, () =>
        dispatchMerged(binding, { client, msg }, threadId, burst),
      );
      if (!accepted) void safeSendText(client, msg, BUSY_QUEUE_TEXT);
    },
  });
}

export const makeHandleInbound = (): OnMessageFactory => {
  return (binding, client) => (raw: unknown) => {
    return runWithTrace(
      { trace_id: genId.trace },
      () => onWechatInbound(binding, client, raw)
    );
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
