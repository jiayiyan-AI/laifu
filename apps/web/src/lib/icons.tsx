import type { CSSProperties } from 'react';

interface IconProps {
  size?: number;
  color?: string;
  className?: string;
  strokeWidth?: number;
}

const wrap = (path: string) => ({ size = 18, color, className = '', strokeWidth = 1.7 }: IconProps) => {
  const style: CSSProperties = color ? { color } : {};
  return (
    <svg
      className={className}
      style={{ ...style, display: 'inline-block', verticalAlign: 'middle' }}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: path }}
    />
  );
};

export const IconChat = wrap('<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/>');
export const IconUser = wrap('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>');
export const IconMessage = wrap('<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/>');
export const IconMail = wrap('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>');
export const IconCheck = wrap('<path d="M20 6 9 17l-5-5"/>');
export const IconX = wrap('<path d="M18 6 6 18"/><path d="M6 6l12 12"/>');
export const IconPlus = wrap('<path d="M12 5v14"/><path d="M5 12h14"/>');
export const IconRefresh = wrap('<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>');
export const IconSend = wrap('<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>');
export const IconPower = wrap('<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>');
export const IconGlobe = wrap('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>');
export const IconFile = wrap('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>');
export const IconSpark = wrap('<path d="M12 3v3"/><path d="M12 18v3"/><path d="M3 12h3"/><path d="M18 12h3"/><path d="M5.6 5.6 7.7 7.7"/><path d="m16.3 16.3 2.1 2.1"/><path d="M5.6 18.4 7.7 16.3"/><path d="m16.3 7.7 2.1-2.1"/>');
export const IconGrid = wrap('<rect width="7" height="7" x="3" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="14" rx="1.5"/><rect width="7" height="7" x="3" y="14" rx="1.5"/>');
export const IconChevDown = wrap('<path d="m6 9 6 6 6-6"/>');

export const IconFolder = ({ size = 16, color = 'currentColor', strokeWidth = 1.8 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);

export const IconDownload = ({ size = 16, color = 'currentColor', strokeWidth = 1.8 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

export const IconReload = ({ size = 16, color = 'currentColor', strokeWidth = 1.8 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
);

export const IconWechat = ({ size = 18, color = 'currentColor' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 4C5.1 4 2 6.6 2 9.8c0 1.8 1 3.4 2.6 4.5L4 17l2.6-1.3c.8.2 1.6.3 2.4.3" />
    <circle cx="7" cy="9" r=".6" fill={color} stroke="none" />
    <circle cx="11" cy="9" r=".6" fill={color} stroke="none" />
    <path d="M22 15.2c0-2.6-2.6-4.7-5.8-4.7s-5.8 2.1-5.8 4.7 2.6 4.7 5.8 4.7c.7 0 1.4-.1 2-.3L20.5 21l-.5-2c1.2-.9 2-2.2 2-3.8z" />
    <circle cx="14.5" cy="14.6" r=".5" fill={color} stroke="none" />
    <circle cx="17.8" cy="14.6" r=".5" fill={color} stroke="none" />
  </svg>
);

export const IconFeishu = ({ size = 18, color = 'currentColor' }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 17c3.5-1 6-3.2 8-7 1.6 2.4 3.6 3.6 6 4-3 2.6-7 4-11 4-1.2 0-2.2-.3-3-1z" />
    <path d="M5 9c2-2 4.5-3 7.5-3" />
  </svg>
);
