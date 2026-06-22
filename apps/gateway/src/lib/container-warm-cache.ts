/**
 * 进程内 per-user "容器已唤醒" 缓存 + wake-then-stream 主入口。
 *
 * 背景 (见 weichat-file-impl.md §3.7): files 链路 CDN streaming pipeline 跟容器
 * `/inbox/image` POST 耦合 —— POST 在 ACA 冷启动期间被挂住时, gateway 端拉不动 CDN
 * body, 微信 CDN 的 ~30-60s idle timeout 一到必 RST, 整张图作废。所以**先唤醒、再开
 * pipeline**: 先 GET /health 把 replica 唤醒, 再开 streaming。
 *
 * text 路径不引入 wake: 小 JSON body 没有被挂死的上游连接, 沿用今天"原地等"的语义
 * (docs/known-issues.md:61 已否决过给 /chat 加 probe)。但 text 调用成功后会 noteContainerActivity
 * 续 cache, 让 files 几乎全部命中 (稳态 99%)。
 */
import { log } from './logger.js';
import { checkAndReconcileACA } from '../provisioning/reconcile.js';

// ACA scale-to-zero cooldown 默认 5 min, 实测 8-10 min; 60s TTL 给 10x 安全余量,
// 真冷启动只多 1 个 health 往返。
const WARM_TTL_MS = 60_000;
// ACA cold start P99 < 30s, 60s 留余量。
const WAKE_TIMEOUT_MS = 60_000;
// wake_ms 超此阈值判定为真冷启动 (埋点 cold=true)。
const COLD_THRESHOLD_MS = 1_500;

export class ContainerWakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContainerWakeError';
  }
}

const warmAt = new Map<string /* userId */, number>();
const inFlight = new Map<string, Promise<void>>();

/** text/chat/upload 任何一次成功 2xx 后调一次, 把 cache 续上。 */
export const noteContainerActivity = (userId: string): void => {
  warmAt.set(userId, Date.now());
};

/**
 * 心跳驱动的保活 (gateway-only, 容器零改动)。
 *
 * 问题: `/chat` 是异步 fire-and-forget (202 即返回, agent 后台跑), 后台工作不产生**入站**
 * HTTP; 容器心跳是**出站**的 (POST /internal/hermes-callback)。ACA KEDA HTTP scaler 只看
 * 入站流量, cooldown 300s 内无入站 → SIGTERM 把正在跑的 agent 杀掉 (长任务如 vision 必踩,
 * text 35s 完成则躲过)。
 *
 * 修法: gateway 每收到一次容器心跳 (每 120s, 见 hermes server HEARTBEAT_INTERVAL_MS) 就回敲
 * 一次 `/health` —— 走 envoy 入口 = 一次入站请求, 重置 KEDA 冷却计时。120s < 300s 有 2.5x
 * 余量。agent 跑完心跳停 → 不再回敲 → 300s 后正常 scale-to-zero, 省电逻辑不变。
 *
 * 与 ensureContainerWarm 的区别: **无条件 ping** (不走 60s warm-cache TTL, 否则会被跳过),
 * **fire-and-forget** (不 await、不阻塞心跳 ack、不抛错)。成功也顺带续 warm-cache。
 */
export const keepContainerWarm = (userId: string, containerUrl: string): void => {
  void fetch(`${containerUrl}/health`, { signal: AbortSignal.timeout(WAKE_TIMEOUT_MS) })
    .then((resp) => {
      if (resp.ok) {
        warmAt.set(userId, Date.now());
        log.info({ event: 'aca.keepwarm', user_id: userId, status: resp.status });
      } else {
        log.warn({ event: 'aca.keepwarm', user_id: userId, status: resp.status });
      }
    })
    .catch((e) => {
      log.warn({ event: 'aca.keepwarm', user_id: userId, err: e instanceof Error ? e.message : String(e) });
    });
};

/**
 * 确保容器已唤醒。命中 60s warm-cache → 0 RTT 直接返回; 否则串行 GET /health,
 * 成功续 cache, 失败抛 ContainerWakeError (60s 还没起来的容器是真挂, 不再硬等)。
 * 同 user 并发只折成一次 /health。
 */
export const ensureContainerWarm = async (
  userId: string,
  containerUrl: string,
): Promise<void> => {
  // 图片链路的第一个 ACA 触点: 跟 aca-call.ts 出站 wrapper 对称, 在 warm-cache 命中
  // 检查之前统一触发一次 reconcile (内存 hash 比对, 漂移则后台拉齐 spec; 幂等非阻塞)。
  // 放在 wake 之前是因为 wake 失败会直接 return, 否则这条消息永远不会 reconcile。
  checkAndReconcileACA(userId);

  const last = warmAt.get(userId);
  if (last !== undefined && Date.now() - last < WARM_TTL_MS) return; // 99% 走这条

  const existing = inFlight.get(userId);
  if (existing) return existing; // 同 user 并发 dedupe

  const p = doWake(userId, containerUrl)
    .finally(() => inFlight.delete(userId));
  inFlight.set(userId, p);
  return p;
};

const doWake = async (
  userId: string,
  containerUrl: string,
): Promise<void> => {
  const t0 = performance.now();
  let resp: Response;
  try {
    resp = await fetch(`${containerUrl}/health`, {
      signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
    });
  } catch (e) {
    throw new ContainerWakeError(`wake fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const ms = Math.round(performance.now() - t0);
  if (!resp.ok) throw new ContainerWakeError(`wake non-2xx: ${resp.status}`);
  warmAt.set(userId, Date.now());
  log.info({ event: 'aca.wake', user_id: userId, wake_ms: ms, cold: ms > COLD_THRESHOLD_MS });
};

/** 测试用: 清空进程内缓存 + in-flight, 让每个 case 从干净状态起。 */
export const __resetContainerWarmCache = (): void => {
  warmAt.clear();
  inFlight.clear();
};
