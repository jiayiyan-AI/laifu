/**
 * Per-thread 入站聚合层 —— 把「一个念头被 iLink 拆成多条」(图文拆分 / ~2048 字长文切分 /
 * 秒级连打)在派发**之前**合并成一次,使一个 burst 只起一轮 agent loop、只回一条。
 *
 * 背景(源码坐实,hermes:v18 镜像 gateway/platforms/weixin.py):
 *  - iLink **不带任何关联字段**(无 seq/group/total)。图文混排被拆成两条独立 message,
 *    顺序随图大小变;长文在 ~2048 字处机械切分。唯一可行的合并手段是**时间窗 debounce**。
 *  - hermes weixin 适配器同样靠时间窗(`_text_batch_delay_seconds=3s`)+ 长度启发式
 *    (`_SPLIT_THRESHOLD=1800 # iLink chunks at ~2048 chars`)。本模块照搬其思路,并**超越**
 *    hermes 的一个缺陷:hermes 的 image 绕过 text-batch(图先到仍漏),我们对 text+image
 *    **统一缓冲**,无论谁先到都并进同一窗口。
 *
 * 与 thread-serializer(串行车道)正交、叠加:
 *  - 本层做「近邻消息合并」→ 产出**一个**待派发 burst;
 *  - 车道做「一轮一个 in-flight」→ burst 经 onFlush 进车道排队。
 *  - 我们**不**学 hermes 的「整个 busy 期单槽合并」:busy 期相隔数十秒的 follow-up 多是独立
 *    问题,合进一轮会答串。短时间窗只并「一个念头」,独立 follow-up 仍各自成轮各自回复。
 *
 * 关键正确性:窗口按**消息到达**节流,图片上传(数秒)串进 slot.uploadChain 且**不在
 * aggregateInbound 里 await**(否则阻塞 poll loop);flush 时**先 await uploadChain 再 onFlush**,
 * 故绝不会在图还没传完就派发。slot 读写都在 onMessage(poll loop `for...of await`,per-binding
 * 严格串行)→ 无数据竞争。进程内状态,重启即丢。
 */
import type { InboxAttachmentRef } from '@lingxi/shared';
import { log } from '../lib/logger.js';
import { genId } from '@lingxi/db';
import { runWithTrace, getTraceId } from '../lib/trace-context.js';

// ─── 窗口取值(env 可覆盖;偏向「修复拆分」而非「最低延迟」)───
// 窗口 = 收到**最后一条**消息后再静默等这么久才派发。值越大越能兜住「iLink 把图文拆成多条、
// 且图那条 push 比文本晚到 gateway」的情形,但每条纯文本回复也相应变慢(延迟加在每条上)。
// ⚠ 根本局限:iLink 投递延迟**无界**(大图/弱网下图 push 可能晚到几十秒),没有任何固定窗口
//   能兜住——这几个值只覆盖**常见的近邻拆分**。真机用 `wechat.inbound.arrived` 日志量出图文
//   实际到达间隔后再调这些值。所有值可经环境变量覆盖,**免改码重部署**即可按真机数据调参。
const envInt = (name: string, def: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : def;
};

/** 文字消息(可能尾随一张图)→ 收到后再等这么久兜尾随图。调小降延迟、但漏掉到得晚的图。 */
export const TEXT_GRACE_MS = envInt('WECHAT_AGG_TEXT_GRACE_MS', 5000);
/** 纯图无文字 → 大概率文字在路上,多等。 */
export const IMAGE_WAIT_MS = envInt('WECHAT_AGG_IMAGE_WAIT_MS', 5000);
/** 文字长度近 iLink ~2048 切分阈值 → 必有后续分片,等更久。 */
export const SPLIT_WAIT_MS = envInt('WECHAT_AGG_SPLIT_WAIT_MS', 4000);
/** 首条算起的硬上限,防连打无限推迟。应 ≥ 上面各窗口。 */
export const HARD_CAP_MS = envInt('WECHAT_AGG_HARD_CAP_MS', 8000);
/** 近此长度判定「可能被 iLink 切分」(对齐 hermes `_SPLIT_THRESHOLD`)。 */
export const SPLIT_THRESHOLD = envInt('WECHAT_AGG_SPLIT_THRESHOLD', 1800);

/** flush 时交给 onFlush 的合并结果。 */
export interface AggregatedBurst {
  /** 各条文字片段(原文,未拼 prompt)。 */
  texts: string[];
  /** 已上传到容器的图片附件(cache_path 稳定,无 TTL 风险)。 */
  attachments: InboxAttachmentRef[];
  /** 图片下载/上传失败原因(供 prompt 标注)。 */
  fetchErrors: string[];
}

export interface AggregateOpts {
  /** 本条文字(纯图为 '')。 */
  text: string;
  /** 本条是否带图(决定窗口时长)。 */
  hasImage: boolean;
  /**
   * 本条图片的上传任务:串进 slot.uploadChain,flush 时 await。无图则省略。
   * 约定**自行吞错**(失败写进返回的 fetchErrors),不要 throw。
   */
  upload?: () => Promise<{ attachments: InboxAttachmentRef[]; fetchErrors: string[] }>;
  /**
   * 窗口到期、上传落地后调用,用**最新一条**的上下文派发合并 burst。每次 aggregate 覆盖,
   * flush 用最新(故回复发给最近一条消息的 context_token)。
   */
  onFlush: (burst: AggregatedBurst) => void;
}

interface Slot {
  texts: string[];
  attachments: InboxAttachmentRef[];
  fetchErrors: string[];
  uploadChain: Promise<void>;
  onFlush: (burst: AggregatedBurst) => void;
  firstTs: number;
  /** burst 的关联 trace_id: slot 创建时捕获 ambient(无则现签), uploadChain + onFlush 都在它里面跑,
   *  让聚合后**异步触发**的派发(定时器 / slash 抢占 / 直接 flush)始终归到同一 trace, 不依赖上下文自动传播。 */
  trace: string;
  timer: ReturnType<typeof setTimeout>;
}

const slots = new Map<string, Slot>();

const computeWaitMs = (text: string, hasImage: boolean): number => {
  if (text.length >= SPLIT_THRESHOLD) return SPLIT_WAIT_MS;
  if (hasImage && text.length === 0) return IMAGE_WAIT_MS;
  return TEXT_GRACE_MS;
};

/**
 * 把一条入站消息并入 threadId 的聚合窗口。同步返回(不 await 上传)。
 * 每来一条 cancel 重排定时器(经典 debounce),窗口静默到期触发 flush。
 */
export const aggregateInbound = (threadId: string, opts: AggregateOpts): void => {
  const now = Date.now();
  let slot = slots.get(threadId);
  if (!slot) {
    slot = {
      texts: [],
      attachments: [],
      fetchErrors: [],
      uploadChain: Promise.resolve(),
      onFlush: opts.onFlush,
      firstTs: now,
      trace: getTraceId() ?? genId.trace,
      timer: setTimeout(() => {}, 0),
    };
    clearTimeout(slot.timer);
    slots.set(threadId, slot);
  }

  if (opts.text) slot.texts.push(opts.text);
  slot.onFlush = opts.onFlush;

  if (opts.upload) {
    const upload = opts.upload;
    const cur = slot;
    slot.uploadChain = slot.uploadChain.then(() =>
      runWithTrace({ trace_id: cur.trace }, async () => {
        try {
          const { attachments, fetchErrors } = await upload();
          cur.attachments.push(...attachments);
          cur.fetchErrors.push(...fetchErrors);
        } catch (e) {
          // upload 约定吞错; 这里是兜底,防一条抛错带垮整条 uploadChain。
          cur.fetchErrors.push(e instanceof Error ? e.message : String(e));
          log.warn({ event: 'thread.agg.upload.error', thread_id: threadId, err: String(e) });
        }
      }),
    );
  }

  clearTimeout(slot.timer);
  const want = computeWaitMs(opts.text, opts.hasImage);
  const capped = Math.max(0, Math.min(want, HARD_CAP_MS - (now - slot.firstTs)));
  slot.timer = setTimeout(() => flush(threadId), capped);
};

/**
 * 立即结算 threadId 的窗口(若有)。窗口到期定时器、或 slash 抢占前保序都会调。
 * **先 await uploadChain 再 onFlush** —— 保证图已落地。onFlush 自身 fire-and-forget(进车道)。
 */
export const flush = async (threadId: string): Promise<void> => {
  const slot = slots.get(threadId);
  if (!slot) return;
  slots.delete(threadId);
  clearTimeout(slot.timer);
  await slot.uploadChain;
  // onFlush(→ 派发)在 burst 自己的 trace 里跑, 与触发路径(定时器/抢占/直接 flush)无关。
  runWithTrace({ trace_id: slot.trace }, () => {
    slot.onFlush({ texts: slot.texts, attachments: slot.attachments, fetchErrors: slot.fetchErrors });
  });
};

/** 当前是否有待结算窗口(introspection / 测试)。 */
export const hasPendingAggregation = (threadId: string): boolean => slots.has(threadId);

// ─── 测试工具(生产代码勿用)───

/** 等当前所有窗口结算完(flush + onFlush)。测试断言派发副作用前调用。 */
export const __whenAggregatedForTests = async (): Promise<void> => {
  await Promise.all([...slots.keys()].map((k) => flush(k)));
};

/** 清空所有窗口(放弃未结算 burst)。afterEach 用。 */
export const __resetThreadAggregatorForTests = (): void => {
  for (const slot of slots.values()) clearTimeout(slot.timer);
  slots.clear();
};
