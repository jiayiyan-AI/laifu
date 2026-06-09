import { useState, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Wallpaper } from '../lib/Wallpaper.js';
import { Menubar } from './Menubar.js';
import { Dock, type DockAppId } from './Dock.js';
import { Window } from './Window.js';
import { Onboarding } from '../onboarding/Onboarding.js';
import * as api from '../lib/api.js';
import { IconSpark, IconGrid, IconMessage, IconFolder } from '../lib/icons.js';
import { ChatApp } from '../apps/chat/ChatApp.js';
import { ManageApp } from '../apps/manage/ManageApp.js';
import { WechatApp } from '../apps/wechat/WechatApp.js';
import { FilesApp } from '../apps/files/FilesApp.js';
import { entitlementsAtom } from '../states/entitlements.atom.js';
import { CAPABILITIES } from '../lib/capabilities.js';

type AppId = DockAppId | 'wechat';

const renderApp = (id: AppId, openApp: (id: AppId) => void) => {
  if (id === 'chat') return <ChatApp />;
  if (id === 'manage') return <ManageApp onOpenWechat={() => openApp('wechat')} />;
  if (id === 'wechat') return <WechatApp />;
  if (id === 'files') return <FilesApp />;
  return null;
};

const titles: Record<AppId, { title: string; icon: ReactNode; w: number; h: number }> = {
  chat:   { title: '灵犀助理', icon: <IconSpark size={14} />,   w: 900, h: 600 },
  manage: { title: '我的助理', icon: <IconGrid size={14} />,    w: 780, h: 580 },
  wechat: { title: '微信绑定', icon: <IconMessage size={14} />, w: 560, h: 440 },
  files:  { title: '文件',     icon: <IconFolder size={14} />,  w: 900, h: 600 },
};

export const Desktop = () => {
  const [{ observed }] = entitlementsAtom.use();
  const [ready, setReady] = useState<boolean | null>(null);
  const [openApps, setOpenApps] = useState<AppId[]>([]);

  const openApp = (id: AppId) => setOpenApps((s) => (s.includes(id) ? s : [...s, id]));
  const closeApp = (id: AppId) => setOpenApps((s) => s.filter((x) => x !== id));

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

  // 记录上一轮 observed,任一带 desktopApp 的能力"新被装备"时自动开窗。
  const prevObservedRef = useRef<string[]>(observed);

  useEffect(() => {
    const prev = new Set(prevObservedRef.current);
    for (const cap of CAPABILITIES) {
      if (cap.desktopApp && observed.includes(cap.id) && !prev.has(cap.id)) {
        openApp(cap.desktopApp as AppId);
      }
    }
    prevObservedRef.current = observed;
  }, [observed]);

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
              {renderApp(id, openApp)}
            </Window>
          );
        })}
      </div>
      <Dock onOpen={openApp} openApps={new Set(openApps)} entitlements={observed} />
    </div>
  );
};
