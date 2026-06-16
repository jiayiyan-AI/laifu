import { useEffect, useRef, useState, useCallback } from 'react';
import { Composer } from './Composer.js';
import * as api from '../../lib/api.js';
import { IconSpark } from '../../lib/icons.js';
import { usageAtom } from '../../states/usage.atom.js';
import type { MessageRow } from '@lingxi/shared';

export interface Message {
  who: 'user' | 'assistant';
  text: string;
  pending?: boolean;
}

interface Props {
  threadId: string;
}

const THINKING_TEXTS = [
  '灵犀正在思考…',
  '让我想想…',
  '正在整理思路…',
  '马上就好…',
  '还在思考中…',
];

const rowToMsg = (r: MessageRow): Message => ({
  who: r.role,
  text: typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? ''),
});

export const Conversation = ({ threadId }: Props) => {
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [quotaError, setQuotaError] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const refreshUsage = usageAtom.useChange().refresh;

  const thinkingIdx = useRef(0);
  const loopCleanup = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 消息变化(切换会话载入历史 / 新消息 / 流式更新)后滚到底, 始终看到最新一条。
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  // 连接 loop SSE 并处理事件
  const connectLoop = useCallback((loopId: string) => {
    thinkingIdx.current = 0;
    const cleanup = api.connectLoopStream(loopId, {
      onHeartbeat: () => {
        thinkingIdx.current = (thinkingIdx.current + 1) % THINKING_TEXTS.length;
        const text = THINKING_TEXTS[thinkingIdx.current]!;
        setMsgs((m) => m.map((x, i) =>
          i === m.length - 1 && x.pending ? { ...x, text } : x,
        ));
      },
      onDone: (reply) => {
        setMsgs((m) => m.map((x, i) =>
          i === m.length - 1 && x.pending ? { who: 'assistant', text: reply } : x,
        ));
        setBusy(false);
        refreshUsage();
        loopCleanup.current = null;
      },
      onFail: (error) => {
        // 移除 pending 气泡，以横幅方式提示
        setMsgs((m) => m.filter((x) => !x.pending));
        setErrorBanner(error);
        setBusy(false);
        loopCleanup.current = null;
      },
    });
    loopCleanup.current = cleanup;
    return cleanup;
  }, [refreshUsage]);

  // 组件卸载时清理 loop SSE
  useEffect(() => {
    return () => { loopCleanup.current?.(); };
  }, []);

  // 挂载时从 Postgres 拉历史
  useEffect(() => {
    let cancelled = false;
    setLoadingHistory(true);
    api.fetchHistory(threadId)
      .then((rows) => {
        if (cancelled) return;
        setMsgs(rows.map(rowToMsg));
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('fetchHistory failed', err);
        setMsgs([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });
    // 恢复状态：页面刷新时若有活跃 loop，重新连接 SSE
    api.fetchActiveLoop(threadId).then((loop) => {
      if (cancelled) return;
      if (loop) {
        setBusy(true);
        setMsgs((m) => [...m, { who: 'assistant', text: THINKING_TEXTS[0]!, pending: true }]);
        connectLoop(loop.id);
      }
    }).catch(() => { /* ignore */ });
    return () => {
      cancelled = true;
      loopCleanup.current?.();
      loopCleanup.current = null;
    };
  }, [threadId, connectLoop]);

  const onSend = async (text: string) => {
    setErrorBanner(null);
    setMsgs((m) => [...m, { who: 'user', text }, { who: 'assistant', text: THINKING_TEXTS[0]!, pending: true }]);
    setBusy(true);

    try {
      const resp = await api.sendChat({ thread_id: threadId, message: text });
      if (resp.kind === 'inline') {
        // 网关就地处理 (slash 拦截类): 替换 pending 气泡, 不订阅 SSE
        // user 消息也是本地临时显示 — 不入库, 刷新页面即消失
        setMsgs((m) => m.map((x, i) =>
          i === m.length - 1 && x.pending ? { who: 'assistant', text: resp.reply } : x,
        ));
        setBusy(false);
      } else {
        connectLoop(resp.loop_id);
      }
    } catch (err) {
      if (err instanceof api.QuotaError) {
        setQuotaError(true);
        setMsgs((m) => m.slice(0, -2));
        refreshUsage();
      } else {
        const errMsg = err instanceof Error ? err.message : '请求失败';
        setMsgs((m) => m.filter((x) => !x.pending));
        setErrorBanner(errMsg);
      }
      setBusy(false);
    }
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {loadingHistory && msgs.length === 0 && <div className="dim" style={{ fontSize: 13, textAlign: 'center', marginTop: 60 }}>载入历史…</div>}
        {!loadingHistory && msgs.length === 0 && <div className="dim" style={{ fontSize: 13, textAlign: 'center', marginTop: 60 }}>说说看，我能帮你做什么。</div>}
        {msgs.map((m, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, maxWidth: '76%', alignSelf: m.who === 'user' ? 'flex-end' : 'flex-start', flexDirection: m.who === 'user' ? 'row-reverse' : 'row' }}>
            {m.who === 'assistant' && (
              <span style={{ display: 'inline-flex', width: 30, height: 30, borderRadius: 8, background: '#7c3aed1f', color: '#7c3aed', alignItems: 'center', justifyContent: 'center', marginTop: 6, flexShrink: 0 }}>
                <IconSpark size={15} />
              </span>
            )}
            <div style={{
              padding: '10px 14px', borderRadius: 14, boxShadow: 'var(--shadow)',
              background: m.who === 'user' ? 'var(--accent)' : 'var(--panel)',
              color: m.who === 'user' ? '#fff' : 'inherit',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              borderTopLeftRadius: m.who === 'user' ? 14 : 4,
              borderTopRightRadius: m.who === 'user' ? 4 : 14,
            }}>
              {m.text || (m.pending ? <span className="pulse">{THINKING_TEXTS[0]}</span> : '')}
              {m.pending && m.text && <span className="pulse"> </span>}
            </div>
          </div>
        ))}
      </div>
      {errorBanner && (
        <div style={{
          padding: '12px 18px', background: 'var(--bad-w)', borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 10, fontSize: 13,
        }}>
          <span style={{ color: 'var(--bad)', fontWeight: 600 }}>出错了</span>
          <span style={{ color: 'var(--text2)' }}>{errorBanner}</span>
          <button
            onClick={() => setErrorBanner(null)}
            style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text3)', textDecoration: 'underline' }}
          >关闭</button>
        </div>
      )}
      {quotaError && (
        <div style={{
          padding: '12px 18px', background: 'var(--bad-w)', borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 10, fontSize: 13,
        }}>
          <span style={{ color: 'var(--bad)', fontWeight: 600 }}>额度已用完</span>
          <span style={{ color: 'var(--text2)' }}>本月免费额度已耗尽且余额为零，请联系管理员充值后继续使用。</span>
          <button
            onClick={() => setQuotaError(false)}
            style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text3)', textDecoration: 'underline' }}
          >关闭</button>
        </div>
      )}
      <Composer disabled={busy || quotaError} onSend={onSend} />
    </div>
  );
};
