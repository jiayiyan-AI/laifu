import { useState, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';
import * as api from '../../lib/api.js';
import { useEntitlements } from '../../lib/entitlements-context.js';

type Phase = 'idle' | 'confirm' | 'posting' | 'polling' | 'done' | 'failed' | 'timeout';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 30_000;

interface Props {
  /**
   * Rendered for the user to trigger the disable. Receives an `open` callback to
   * open the confirm modal. Typically a small ✕ icon button. The modal + state
   * machine are rendered by this component.
   */
  trigger: (open: () => void) => ReactNode;
}

export const DisableCloudButton = ({ trigger }: Props) => {
  const ent = useEntitlements();
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);

  const stillActive = ent.observed.includes('cloud');

  useEffect(() => {
    if (phase === 'polling' && !stillActive) {
      cleanup();
      setPhase('done');
      // brief delay then idle so caller re-renders cleanly
      window.setTimeout(() => setPhase('idle'), 800);
    }
  }, [phase, stillActive]);

  function cleanup() {
    if (timeoutRef.current) { window.clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    if (intervalRef.current) { window.clearInterval(intervalRef.current); intervalRef.current = null; }
  }
  useEffect(() => cleanup, []);

  async function handleDisable(): Promise<void> {
    setPhase('posting');
    setErrorMsg(null);
    try {
      await api.disableCloud();
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

  return (
    <>
      {trigger(() => setPhase('confirm'))}

      {(phase === 'confirm' || phase === 'posting' || phase === 'polling' || phase === 'failed' || phase === 'timeout') && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000,
        }}>
          <div className="card" style={{ width: 360, padding: 28, textAlign: 'center' }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>☁️</div>

            {phase === 'confirm' && (
              <>
                <div style={{ fontWeight: 600, marginBottom: 10 }}>退订云盘</div>
                <div className="muted" style={{ fontSize: 13, marginBottom: 16, textAlign: 'left' }}>
                  退订后：<br />
                  • 桌面"文件"应用会消失<br />
                  • 已发布的文件保留（不删除），重新装备后可继续访问
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                  <button className="btn" onClick={() => setPhase('idle')}>取消</button>
                  <button className="btn btn-primary" style={{ background: '#dc2626' }} onClick={() => void handleDisable()}>确认退订</button>
                </div>
              </>
            )}

            {phase === 'posting' && <div style={{ fontWeight: 600 }}>正在记录退订…</div>}
            {phase === 'polling' && (
              <>
                <div style={{ fontWeight: 600 }}>正在卸载…</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>预计 5 - 15 秒</div>
              </>
            )}
            {phase === 'failed' && (
              <>
                <div style={{ fontWeight: 600, color: 'var(--err, #c00)' }}>退订失败</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{errorMsg}</div>
                <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
                  <button className="btn" onClick={() => setPhase('idle')}>关闭</button>
                  <button className="btn btn-primary" onClick={() => void handleDisable()}>重试</button>
                </div>
              </>
            )}
            {phase === 'timeout' && (
              <>
                <div style={{ fontWeight: 600 }}>退订未完成</div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  请稍后重试
                </div>
                <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
                  <button className="btn" onClick={() => setPhase('idle')}>关闭</button>
                  <button className="btn btn-primary" onClick={() => void handleDisable()}>立即重试</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
};
