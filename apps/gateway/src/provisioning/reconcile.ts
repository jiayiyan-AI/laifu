/**
 * 声明式 reconcile (dynamic-update-aca.md §八/§九)。
 *
 * gateway 作为 controller, 把"用户 ACA 的实际状态"驱向"代码声明的期望 spec"。
 * 判断是否需要更新 = 内存里 policyHashFor(userId) 与 row.policy_hash 的纯字符串比较 (per-user, memo 后 ~纳秒)。
 * 不一致则 fire-and-forget 后台 reconcile, 绝不阻塞当前数据面请求 (当前请求继续按老 revision 服务)。
 */
import { config } from '../config.js';
import { dao } from '../db/index.js';
import { policyHashFor, reconcileContainerAppAzure } from './azure.js';
import { log } from '../lib/logger.js';

/** 进程内 per-user 去重: 同一用户同一时刻只跑一个 reconcile, 挡住单实例并发踩踏。 */
const inflight = new Map<string, Promise<void>>();

/** 真正干活: 提交最新 spec, 成功后写回 DB + 刷新内存缓存。失败不写回 → 缓存仍是旧值 → 下次自动重试。 */
const reconcileUser = async (userId: string): Promise<void> => {
  await reconcileContainerAppAzure(userId);
  await dao.containerMapping.setPolicyHash(userId, policyHashFor(userId));
  const fresh = await dao.containerMapping.getByUserId(userId);
  if (fresh) dao.cache.set(fresh);
};

/** 去重启动一次后台 reconcile, 返回 (复用的) inflight promise。错误吞掉, 不抛。 */
const startReconcile = (userId: string): Promise<void> => {
  const existing = inflight.get(userId);
  if (existing) return existing;
  const p = reconcileUser(userId)
    .catch((err) => log.warn({ event: 'aca.reconcile.failed', user_id: userId, err: String(err) }))
    .finally(() => inflight.delete(userId));
  inflight.set(userId, p);
  return p;
};

/**
 * 热路径调用 (chat / wechat inbound 等 ACA 入口前): 纯内存比较, 不一致则后台 reconcile, 绝不阻塞。
 * 99.99% 的请求命中 (policy_hash === policyHashFor(userId)), 直接返回。
 */
export const checkAndReconcileACA = (userId: string): void => {
  if (config.provisioner !== 'azure') return;                  // 本地 mock 无 ACA
  const cached = dao.cache.get(userId);
  if (!cached || cached.status !== 'ready') return;            // 还没建好, 交给创建流程
  if (cached.policy_hash === policyHashFor(userId)) return;    // 命中, 直接返回
  void startReconcile(userId);                                 // 不 await
};

const SWEEP_CONCURRENCY = 8;                                   // 控制 ARM 写并发, 远低于限流 (~1200/h)

/** 有界并发池: 逐个跑 worker, 单个失败不影响其余 (startReconcile 自身不抛)。 */
const runPool = async (
  ids: string[],
  concurrency: number,
  worker: (userId: string) => Promise<void>,
): Promise<void> => {
  let i = 0;
  const length = Math.min(concurrency, ids.length);
  const runners = Array.from({ length }, async () => {
    while (i < ids.length) await worker(ids[i++]!).catch(console.error);
  });
  await Promise.all(runners);
};

/**
 * 启动全量 sweep (§九): 部署改了策略代码的 gateway 后, 主动把所有存量 stale 用户拉齐, 不等自然访问。
 * 后台跑, 有界并发。稳态 (全员命中) 零 ARM 调用。sweep 与 lazy 路径共用 inflight 去重。
 */
export const sweepReconcileAll = async (): Promise<void> => {
  if (config.provisioner !== 'azure') return;
  const stale = dao.cache.entries()
    .filter((m) => m.status === 'ready' && m.policy_hash !== policyHashFor(m.user_id))
    .map((m) => m.user_id);
  if (stale.length === 0) return;                              // 稳态: 零 ARM 调用
  log.info({ event: 'aca.reconcile.sweep.start', count: stale.length });
  await runPool(stale, SWEEP_CONCURRENCY, startReconcile);
  log.info({ event: 'aca.reconcile.sweep.done', count: stale.length });
};
