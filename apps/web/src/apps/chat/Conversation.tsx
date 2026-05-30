import { useEffect, useState } from 'react';
import { Composer } from './Composer.js';
import * as api from '../../lib/api.js';
import { IconSpark } from '../../lib/icons.js';

export interface Message {
  who: 'user' | 'assistant';
  text: string;
  pending?: boolean;
}

interface Props {
  threadId: string;
}

export const Conversation = ({ threadId }: Props) => {
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);

  // 挂载时从 gateway 拉历史。父组件用 key={threadId} 强制重挂载,
  // 所以每次切 thread 都会重跑这里 → Hermes SQLite 是单一真相源。
  useEffect(() => {
    let cancelled = false;
    setLoadingHistory(true);
    api.fetchHistory(threadId)
      .then((history) => {
        if (cancelled) return;
        setMsgs(history.map((m) => ({
          who: m.role,
          text: m.content,
        })));
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('fetchHistory failed', err);
        setMsgs([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });
    return () => { cancelled = true; };
  }, [threadId]);

  const onSend = async (text: string) => {
    // 乐观 append。assistant 回复落地后,Hermes 已把这两条 msg 写进 SQLite,
    // 下次切 thread 重挂载会从 gateway 重拉,数据自洽
    setMsgs((m) => [...m, { who: 'user', text }, { who: 'assistant', text: '', pending: true }]);
    setBusy(true);

    try {
      const { reply } = await api.sendChat({ thread_id: threadId, message: text });
      setMsgs((m) => m.map((x, i) => i === m.length - 1 ? { ...x, text: reply, pending: false } : x));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : '请求失败';
      setMsgs((m) => m.map((x, i) => i === m.length - 1 ? { ...x, text: `[错误] ${errMsg}`, pending: false } : x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
      <div style={{ flex: 1, overflow: 'auto', padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
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
              {m.text || (m.pending ? <span className="pulse">灵犀正在思考…</span> : '')}
            </div>
          </div>
        ))}
      </div>
      <Composer disabled={busy} onSend={onSend} />
    </div>
  );
};
