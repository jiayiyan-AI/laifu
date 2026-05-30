import { useRef, useState } from 'react';
import { Composer } from './Composer.js';
import * as api from '../../lib/api.js';
import { IconSpark } from '../../lib/icons.js';

interface Message {
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
  const esRef = useRef<EventSource | null>(null);

  const onSend = async (text: string) => {
    setMsgs((m) => [...m, { who: 'user', text }, { who: 'assistant', text: '', pending: true }]);
    setBusy(true);

    try {
      const { stream_id } = await api.startChat({ thread_id: threadId, message: text });
      const es = new EventSource(`/api/chat/stream?stream_id=${encodeURIComponent(stream_id)}`);
      esRef.current = es;

      es.addEventListener('token', (e) => {
        const d = JSON.parse(e.data) as { text: string };
        setMsgs((m) => {
          const next = [...m];
          const last = next[next.length - 1]!;
          next[next.length - 1] = { ...last, text: last.text + d.text };
          return next;
        });
      });

      es.addEventListener('tool', (e) => {
        const d = JSON.parse(e.data) as { name: string; preview: string };
        setMsgs((m) => {
          const next = [...m];
          const last = next[next.length - 1]!;
          next[next.length - 1] = { ...last, text: last.text + `\n[使用工具：${d.name} · ${d.preview}]\n` };
          return next;
        });
      });

      es.addEventListener('done', () => {
        setMsgs((m) => m.map((x, i) => i === m.length - 1 ? { ...x, pending: false } : x));
        es.close();
        setBusy(false);
      });

      es.addEventListener('error', () => {
        setMsgs((m) => m.map((x, i) => i === m.length - 1 ? { ...x, text: x.text + '\n[连接错误]', pending: false } : x));
        es.close();
        setBusy(false);
      });
    } catch (err) {
      setMsgs((m) => m.map((x, i) => i === m.length - 1 ? { ...x, text: '[请求失败]' + (err instanceof Error ? err.message : ''), pending: false } : x));
      setBusy(false);
    }
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
      <div style={{ flex: 1, overflow: 'auto', padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {msgs.length === 0 && <div className="dim" style={{ fontSize: 13, textAlign: 'center', marginTop: 60 }}>说说看，我能帮你做什么。</div>}
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
              {m.text || (m.pending ? '…' : '')}
            </div>
          </div>
        ))}
      </div>
      <Composer disabled={busy} onSend={onSend} />
    </div>
  );
};
