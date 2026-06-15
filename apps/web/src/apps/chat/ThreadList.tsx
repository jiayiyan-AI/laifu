import { useEffect, useState } from 'react';
import type { ThreadListItem } from '@lingxi/shared';
import * as api from '../../lib/api.js';
import { IconPlus, IconX } from '../../lib/icons.js';

interface Props {
  selected: string | null;
  onSelect: (id: string | null) => void;
}

export const ThreadList = ({ selected, onSelect }: Props) => {
  const [threads, setThreads] = useState<ThreadListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const reload = async (): Promise<ThreadListItem[]> => {
    setLoading(true);
    try {
      const list = await api.listThreads();
      setThreads(list);
      return list;
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

  // 删除单条对话: 浏览器原生 confirm 即可, 这里不做单独 modal —
  // 文案讲清楚 hermes session 也会被清, 让用户知道是双端硬删。
  const onDelete = async (e: React.MouseEvent, t: ThreadListItem) => {
    e.stopPropagation();   // 别触发行级 onSelect
    const title = t.title?.trim() || '新对话';
    if (!window.confirm(`删除「${title}」？此操作不可撤销,将同时清理该对话在助理容器内的 session。`)) return;
    setDeletingId(t.id);
    try {
      await api.deleteThread(t.id);
      const remaining = await reload();
      // 删的是当前选中那条 → 自动落到列表首条; 没有就清空回到引导态
      if (selected === t.id) {
        onSelect(remaining[0]?.id ?? null);
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : '删除失败');
    } finally {
      setDeletingId(null);
    }
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
          const busy = deletingId === t.id;
          return (
            <div
              key={t.id}
              onClick={() => onSelect(t.id)}
              className="thread-row"
              style={{
                display: 'flex', gap: 10, padding: '9px 12px', margin: '0 8px',
                borderRadius: 9, cursor: 'pointer', alignItems: 'flex-start',
                background: on ? 'var(--accent-weak)' : undefined,
                opacity: busy ? 0.5 : 1,
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
              <button
                type="button"
                aria-label={`删除对话 ${t.title ?? '新对话'}`}
                disabled={busy}
                onClick={(e) => onDelete(e, t)}
                className="thread-del"
                style={{
                  background: 'transparent', border: 'none', padding: 4, borderRadius: 6,
                  color: 'var(--text3)', cursor: busy ? 'wait' : 'pointer', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <IconX size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};
