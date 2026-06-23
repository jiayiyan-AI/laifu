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
import { IMHub } from '../apps/im/IMHub.js';
import { FilesApp } from '../apps/files/FilesApp.js';
import { entitlementsAtom } from '../states/entitlements.atom.js';
import { CAPABILITIES } from '../lib/capabilities.js';
import { useAssistantName } from '../states/assistant.atom.js';

type AppId = DockAppId | 'im';

const renderApp = (id: AppId, openApp: (id: AppId) => void) => {
  if (id === 'chat') return <ChatApp />;
  if (id === 'manage') return <ManageApp onOpenIM={() => openApp('im')} />;
  if (id === 'im') return <IMHub />;
  if (id === 'files') return <FilesApp />;
  return null;
};

const titles: Record<AppId, { title: string; icon: ReactNode; w: number; h: number }> = {
  chat:   { title: '灵犀助理', icon: <IconSpark size={14} />,   w: 900, h: 600 },
  manage: { title: '我的助理', icon: <IconGrid size={14} />,    w: 780, h: 580 },
  im:     { title: 'IM 绑定', icon: <IconMessage size={14} />, w: 600, h: 480 },
  files:  { title: '文件',     icon: <IconFolder size={14} />,  w: 900, h: 600 },
};

export const Desktop = () => {
  const [{ observed }] = entitlementsAtom.use();
  const assistantName = useAssistantName();
  const [ready, setReady] = useState<boolean | null>(null);
  const [openApps, setOpenApps] = useState<AppId[]>([]);
  // 置顶用 zIndex map, 不重排数组: 重排会让 React 移动 DOM 节点, 触发 .fade 入场动画重放 → 焦点闪烁。
  // 保持 openApps 插入顺序稳定(DOM 节点不动), 焦点只改被点窗口的 zIndex。
  const [zMap, setZMap] = useState<Partial<Record<AppId, number>>>({});
  const zTop = useRef(10);
  const bringToFront = (id: AppId) => {
    zTop.current += 1;
    const z = zTop.current;
    setZMap((m) => ({ ...m, [id]: z }));
  };

  const openApp = (id: AppId) => {
    setOpenApps((s) => (s.includes(id) ? s : [...s, id]));
    bringToFront(id);
  };
  const closeApp = (id: AppId) => setOpenApps((s) => s.filter((x) => x !== id));
  const focusApp = (id: AppId) => bringToFront(id);

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
          const title = id === 'chat' ? assistantName : meta.title;
          return (
            <Window key={id} title={title} icon={meta.icon} width={meta.w} height={meta.h} offsetX={i * 20} offsetY={i * 20} zIndex={zMap[id] ?? (i + 1)} onClose={() => closeApp(id)} onFocus={() => focusApp(id)}>
              {renderApp(id, openApp)}
            </Window>
          );
        })}
      </div>
      <Dock onOpen={openApp} openApps={new Set(openApps)} entitlements={observed} />
    </div>
  );
};
