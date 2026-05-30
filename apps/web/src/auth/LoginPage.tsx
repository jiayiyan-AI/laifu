import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wallpaper } from '../lib/Wallpaper.js';
import { IconSpark, IconMessage } from '../lib/icons.js';
import { useAuth } from './AuthContext.js';

export const LoginPage = () => {
  const auth = useAuth();
  const nav = useNavigate();
  const [unionid, setUnionid] = useState('wx_demo_user');
  const [nickname, setNickname] = useState('Demo');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (auth.status === 'authenticated') {
    nav('/desktop', { replace: true });
    return null;
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (auth.status === 'loading') return;
    setSubmitting(true);
    setErr(null);
    try {
      await auth.devLogin({ wx_unionid: unionid.trim(), nickname: nickname.trim() || undefined });
      nav('/desktop', { replace: true });
    } catch (e) {
      setErr(e instanceof Error ? e.message : '登录失败');
    } finally {
      setSubmitting(false);
    }
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

        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input
            className="input"
            placeholder="wx_unionid（dev 模式直接填）"
            value={unionid}
            onChange={(e) => setUnionid(e.target.value)}
          />
          <input
            className="input"
            placeholder="你的称呼"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
          />
          {err && <div style={{ color: 'var(--bad)', fontSize: 12 }}>{err}</div>}
          <button type="submit" className="btn btn-primary" style={{ width: '100%', padding: 11, marginTop: 8 }} disabled={submitting || auth.status === 'loading'}>
            {submitting ? '登录中…' : '登录'}
          </button>
        </form>

        <button
          type="button"
          className="btn btn-ghost"
          style={{ width: '100%', padding: 11, marginTop: 10 }}
          onClick={() => alert('微信扫码登录：等开放平台资质就绪后启用')}
        >
          <IconMessage size={16} color="#16a34a" />
          微信扫码登录（敬请期待）
        </button>
      </div>
    </div>
  );
};
