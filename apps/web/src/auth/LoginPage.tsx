import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { MIN_PASSWORD_LENGTH } from '@lingxi/shared';
import { Wallpaper } from '../lib/Wallpaper.js';
import { IconSpark } from '../lib/icons.js';
import { authAtom } from '../states/auth.atom.js';
import * as api from '../lib/api.js';

type Mode = 'login' | 'register';

/** 把后端的认证错误码映射成给用户看的中文。未知错误直接透出真实信息, 不再甩锅给邮箱。 */
const authErrorMessage = (e: unknown, mode: Mode): string => {
  if (e instanceof api.ApiError) {
    switch (e.code) {
      case 'invalid_email': return '邮箱格式不正确';
      case 'password_too_short': return `密码至少 ${MIN_PASSWORD_LENGTH} 位`;
      case 'email_taken': return '该邮箱已注册，请直接登录';
      case 'invalid_credentials': return '邮箱或密码错误';
      default: return `${mode === 'login' ? '登录' : '注册'}失败：${e.message}`;
    }
  }
  return mode === 'login' ? '登录失败，请重试' : '注册失败，请重试';
};

/**
 * 登录页:账号密码为主(登录/注册 tab),Google OAuth 作为下方次要入口。
 * 将来微信登录接通后,排在 Google 下面形成次要入口栈。
 */
export const LoginPage = () => {
  const [state, actions] = authAtom.use();
  const nav = useNavigate();

  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (state.status === 'authenticated') {
    nav('/desktop', { replace: true });
    return null;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    // 客户端即时校验: 密码太短不必往返服务端 (与后端 MIN_PASSWORD_LENGTH 同源)。
    if (mode === 'register' && password.length < MIN_PASSWORD_LENGTH) {
      setError(`密码至少 ${MIN_PASSWORD_LENGTH} 位`);
      return;
    }
    setBusy(true);
    try {
      if (mode === 'login') {
        await api.login({ email, password });
      } else {
        await api.register({ email, password });
      }
      await actions.refresh();
      nav('/desktop', { replace: true });
    } catch (e) {
      console.error('[LoginPage] auth failed:', e);
      setError(authErrorMessage(e, mode));
    } finally {
      setBusy(false);
    }
  };

  const segBtn = (m: Mode, label: string) => (
    <button
      type="button"
      onClick={() => { setMode(m); setError(''); }}
      style={{
        flex: 1, padding: '7px 0', fontSize: 13, fontWeight: 600, cursor: 'pointer',
        border: 'none', borderRadius: 8,
        background: mode === m ? '#fff' : 'transparent',
        color: mode === m ? '#1b1c20' : 'var(--dim, #6b7280)',
        boxShadow: mode === m ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
      }}
    >{label}</button>
  );

  const inputStyle = {
    width: '100%', padding: '10px 12px', fontSize: 14,
    border: '1px solid var(--border)', borderRadius: 10, outline: 'none',
    boxSizing: 'border-box' as const,
  };

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
      <Wallpaper />
      <div className="card fade" style={{ width: 380, padding: 28, background: 'rgba(255,255,255,0.86)', backdropFilter: 'blur(30px)', borderRadius: 20, position: 'relative', zIndex: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 22 }}>
          <span style={{ display: 'inline-flex', width: 42, height: 42, borderRadius: 12, background: '#7c3aed1f', color: '#7c3aed', alignItems: 'center', justifyContent: 'center' }}>
            <IconSpark size={20} />
          </span>
          <div>
            <div style={{ fontSize: 17, fontWeight: 650 }}>灵犀</div>
            <div className="dim" style={{ fontSize: 12 }}>数字员工平台</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 4, padding: 4, background: 'rgba(0,0,0,0.04)', borderRadius: 10, marginBottom: 16 }}>
          {segBtn('login', '账号登录')}
          {segBtn('register', '注册')}
        </div>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input
            placeholder="邮箱" type="email" value={email} autoComplete="email"
            onChange={(e) => setEmail(e.target.value)} style={inputStyle}
          />
          <input
            placeholder="密码" type="password" value={password}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            onChange={(e) => setPassword(e.target.value)} style={inputStyle}
          />
          {error && <div style={{ color: '#dc2626', fontSize: 12.5 }}>{error}</div>}
          <button
            type="submit" disabled={busy}
            style={{
              width: '100%', padding: 11, marginTop: 8, fontSize: 14, fontWeight: 600,
              border: 'none', borderRadius: 10, cursor: busy ? 'default' : 'pointer',
              background: '#7c3aed', color: '#fff', opacity: busy ? 0.6 : 1,
            }}
          >{mode === 'login' ? '登录' : '注册并进入'}</button>
        </form>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '16px 0' }}>
          <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          <span className="dim" style={{ fontSize: 11 }}>或</span>
          <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        </div>

        <button
          type="button"
          onClick={() => {
            // Google 禁止在内嵌 WebView 里走 OAuth 授权（会报 "This browser or app
            // may not be secure"）。桌面 app 里改走系统默认浏览器，完成后经 deep link
            // （`laifu://auth-callback`）回到 app（见 src-tauri/app/auth_commands.rs open_oauth_in_browser /
            // complete_desktop_oauth）；普通浏览器仍走同页跳转。
            if (isTauri()) {
              void invoke('open_oauth_in_browser', { provider: 'google' });
            } else {
              window.location.href = '/api/auth/google/start';
            }
          }}
          className="btn"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            width: '100%', padding: 11, fontSize: 14, fontWeight: 600,
            border: '1px solid var(--border)', background: '#fff', color: '#1b1c20',
            borderRadius: 10, cursor: 'pointer',
          }}
        >
          <GoogleIcon /> 使用 Google 登录
        </button>
      </div>
    </div>
  );
};

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18">
    <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
    <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
    <path d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z" fill="#FBBC05"/>
    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.167 6.656 3.58 9 3.58z" fill="#EA4335"/>
  </svg>
);
