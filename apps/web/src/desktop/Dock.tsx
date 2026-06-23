import type { ReactNode } from 'react';
import { IconSpark, IconGrid, IconFolder } from '../lib/icons.js';
import { CAPABILITIES } from '../lib/capabilities.js';
import { useAssistantName, DEFAULT_ASSISTANT_NAME } from '../states/assistant.atom.js';

export type DockAppId = 'chat' | 'manage' | 'files';

interface AppDef { id: DockAppId; name: string; icon: ReactNode; c1: string; c2: string }

const baseApps: AppDef[] = [
  { id: 'chat',   name: DEFAULT_ASSISTANT_NAME, icon: <IconSpark size={24} />, c1: '#8b5cf6', c2: '#6d28d9' },
  { id: 'manage', name: '我的助理', icon: <IconGrid size={24} />,  c1: '#3b82f6', c2: '#1d4ed8' },
];

/** 桌面 app 的视觉(颜色/Dock 尺寸图标),按 desktopApp id 索引。catalog 决定"是否出现", 这里决定"长什么样"。 */
const dockVisuals: Record<string, { name: string; icon: ReactNode; c1: string; c2: string }> = {
  files: { name: '文件', icon: <IconFolder size={24} />, c1: '#22c55e', c2: '#15803d' },
};

interface DockProps {
  onOpen: (id: DockAppId) => void;
  openApps: ReadonlySet<string>;
  entitlements: string[];
}

export const Dock = ({ onOpen, openApps, entitlements }: DockProps) => {
  const assistantName = useAssistantName();
  const conditional: AppDef[] = CAPABILITIES
    .filter((c) => c.desktopApp && entitlements.includes(c.id) && dockVisuals[c.desktopApp])
    .map((c) => ({ id: c.desktopApp as DockAppId, ...dockVisuals[c.desktopApp!]! }));

  const apps: AppDef[] = [...baseApps, ...conditional];

  return (
    <div style={{
      position: 'absolute', bottom: 9, left: '50%', transform: 'translateX(-50%)',
      display: 'flex', alignItems: 'flex-end', gap: 11, padding: '8px 11px',
      borderRadius: 22, zIndex: 1000,
      background: 'rgba(255,255,255,0.32)',
      backdropFilter: 'blur(26px) saturate(180%)',
      border: '1px solid rgba(255,255,255,0.5)',
      boxShadow: '0 14px 44px rgba(0,0,0,0.3)',
    }}>
      {apps.map((a) => {
        const label = a.id === 'chat' ? assistantName : a.name;
        return (
          <button key={a.id} title={label} onClick={() => onOpen(a.id)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{
              width: 52, height: 52, borderRadius: 14, display: 'flex',
              alignItems: 'center', justifyContent: 'center', color: '#fff',
              background: `linear-gradient(160deg, ${a.c1}, ${a.c2})`,
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.5), 0 7px 16px rgba(0,0,0,0.22)',
              transition: 'transform 0.18s cubic-bezier(0.25,1.4,0.5,1)',
            }}>{a.icon}</div>
            <span style={{ width: 4, height: 4, borderRadius: '50%', background: 'rgba(0,0,0,0.5)', marginTop: 4, opacity: openApps.has(a.id) ? 1 : 0 }} />
          </button>
        );
      })}
    </div>
  );
};
