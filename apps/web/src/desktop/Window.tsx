import type { ReactNode } from 'react';

interface WindowProps {
  title: string;
  icon?: ReactNode;
  width?: number;
  height?: number;
  offsetX?: number;
  offsetY?: number;
  onClose: () => void;
  children: ReactNode;
}

export const Window = ({ title, icon, width = 760, height = 540, offsetX = 0, offsetY = 0, onClose, children }: WindowProps) => {
  const left = `calc(50% - ${width / 2}px + ${offsetX}px)`;
  const top = `calc(50% - ${height / 2}px + ${offsetY}px - 13px)`;
  return (
    <div className="fade" style={{
      position: 'absolute', left, top, width, height,
      display: 'flex', flexDirection: 'column',
      background: 'rgba(255,255,255,0.95)',
      borderRadius: 12, overflow: 'hidden',
      boxShadow: '0 30px 80px rgba(0,0,0,0.34), 0 0 0 1px rgba(0,0,0,0.09)',
      backdropFilter: 'blur(30px) saturate(180%)',
    }}>
      <div style={{
        height: 46, flex: '0 0 46px', display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 14px', background: 'rgba(248,248,250,0.85)',
        borderBottom: '1px solid rgba(0,0,0,0.07)',
      }}>
        <button
          onClick={onClose}
          aria-label="close"
          style={{ width: 12, height: 12, borderRadius: '50%', background: '#ff5f57', padding: 0, border: 'none' }}
        />
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#febc2e', opacity: 0.5 }} />
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#28c840', opacity: 0.5 }} />
        <span style={{ marginLeft: 4, fontSize: 13, fontWeight: 600, color: '#3a3a40', display: 'flex', alignItems: 'center', gap: 7 }}>
          {icon}{title}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', background: '#fff', overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  );
};
