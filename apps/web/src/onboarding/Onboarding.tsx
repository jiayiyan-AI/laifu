import { useEffect, useRef, useState } from 'react';
import * as api from '../lib/api.js';
import { IconSpark, IconRefresh } from '../lib/icons.js';

type View =
  | { mode: 'loading' }
  | { mode: 'not-purchased' }
  | { mode: 'provisioning'; step: string; pct: number }
  | { mode: 'failed'; err: string }
  | { mode: 'ready' };

interface OnboardingProps {
  onReady: () => void;
}

export const Onboarding = ({ onReady }: OnboardingProps) => {
  const [view, setView] = useState<View>({ mode: 'loading' });
  const [submitting, setSubmitting] = useState(false);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const s = await api.status();
        if (!s) { setView({ mode: 'not-purchased' }); return; }
        if (s.status === 'ready') { setView({ mode: 'ready' }); onReady(); return; }
        if (s.status === 'failed') { setView({ mode: 'failed', err: s.error_message ?? '未知错误' }); return; }
        setView({ mode: 'provisioning', step: s.provisioning_step ?? '准备中…', pct: s.progress_pct });
      } catch (e) {
        setView({ mode: 'failed', err: e instanceof Error ? e.message : '查询失败' });
      }
    })();
  }, [onReady]);

  useEffect(() => {
    if (view.mode !== 'provisioning') return;
    const tick = async () => {
      try {
        const s = await api.status();
        if (!s) return;
        if (s.status === 'ready') { onReady(); setView({ mode: 'ready' }); return; }
        if (s.status === 'failed') { setView({ mode: 'failed', err: s.error_message ?? '失败' }); return; }
        setView({ mode: 'provisioning', step: s.provisioning_step ?? '准备中…', pct: s.progress_pct });
      } catch { /* ignore tick errors */ }
    };
    pollRef.current = window.setInterval(tick, 1000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [view.mode, onReady]);

  const onPurchase = async () => {
    setSubmitting(true);
    try {
      await api.purchase();
      setView({ mode: 'provisioning', step: '正在创建账户与订单', pct: 5 });
    } catch (e) {
      setView({ mode: 'failed', err: e instanceof Error ? e.message : '购买失败' });
    } finally {
      setSubmitting(false);
    }
  };

  if (view.mode === 'loading') return <div className="dim" style={{ padding: 24 }}>加载中…</div>;
  if (view.mode === 'ready') return null;

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32, background: 'linear-gradient(180deg,#fff,#f7f5fd)' }}>
      <div style={{ width: 480, textAlign: 'center' }}>
        <span style={{ display: 'inline-flex', width: 76, height: 76, borderRadius: 22, background: '#7c3aed1f', color: '#7c3aed', alignItems: 'center', justifyContent: 'center', marginBottom: 18 }}>
          <IconSpark size={38} strokeWidth={1.9} />
        </span>
        <div style={{ fontSize: 22, fontWeight: 700 }}>欢迎使用灵犀</div>
        <p className="muted" style={{ fontSize: 13.5, margin: '10px 0 22px', lineHeight: 1.7 }}>
          激活你的数字助理「灵犀」——统一对话入口，按需装备能力。
        </p>

        {view.mode === 'not-purchased' && (
          <>
            <button className="btn btn-primary" style={{ padding: '12px 28px', fontSize: 14 }} disabled={submitting} onClick={onPurchase}>
              {submitting ? '激活中…' : '购买并激活灵犀助理'}
            </button>
            <div className="dim" style={{ fontSize: 11.5, marginTop: 10 }}>免费 · MVP 阶段</div>
          </>
        )}

        {view.mode === 'provisioning' && (
          <div className="fade">
            <div className="muted" style={{ height: 20, margin: '12px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 13 }}>
              <span className="spin"><IconRefresh size={13} /></span>{view.step}
            </div>
            <div className="progress"><div style={{ width: `${view.pct}%` }} /></div>
            <div className="dim" style={{ fontSize: 11.5, marginTop: 10 }}>预计 1-3 分钟（local 模式约 5 秒）</div>
          </div>
        )}

        {view.mode === 'failed' && (
          <div>
            <div style={{ color: 'var(--bad)', fontSize: 13, marginBottom: 12 }}>{view.err}</div>
            <button className="btn btn-ghost" onClick={() => setView({ mode: 'not-purchased' })}>重试</button>
          </div>
        )}
      </div>
    </div>
  );
};
