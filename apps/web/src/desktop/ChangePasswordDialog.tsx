import { useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { validateNewPassword } from '@lingxi/shared';
import * as api from '../lib/api.js';
import { authAtom } from '../states/auth.atom.js';
import { passwordErrorMessage, newPasswordProblem } from '../auth/passwordErrors.js';

const inputStyle = {
  width: '100%', padding: '10px 12px', fontSize: 14,
  border: '1px solid var(--border)', borderRadius: 10, outline: 'none',
  boxSizing: 'border-box' as const,
};

/**
 * 修改密码弹窗(仅 password 账号可见, 入口在 Menubar 账号下拉)。
 * 必须 portal 到 body: Menubar 带 backdropFilter, 会成为 fixed 子元素的包含块,
 * 直接渲染在里面时遮罩只有菜单栏 26px 高, 弹窗跑出界面。
 */
export const ChangePasswordDialog = ({ onClose }: { onClose: () => void }) => {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const { refresh } = authAtom.useChange();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const problem = newPasswordProblem(next, confirm, validateNewPassword);
    if (problem) { setError(problem); return; }
    setBusy(true);
    try {
      await api.changePassword({ current_password: current, new_password: next });
      setDone(true);
    } catch (err) {
      if (err instanceof api.ApiError && err.status === 401) {
        // 本会话已被吊销 (别处改过密码): 不展示"修改失败：session revoked",
        // 刷新登录态 → /me 401 → unauthenticated → ProtectedRoute 跳 /login。
        void refresh();
        return;
      }
      console.error('[ChangePasswordDialog] change failed:', err);
      setError(passwordErrorMessage(err, '修改失败'));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3000 }}
    >
      <div
        className="card fade"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 360, padding: 24, background: 'var(--panel)', borderRadius: 16, boxShadow: 'var(--shadow-l)' }}
      >
        <div style={{ fontSize: 16, fontWeight: 650, marginBottom: 14 }}>修改密码</div>
        {done ? (
          <>
            <div style={{ fontSize: 13.5, marginBottom: 16 }}>密码已修改，其他设备已退出登录</div>
            <button type="button" onClick={onClose} style={{ width: '100%', padding: 10, borderRadius: 10, border: 'none', background: '#7c3aed', color: '#fff', fontWeight: 600 }}>完成</button>
          </>
        ) : (
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input type="password" placeholder="当前密码" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} style={inputStyle} />
            <input type="password" placeholder="新密码" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} style={inputStyle} />
            <input type="password" placeholder="确认新密码" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={inputStyle} />
            {error && <div style={{ color: '#dc2626', fontSize: 12.5 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button type="button" onClick={onClose} style={{ flex: 1, padding: 10, borderRadius: 10, border: '1px solid var(--border)', background: 'transparent' }}>取消</button>
              <button type="submit" disabled={busy} style={{ flex: 1, padding: 10, borderRadius: 10, border: 'none', background: '#7c3aed', color: '#fff', fontWeight: 600, opacity: busy ? 0.6 : 1 }}>确认修改</button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
};
