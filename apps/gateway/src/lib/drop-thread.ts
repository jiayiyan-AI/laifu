/**
 * drop-thread.ts — 静默删除一个 thread (DB + ACA hermes session)。
 *
 * 供渠道 `/drop` 指令用: `/drop` = `/new` + 删旧 thread。新会话已即时开好并回执用户,
 * 旧会话的清理在**后台 fire-and-forget** 进行 —— 不 await、不阻塞、不管成败 (各自 catch 只 log)。
 *
 * 两件事并行:
 *   1. DB 删 (dao.threads.deleteById, FK CASCADE 带走 messages / agent_loops / tool_calls)
 *   2. ACA 容器侧 hermes session 删 (deleteHermesSession, sessionId = `${source}:${threadId}`)
 *
 * deleteHermesSession 自身不 throw (失败返回 ok:false 并已 log); 这里仍兜一层 catch 防御。
 */
import { dao } from '../db/index.js';
import { deleteHermesSession } from './aca-call.js';
import { log } from './logger.js';

export interface DropThreadInput {
  userId: string;
  threadId: string;
  source: 'wechat' | 'feishu';
  /** 容器基址; null/未 ready 则只删 DB, 跳过容器侧 (没 mapping 就没 hermes session)。 */
  containerUrl: string | null;
}

/** fire-and-forget: 立即返回, 删除在后台进行。 */
export const dropThreadSilently = (input: DropThreadInput): void => {
  const { userId, threadId, source, containerUrl } = input;

  void dao.threads.deleteById(threadId, userId)
    .then((removed) => log.info({ event: 'thread.drop.db', user_id: userId, thread_id: threadId, source, removed }))
    .catch((e) => log.warn({ event: 'thread.drop.db.failed', user_id: userId, thread_id: threadId, source, err: String(e) }));

  if (containerUrl) {
    void deleteHermesSession({ containerUrl, userId, threadId, source, sessionId: `${source}:${threadId}` })
      .catch((e) => log.warn({ event: 'thread.drop.session.failed', user_id: userId, thread_id: threadId, source, err: String(e) }));
  }
};
