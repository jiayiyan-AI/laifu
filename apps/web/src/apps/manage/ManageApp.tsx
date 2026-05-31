import { useAuth } from '../../auth/AuthContext.js';
import { IconSpark, IconGlobe, IconFile, IconMessage } from '../../lib/icons.js';

const caps = [
  { id: 'web',    name: '联网搜索', icon: <IconGlobe size={22} color="var(--accent)" /> },
  { id: 'file',   name: '文件读写', icon: <IconFile size={22} color="var(--accent)" /> },
  { id: 'wechat', name: '微信收发', icon: <IconMessage size={22} color="var(--accent)" /> },
];

export const ManageApp = ({ onOpenWechat }: { onOpenWechat: () => void }) => {
  const auth = useAuth();
  const nick = auth.status === 'authenticated' ? auth.user.nickname ?? '未命名' : '';

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 22 }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <div className="card" style={{ padding: 18, display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
          <span style={{ display: 'inline-flex', width: 52, height: 52, borderRadius: 14, background: '#7c3aed1f', color: '#7c3aed', alignItems: 'center', justifyContent: 'center' }}>
            <IconSpark size={26} strokeWidth={1.9} />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 650, fontSize: 16 }}>灵犀助理</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
              <span className="pulse" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ok)', display: 'inline-block', marginRight: 6 }} />
              在线 · {nick} 的助理
            </div>
          </div>
          <button
            className="btn btn-primary"
            style={{ background: '#16a34a' }}
            onClick={onOpenWechat}
          >
            <IconMessage size={15} />绑定微信
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>已装备能力 · {caps.length}</div>
        </div>
        <div style={{ display: 'grid', gap: 13, gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
          {caps.map((c) => (
            <div key={c.id} style={{ padding: 14, border: '1px solid var(--accent)', background: 'var(--accent-weak2)', borderRadius: 12 }}>
              {c.icon}
              <div style={{ fontWeight: 600, marginTop: 10 }}>{c.name}</div>
              <div style={{ fontSize: 12, marginTop: 2, color: 'var(--accent-d)' }}>已装备</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
