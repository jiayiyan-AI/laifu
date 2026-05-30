import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { Wallpaper } from '../lib/Wallpaper.js';
import { Menubar } from './Menubar.js';
import { Dock, type DockAppId } from './Dock.js';
import { Window } from './Window.js';
import { Onboarding } from '../onboarding/Onboarding.js';
import * as api from '../lib/api.js';
import { IconSpark, IconGrid, IconMessage } from '../lib/icons.js';
import { ChatApp } from '../apps/chat/ChatApp.js';

const renderApp = (id: DockAppId) => {
  if (id === 'chat') return <ChatApp />;
  return <div style={{ padding: 24 }}>App "{id}" — 后续 task 实现内容</div>;
};

const titles: Record<DockAppId, { title: string; icon: ReactNode; w: number; h: number }> = {
  chat:   { title: '灵犀助理', icon: <IconSpark size={14} />,   w: 900, h: 600 },
  manage: { title: '我的助理', icon: <IconGrid size={14} />,    w: 780, h: 580 },
  wechat: { title: '微信绑定', icon: <IconMessage size={14} />, w: 560, h: 440 },
};

export const Desktop = () => {
  const [ready, setReady] = useState<boolean | null>(null);
  const [openApps, setOpenApps] = useState<DockAppId[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const s = await api.status();
        setReady(!!s && s.status === 'ready');
      } catch {
        setReady(false);
      }
    })();
  }, []);

  const openApp = (id: DockAppId) => setOpenApps((s) => (s.includes(id) ? s : [...s, id]));
  const closeApp = (id: DockAppId) => setOpenApps((s) => s.filter((x) => x !== id));

  if (ready === null) {
    return <div className="dim" style={{ padding: 24 }}>加载中…</div>;
  }

  if (!ready) {
    return (
      <div style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
        <Wallpaper />
        <Menubar />
        <div style={{ position: 'absolute', left: 0, right: 0, top: 26, bottom: 0, zIndex: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 600, height: 480, background: 'rgba(255,255,255,0.95)', borderRadius: 12, overflow: 'hidden', boxShadow: '0 30px 80px rgba(0,0,0,0.34), 0 0 0 1px rgba(0,0,0,0.09)' }}>
            <Onboarding onReady={() => setReady(true)} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
      <Wallpaper />
      <Menubar />
      <div style={{ position: 'absolute', left: 0, right: 0, top: 26, bottom: 0, zIndex: 10 }}>
        {openApps.map((id, i) => {
          const meta = titles[id];
          return (
            <Window key={id} title={meta.title} icon={meta.icon} width={meta.w} height={meta.h} offsetX={i * 20} offsetY={i * 20} onClose={() => closeApp(id)}>
              {renderApp(id)}
            </Window>
          );
        })}
      </div>
      <Dock onOpen={openApp} openApps={new Set(openApps)} />
    </div>
  );
};
