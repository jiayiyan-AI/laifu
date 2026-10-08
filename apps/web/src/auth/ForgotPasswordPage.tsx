import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Wallpaper } from '../lib/Wallpaper.js';
import * as api from '../lib/api.js';
import { passwordErrorMessage } from './passwordErrors.js';

const inputStyle = {
  width: '100%', padding: '10px 12px', fontSize: 14,
  border: '1px solid var(--border)', borderRadius: 10, outline: 'none',
  boxSizing: 'border-box' as const,
};

/** 找回密码: 填邮箱 → 统一提示(不泄露邮箱是否注册)。 */
export const ForgotPasswordPage = () => {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.forgotPassword({ email: email.trim() });
      setSent(true);
    } catch (err) {
      console.error('[ForgotPasswordPage] failed:', err);
      setError(passwordErrorMessage(err, '提交失败，请重试'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
      <Wallpaper />
      <div className="card fade" style={{ width: 380, padding: 28, background: 'rgba(255,255,255,0.86)', backdropFilter: 'blur(30px)', borderRadius: 20, position: 'relative', zIndex: 2 }}>
        <div style={{ fontSize: 17, fontWeight: 650, marginBottom: 6 }}>找回密码</div>
        {sent ? (
          <div style={{ fontSize: 13.5, lineHeight: 1.6, margin: '12px 0 18px' }}>
            如果该邮箱已注册，你会收到一封重置邮件，请在 30 分钟内完成。没收到请检查垃圾邮件箱。
          </div>
        ) : (
          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
            <input placeholder="注册邮箱" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} />
            {error && <div style={{ color: '#dc2626', fontSize: 12.5 }}>{error}</div>}
            <button type="submit" disabled={busy || !email.trim()} style={{ width: '100%', padding: 11, marginTop: 8, fontSize: 14, fontWeight: 600, border: 'none', borderRadius: 10, background: '#7c3aed', color: '#fff', opacity: busy ? 0.6 : 1 }}>发送重置邮件</button>
          </form>
        )}
        <div style={{ marginTop: 14, fontSize: 12.5 }}><Link to="/login">返回登录</Link></div>
      </div>
    </div>
  );
};
