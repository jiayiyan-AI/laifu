import { useEffect, useRef, useState, type ReactNode, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';

interface WindowProps {
  title: string;
  icon?: ReactNode;
  width?: number;
  height?: number;
  offsetX?: number;
  offsetY?: number;
  onClose: () => void;
  onFocus?: () => void;
  zIndex?: number;
  children: ReactNode;
}

interface Rect { x: number; y: number; w: number; h: number; }
type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const MIN_W = 420;
const MIN_H = 320;

// Menubar 占顶部 26px,Desktop 把窗口容器锚到它下面;此处坐标系是相对那个容器的
const TOP_INSET = 26;

const initialRect = (w: number, h: number, offX: number, offY: number): Rect => ({
  x: Math.max(0, (window.innerWidth - w) / 2 + offX),
  y: Math.max(0, (window.innerHeight - TOP_INSET - h) / 2 + offY - 13),
  w, h,
});

const EDGE_CURSOR: Record<ResizeEdge, string> = {
  n: 'ns-resize',  s: 'ns-resize',  e: 'ew-resize',  w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize',
};

export const Window = ({ title, icon, width = 760, height = 540, offsetX = 0, offsetY = 0, onClose, onFocus, zIndex, children }: WindowProps) => {
  // 关键:initial 只在 mount 时算一次,后续 props 变更不重置位置/尺寸
  const [rect, setRect] = useState<Rect>(() => initialRect(width, height, offsetX, offsetY));

  // useRef 存当前操作的初始快照(避免 state 频繁更新导致闭包陈旧)
  const dragRef = useRef<{ startX: number; startY: number; orig: Rect } | null>(null);
  const resizeRef = useRef<{ edge: ResizeEdge; startX: number; startY: number; orig: Rect } | null>(null);

  // 全局 mousemove/mouseup —— 在拖动/缩放期间绑定,否则光标离开 handle 就丢追踪
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragRef.current) {
        const { startX, startY, orig } = dragRef.current;
        // bounds: 不让窗口拖到容器外
        const parentW = window.innerWidth;
        const parentH = window.innerHeight - TOP_INSET;
        const nx = Math.min(Math.max(0, orig.x + (e.clientX - startX)), parentW - orig.w);
        const ny = Math.min(Math.max(0, orig.y + (e.clientY - startY)), parentH - orig.h);
        setRect((r) => ({ ...r, x: nx, y: ny }));
      } else if (resizeRef.current) {
        const { edge, startX, startY, orig } = resizeRef.current;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        let { x, y, w, h } = orig;
        if (edge.includes('e')) w = Math.max(MIN_W, orig.w + dx);
        if (edge.includes('w')) { const nw = Math.max(MIN_W, orig.w - dx); x = orig.x + (orig.w - nw); w = nw; }
        if (edge.includes('s')) h = Math.max(MIN_H, orig.h + dy);
        if (edge.includes('n')) { const nh = Math.max(MIN_H, orig.h - dy); y = orig.y + (orig.h - nh); h = nh; }
        setRect({ x, y, w, h });
      }
    };
    const onUp = () => {
      dragRef.current = null;
      resizeRef.current = null;
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const onTitleDown = (e: ReactMouseEvent) => {
    // 关闭按钮不触发拖动
    if ((e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, orig: { ...rect } };
    document.body.style.userSelect = 'none';
  };

  const onResizeDown = (edge: ResizeEdge) => (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { edge, startX: e.clientX, startY: e.clientY, orig: { ...rect } };
    document.body.style.userSelect = 'none';
  };

  // 8 个缩放热区:4 边各 6px,4 角各 12x12px(角优先级高,覆盖在边上)
  const edgeStyle = (s: CSSProperties): CSSProperties => ({
    position: 'absolute', userSelect: 'none', ...s,
  });

  return (
    <div className="fade" onMouseDownCapture={onFocus} style={{
      position: 'absolute',
      zIndex,
      left: rect.x, top: rect.y, width: rect.w, height: rect.h,
      display: 'flex', flexDirection: 'column',
      background: 'rgba(255,255,255,0.95)',
      borderRadius: 12, overflow: 'hidden',
      boxShadow: '0 30px 80px rgba(0,0,0,0.34), 0 0 0 1px rgba(0,0,0,0.09)',
      backdropFilter: 'blur(30px) saturate(180%)',
    }}>
      <div
        onMouseDown={onTitleDown}
        style={{
          height: 46, flex: '0 0 46px', display: 'flex', alignItems: 'center', gap: 8,
          padding: '0 14px', background: 'rgba(248,248,250,0.85)',
          borderBottom: '1px solid rgba(0,0,0,0.07)',
          cursor: 'grab', userSelect: 'none',
        }}
      >
        <button
          onClick={onClose}
          aria-label="close"
          style={{ width: 12, height: 12, borderRadius: '50%', background: '#ff5f57', padding: 0, border: 'none', cursor: 'pointer' }}
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

      {/* 4 边 */}
      <div onMouseDown={onResizeDown('n')} style={edgeStyle({ top: 0, left: 12, right: 12, height: 6, cursor: EDGE_CURSOR.n })} />
      <div onMouseDown={onResizeDown('s')} style={edgeStyle({ bottom: 0, left: 12, right: 12, height: 6, cursor: EDGE_CURSOR.s })} />
      <div onMouseDown={onResizeDown('e')} style={edgeStyle({ top: 12, bottom: 12, right: 0, width: 6, cursor: EDGE_CURSOR.e })} />
      <div onMouseDown={onResizeDown('w')} style={edgeStyle({ top: 12, bottom: 12, left: 0, width: 6, cursor: EDGE_CURSOR.w })} />
      {/* 4 角 */}
      <div onMouseDown={onResizeDown('nw')} style={edgeStyle({ top: 0, left: 0, width: 12, height: 12, cursor: EDGE_CURSOR.nw })} />
      <div onMouseDown={onResizeDown('ne')} style={edgeStyle({ top: 0, right: 0, width: 12, height: 12, cursor: EDGE_CURSOR.ne })} />
      <div onMouseDown={onResizeDown('sw')} style={edgeStyle({ bottom: 0, left: 0, width: 12, height: 12, cursor: EDGE_CURSOR.sw })} />
      <div onMouseDown={onResizeDown('se')} style={edgeStyle({ bottom: 0, right: 0, width: 12, height: 12, cursor: EDGE_CURSOR.se })} />
    </div>
  );
};
