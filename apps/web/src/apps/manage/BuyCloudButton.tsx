import { useState, useRef, useEffect } from 'react';
import * as api from '../../lib/api.js';
import { entitlementsAtom } from '../../states/entitlements.atom.js';

type Phase = 'idle' | 'confirm' | 'posting' | 'polling' | 'ready' | 'failed' | 'timeout';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 30_000;

export const BuyCloudButton = ({ onReady }: { onReady: () => void }) => {
  const [ent, { refetch }] = entitlementsAtom.use();
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
      intervalRef.current = window.setInterval(() => { void refetch(); }, POLL_INTERVAL_MS);
      timeoutRef.current = window.setTimeout(() => {
        cleanup();
        setPhase('timeout');
      }, POLL_TIMEOUT_MS);
      void refetch();
    } catch (err) {
      setPhase('failed');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  if (isActive && phase !== 'polling' && phase !== 'posting') {
    return (
      <button className="btn" disabled style={{ background: '#16a34a', color: 'white' }}>
        ✓ 已装备
      </button>
    );
  }

  return (
    <>
      <button
        className="btn btn-primary"
        onClick={() => setPhase('confirm')}
        disabled={phase !== 'idle' && phase !== 'failed' && phase !== 'timeout'}
        style={{ background: '#0ea5e9' }}
      >
        购买并装备
      </button>

      {(phase === 'confirm' || phase === 'posting' || phase === 'polling' || phase === 'failed' || phase === 'timeout') && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000,
        }}>
          <div className="card" style={{ width: 360, padding: 28, textAlign: 'center' }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>☁️</div>
            {phase === 'confirm' && (
              <>
                <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>云盘</div>
                <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
                  让助理把成果保存到云端，桌面会出现"文件"应用
                </div>
                <div style={{ fontSize: 13, marginBottom: 4 }}>
                  价格: 免费（后续可能收费）
                </div>
                <div style={{ fontSize: 13, marginBottom: 18 }}>
                  容量: 无限制
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                  <button className="btn" onClick={() => setPhase('idle')}>取消</button>
                  <button className="btn btn-primary" style={{ background: '#0ea5e9' }} onClick={() => void handleEnable()}>
                    确认购买并装备
                  </button>
                </div>
              </>
            )}
            {phase === 'posting' && <div style={{ fontWeight: 600 }}>正在记录订单…</div>}
            {phase === 'polling' && (
              <>
                <div style={{ fontWeight: 600 }}>正在装备到助理…</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>预计 5 - 15 秒</div>
              </>
            )}
            {phase === 'failed' && (
              <>
                <div style={{ fontWeight: 600, color: 'var(--err, #c00)' }}>购买失败</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{errorMsg}</div>
                <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
                  <button className="btn" onClick={() => setPhase('idle')}>关闭</button>
                  <button className="btn btn-primary" onClick={() => void handleEnable()}>重新购买</button>
                </div>
              </>
            )}
            {phase === 'timeout' && (
              <>
                <div style={{ fontWeight: 600 }}>装备未完成</div>
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
