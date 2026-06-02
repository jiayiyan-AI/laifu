import { IconFolder } from '../../lib/icons.js';

export const Sidebar = ({ onHome }: { onHome: () => void }) => (
  <div style={{ width: 160, borderRight: '1px solid var(--border)', padding: '12px 8px', background: 'var(--surface)' }}>
    <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', padding: '0 8px 6px' }}>位置</div>
    <button
      onClick={onHome}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
        width: '100%', border: 'none', background: 'none', cursor: 'pointer',
        borderRadius: 6, textAlign: 'left',
      }}
    >
      <IconFolder size={14} color="var(--accent)" />
      <span>我的云盘</span>
    </button>
  </div>
);
