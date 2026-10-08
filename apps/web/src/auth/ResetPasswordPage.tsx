import { useState, useEffect, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { validateNewPassword } from '@lingxi/shared';
import { Wallpaper } from '../lib/Wallpaper.js';
import * as api from '../lib/api.js';
import { passwordErrorMessage, newPasswordProblem } from './passwordErrors.js';

const inputStyle = {
  width: '100%', padding: '10px 12px', fontSize: 14,
  border: '1px solid var(--border)', borderRadius: 10, outline: 'none',
  boxSizing: 'border-box' as const,
};

/** 邮件链接落地页: /reset-password?token=… → 设新密码 → 跳登录。 */
export const ResetPasswordPage = () => {
  const [params] = useSearchParams();
  // 只在首次渲染读一次 token, 随后把它从地址栏抹掉(避免进浏览器历史 / Referer)。
  const [token] = useState(() => params.get('token')?.trim() ?? '');
  const nav = useNavigate();
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(token ? '' : '链接无效或已过期');
  const [expired, setExpired] = useState(!token);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (token) window.history.replaceState(null, '', '/reset-password');
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const problem = newPasswordProblem(next, confirm, validateNewPassword);
    if (problem) { setError(problem); return; }
    setBusy(true);
    try {
      await api.resetPassword({ token, new_password: next });
      nav('/login', { replace: true, state: { notice: '密码已重置，请登录' } });
    } catch (err) {
      console.error('[ResetPasswordPage] failed:', err);
      if (err instanceof api.ApiError && err.code === 'invalid_or_expired_token') setExpired(true);
      setError(passwordErrorMessage(err, '重置失败'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
      <Wallpaper />
      <div className="card fade" style={{ width: 380, padding: 28, background: 'rgba(255,255,255,0.86)', backdropFilter: 'blur(30px)', borderRadius: 20, position: 'relative', zIndex: 2 }}>
        <div style={{ fontSize: 17, fontWeight: 650, marginBottom: 12 }}>设置新密码</div>
        {!expired && (
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input type="password" placeholder="新密码" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} style={inputStyle} />
            <input type="password" placeholder="确认新密码" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} style={inputStyle} />
            {error && <div style={{ color: '#dc2626', fontSize: 12.5 }}>{error}</div>}
            <button type="submit" disabled={busy} style={{ width: '100%', padding: 11, marginTop: 8, fontSize: 14, fontWeight: 600, border: 'none', borderRadius: 10, background: '#7c3aed', color: '#fff', opacity: busy ? 0.6 : 1 }}>设置新密码</button>
          </form>
        )}
        {expired && (
          <>
            <div style={{ color: '#dc2626', fontSize: 13.5, marginBottom: 12 }}>{error}</div>
            <Link to="/forgot-password">重新申请</Link>
          </>
        )}
      </div>
    </div>
  );
};
