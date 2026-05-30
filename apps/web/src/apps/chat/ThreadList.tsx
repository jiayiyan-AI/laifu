import { useEffect, useState } from 'react';
import type { ThreadListItem } from '@lingxi/shared';
import * as api from '../../lib/api.js';
import { IconPlus } from '../../lib/icons.js';

interface Props {
  selected: string | null;
  onSelect: (id: string) => void;
}

export const ThreadList = ({ selected, onSelect }: Props) => {
  const [threads, setThreads] = useState<ThreadListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    setLoading(true);
    try {
      const list = await api.listThreads();
      setThreads(list);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, []);

  const onNew = async () => {
    const t = await api.createThread({});
    await reload();
    onSelect(t.id);
  };

  return (
    <div style={{ width: 236, flexShrink: 0, background: 'rgba(245,245,248,0.72)', borderRight: '1px solid rgba(0,0,0,0.07)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '10px 12px 4px' }}>
        <button className="btn btn-primary" style={{ width: '100%' }} onClick={onNew}>
          <IconPlus size={15} />新对话
        </button>
      </div>
      <div style={{ padding: '12px 14px 6px', fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        对话历史
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {loading && <div className="dim" style={{ padding: 12, fontSize: 12 }}>加载中…</div>}
        {!loading && threads.length === 0 && <div className="dim" style={{ padding: 12, fontSize: 12 }}>点击"新对话"开始</div>}
        {threads.map((t) => {
          const on = t.id === selected;
          return (
            <div
              key={t.id}
              onClick={() => onSelect(t.id)}
              style={{
                display: 'flex', gap: 10, padding: '9px 12px', margin: '0 8px',
                borderRadius: 9, cursor: 'pointer', alignItems: 'flex-start',
                background: on ? 'var(--accent-weak)' : undefined,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.title ?? '新对话'}
                </div>
                <div className="dim" style={{ fontSize: 11, marginTop: 2 }}>
                  {new Date(t.updated_at).toLocaleString('zh-CN').slice(5, 16)}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
