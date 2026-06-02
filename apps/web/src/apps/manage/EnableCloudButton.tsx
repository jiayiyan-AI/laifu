import { useState, useRef, useEffect } from 'react';
import * as api from '../../lib/api.js';
import { useEntitlements } from '../../lib/entitlements-context.js';

type Phase = 'idle' | 'posting' | 'polling' | 'ready' | 'failed' | 'timeout';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 30_000;

export const EnableCloudButton = ({ onReady }: { onReady: () => void }) => {
  const ent = useEntitlements();
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);

  const isActive = ent.observed.includes('cloud');

  useEffect(() => {
    if (phase === 'polling' && isActive) {
      cleanup();
      setPhase('ready');
      onReady();
    }
  }, [phase, isActive, onReady]);

  function cleanup() {
    if (timeoutRef.current) { window.clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    if (intervalRef.current) { window.clearInterval(intervalRef.current); intervalRef.current = null; }
  }
  useEffect(() => cleanup, []);

  async function handleEnable(): Promise<void> {
    setPhase('posting');
    setErrorMsg(null);
    try {
      await api.enableCloud();
      setPhase('polling');
      intervalRef.current = window.setInterval(() => { void ent.refetch(); }, POLL_INTERVAL_MS);
      timeoutRef.current = window.setTimeout(() => {
        cleanup();
        setPhase('timeout');
      }, POLL_TIMEOUT_MS);
      void ent.refetch();
    } catch (err) {
      setPhase('failed');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  if (isActive && phase !== 'polling' && phase !== 'posting') {
    return (
      <button className="btn" disabled style={{ background: '#16a34a', color: 'white' }}>
        ☁️ 已启用云盘
      </button>
    );
  }

  return (
    <>
      <button
        className="btn btn-primary"
        onClick={() => void handleEnable()}
        disabled={phase !== 'idle' && phase !== 'failed' && phase !== 'timeout'}
        style={{ background: '#0ea5e9' }}
      >
        ☁️ 启用云盘
      </button>

      {(phase === 'posting' || phase === 'polling' || phase === 'failed' || phase === 'timeout') && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000,
        }}>
          <div className="card" style={{ width: 360, padding: 28, textAlign: 'center' }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>☁️</div>
            {phase === 'posting' && <div style={{ fontWeight: 600 }}>正在记录权益…</div>}
            {phase === 'polling' && (
              <>
                <div style={{ fontWeight: 600 }}>助理重启中…</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>预计 5 - 15 秒</div>
              </>
            )}
            {phase === 'failed' && (
              <>
                <div style={{ fontWeight: 600, color: 'var(--err, #c00)' }}>启用失败</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{errorMsg}</div>
                <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
                  <button className="btn" onClick={() => setPhase('idle')}>关闭</button>
                  <button className="btn btn-primary" onClick={() => void handleEnable()}>重试</button>
                </div>
              </>
            )}
            {phase === 'timeout' && (
              <>
                <div style={{ fontWeight: 600 }}>启用未完成</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  请稍后在"我的助理"重试
                </div>
                <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
                  <button className="btn" onClick={() => setPhase('idle')}>关闭</button>
                  <button className="btn btn-primary" onClick={() => void handleEnable()}>立即重试</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
};
