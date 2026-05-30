import { useState } from 'react';
import { Wallpaper } from '../lib/Wallpaper.js';
import { Menubar } from './Menubar.js';
import { Dock, type DockAppId } from './Dock.js';

const AppPlaceholder = ({ id }: { id: DockAppId }) => (
  <div style={{ padding: 24 }}>App "{id}" — 后续 task 实现内容</div>
);

export const Desktop = () => {
  const [openApps, setOpenApps] = useState<Set<DockAppId>>(new Set());
  const openApp = (id: DockAppId) => setOpenApps((s) => new Set(s).add(id));
  const closeApp = (id: DockAppId) => setOpenApps((s) => {
    const next = new Set(s);
    next.delete(id);
    return next;
  });

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
      <Wallpaper />
      <Menubar />
      <div style={{ position: 'absolute', left: 0, right: 0, top: 26, bottom: 0, zIndex: 10 }}>
        {[...openApps].map((id, i) => (
          <div key={id} style={{ position: 'absolute', top: 40 + i * 30, left: 100 + i * 30, width: 700, height: 500, background: 'rgba(255,255,255,0.95)', borderRadius: 12, overflow: 'hidden', boxShadow: '0 30px 80px rgba(0,0,0,0.34), 0 0 0 1px rgba(0,0,0,0.09)' }}>
            <div style={{ height: 46, display: 'flex', alignItems: 'center', padding: '0 14px', background: 'rgba(248,248,250,0.85)', borderBottom: '1px solid rgba(0,0,0,0.07)' }}>
              <button onClick={() => closeApp(id)} style={{ width: 12, height: 12, borderRadius: '50%', background: '#ff5f57' }} />
              <span style={{ marginLeft: 12, fontSize: 13, fontWeight: 600, color: '#3a3a40' }}>{id}</span>
            </div>
            <AppPlaceholder id={id} />
          </div>
        ))}
      </div>
      <Dock onOpen={openApp} openApps={openApps} />
    </div>
  );
};
