import { useState, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';
import * as api from '../../lib/api.js';
import { useEntitlements } from '../../lib/entitlements-context.js';
import type { Capability } from '../../lib/capabilities.js';

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 30_000;

/** 居中弹窗外壳(装备/退订共用)。 */
const Modal = ({ children }: { children: ReactNode }) => (
  <div style={{
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000,
  }}>
    <div className="card" style={{ width: 360, padding: 28, textAlign: 'center' }}>{children}</div>
  </div>
);

type EquipPhase = 'idle' | 'confirm' | 'posting' | 'polling' | 'ready' | 'failed' | 'timeout';

export const CapabilityEquip = ({ cap, onReady }: { cap: Capability; onReady?: () => void }) => {
  const ent = useEntitlements();
  const [phase, setPhase] = useState<EquipPhase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);

  const isActive = ent.observed.includes(cap.id);

  function cleanup() {
    if (timeoutRef.current) { window.clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    if (intervalRef.current) { window.clearInterval(intervalRef.current); intervalRef.current = null; }
  }
  useEffect(() => cleanup, []);

  useEffect(() => {
    if (phase === 'polling' && isActive) {
      cleanup();
      setPhase('ready');
      onReady?.();
    }
  }, [phase, isActive, onReady]);

  async function handleEnable(): Promise<void> {
    setPhase('posting');
    setErrorMsg(null);
    try {
      await api.enableFeature(cap.id);
      setPhase('polling');
      intervalRef.current = window.setInterval(() => { void ent.refetch(); }, POLL_INTERVAL_MS);
      timeoutRef.current = window.setTimeout(() => { cleanup(); setPhase('timeout'); }, POLL_TIMEOUT_MS);
      void ent.refetch();
    } catch (err) {
      setPhase('failed');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  if (isActive && phase !== 'polling' && phase !== 'posting') {
    return <button className="btn" disabled style={{ background: '#16a34a', color: 'white' }}>✓ 已装备</button>;
  }

  const copy = cap.enableCopy;
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
        <Modal>
          <div style={{ marginBottom: 10, display: 'flex', justifyContent: 'center' }}>{cap.icon}</div>
          {phase === 'confirm' && copy && (
            <>
              <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 6 }}>{copy.title}</div>
              <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>{copy.desc}</div>
              {copy.lines?.map((l, i) => (
                <div key={i} style={{ fontSize: 13, marginBottom: 4 }}>{l}</div>
              ))}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
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
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>请稍后在"我的助理"重试</div>
              <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button className="btn" onClick={() => setPhase('idle')}>关闭</button>
                <button className="btn btn-primary" onClick={() => void handleEnable()}>立即重试</button>
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
};

type RemovePhase = 'idle' | 'confirm' | 'posting' | 'polling' | 'done' | 'failed' | 'timeout';

export const CapabilityRemove = ({ cap, trigger }: { cap: Capability; trigger: (open: () => void) => ReactNode }) => {
  const ent = useEntitlements();
  const [phase, setPhase] = useState<RemovePhase>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);

  const stillActive = ent.observed.includes(cap.id);

  function cleanup() {
    if (timeoutRef.current) { window.clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    if (intervalRef.current) { window.clearInterval(intervalRef.current); intervalRef.current = null; }
  }
  useEffect(() => cleanup, []);

  useEffect(() => {
    if (phase === 'polling' && !stillActive) {
      cleanup();
      setPhase('done');
      window.setTimeout(() => setPhase('idle'), 800);
    }
  }, [phase, stillActive]);

  async function handleDisable(): Promise<void> {
    setPhase('posting');
    setErrorMsg(null);
    try {
      await api.disableFeature(cap.id);
      setPhase('polling');
      intervalRef.current = window.setInterval(() => { void ent.refetch(); }, POLL_INTERVAL_MS);
      timeoutRef.current = window.setTimeout(() => { cleanup(); setPhase('timeout'); }, POLL_TIMEOUT_MS);
      void ent.refetch();
    } catch (err) {
      setPhase('failed');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  const copy = cap.disableCopy;
  return (
    <>
      {trigger(() => setPhase('confirm'))}

      {(phase === 'confirm' || phase === 'posting' || phase === 'polling' || phase === 'failed' || phase === 'timeout') && (
        <Modal>
          <div style={{ marginBottom: 10, display: 'flex', justifyContent: 'center' }}>{cap.icon}</div>
          {phase === 'confirm' && copy && (
            <>
              <div style={{ fontWeight: 600, marginBottom: 10 }}>{copy.title}</div>
              <div className="muted" style={{ fontSize: 13, marginBottom: 16, textAlign: 'left' }}>
                {copy.desc}
                {copy.lines?.map((l, i) => (<div key={i}>{l}</div>))}
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
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>请稍后重试</div>
              <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button className="btn" onClick={() => setPhase('idle')}>关闭</button>
                <button className="btn btn-primary" onClick={() => void handleDisable()}>立即重试</button>
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
};
