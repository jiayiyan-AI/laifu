import { toastAtom } from '../states/toast.atom.js';

const KIND_COLOR: Record<string, string> = { success: 'var(--ok)', error: 'var(--bad)', info: 'var(--accent)' };

export const ToastHost = () => {
  const [toasts, actions] = toastAtom.use();
  return (
    <div style={{ position: 'fixed', top: 38, right: 16, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none' }}>
      {toasts.map((t) => (
        <div key={t.id} className="fade" onClick={() => actions.dismiss(t.id)}
          style={{ pointerEvents: 'auto', cursor: 'pointer', background: 'rgba(255,255,255,0.98)', color: 'var(--text)',
            borderLeft: `3px solid ${KIND_COLOR[t.kind] ?? 'var(--accent)'}`, borderRadius: 10, padding: '10px 14px',
            fontSize: 13, boxShadow: '0 10px 30px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.06)', maxWidth: 320 }}>
          {t.msg}
        </div>
      ))}
    </div>
  );
};
