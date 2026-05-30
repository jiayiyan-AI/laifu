import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext.js';
import { IconChevDown, IconUser, IconPower } from '../lib/icons.js';

const fmtClock = () => {
  const d = new Date();
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' })
    + ' '
    + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
};

export const Menubar = () => {
  const auth = useAuth();
  const [clock, setClock] = useState(fmtClock());
  const [accountOpen, setAccountOpen] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setClock(fmtClock()), 20_000);
    return () => clearInterval(t);
  }, []);

  if (auth.status !== 'authenticated') return null;

  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0, height: 26,
      display: 'flex', alignItems: 'center', gap: 18, padding: '0 14px',
      fontSize: 13, color: '#1b1c20', background: 'rgba(255,255,255,0.5)',
      backdropFilter: 'blur(22px) saturate(180%)',
      borderBottom: '1px solid rgba(0,0,0,0.07)', zIndex: 1000,
    }}>
      <span style={{ fontWeight: 700 }}>灵犀</span>
      <span style={{ color: '#2c2d33' }}>文件</span>
      <span style={{ color: '#2c2d33' }}>编辑</span>
      <span style={{ color: '#2c2d33' }}>查看</span>
      <span style={{ color: '#2c2d33' }}>帮助</span>
      <span style={{ flex: 1 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, color: '#2c2d33', position: 'relative' }}>
        <span>{clock}</span>
        <button onClick={() => setAccountOpen((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {auth.user.nickname ?? '未命名'} <IconChevDown size={13} />
        </button>
        {accountOpen && (
          <div style={{
            position: 'absolute', top: 30, right: 0, width: 236,
            background: 'var(--panel)', border: '1px solid var(--border)',
            borderRadius: 14, boxShadow: 'var(--shadow-l)', padding: 6, zIndex: 2000,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px 10px' }}>
              <span style={{ display: 'inline-flex', width: 36, height: 36, borderRadius: 10, background: '#7c3aed1f', color: '#7c3aed', alignItems: 'center', justifyContent: 'center' }}>
                <IconUser size={18} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{auth.user.nickname ?? '未命名'}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>{auth.user.wx_unionid}</div>
              </div>
            </div>
            <div style={{ height: 1, background: 'var(--border)', margin: '4px 6px' }} />
            <button
              onClick={() => { setAccountOpen(false); void auth.logout(); }}
              style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 11, padding: '8px 10px', borderRadius: 9, fontSize: 13.5, color: 'var(--bad)' }}
            >
              <IconPower size={16} /> 退出登录
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
