/**
 * Thread SSE 通知 hub (进程内单例)。
 *
 * 用法:
 *   - 前端在 Conversation mount 时 EventSource `/api/threads/:id/stream`
 *     → hub.subscribe 把 res 加进该 thread 的订阅集合
 *   - 后端事件源头 (handleInbound 收完微信消息+hermes 回复完) 调
 *     hub.emit(threadId, 'thread-updated', payload)
 *   - 前端收到 SSE 事件后调一次 /api/threads/:id/messages 拉最新历史
 *
 * 为什么不直接 push 新消息正文,而是 push 'updated' 通知?
 *   - hermes SQLite 仍是单一真相源,前端拉一遍即可
 *   - hub 不用关心消息正文/format,只做通知信道
 *   - 历史端点已经做完权限校验和拼装,免重复
 *
 * 连接生命周期由调用方 (路由) 用 req.on('close') 触发 unsubscribe。
 */
import type { Response } from 'express';

export class ThreadStreamHub {
  private subs = new Map<string, Set<Response>>();

  subscribe(threadId: string, res: Response): () => void {
    let set = this.subs.get(threadId);
    if (!set) {
      set = new Set();
      this.subs.set(threadId, set);
    }
    set.add(res);
    return () => {
      const s = this.subs.get(threadId);
      if (!s) return;
      s.delete(res);
      if (s.size === 0) this.subs.delete(threadId);
    };
  }

  emit(threadId: string, eventName: string, payload: unknown): void {
    const set = this.subs.get(threadId);
    if (!set) return;
    // SSE 格式: event: <name>\ndata: <json>\n\n
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of set) {
      try {
        res.write(frame);
      } catch {
        // 连接已关 — 让 req.on('close') 兜底清理,这里不删
      }
    }
  }

  size(threadId: string): number {
    return this.subs.get(threadId)?.size ?? 0;
  }

  /** 测试用 — 拿 all sub 集 */
  _threadIds(): string[] {
    return [...this.subs.keys()];
  }
}
