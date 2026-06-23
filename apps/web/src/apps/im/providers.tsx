import type { ReactNode } from 'react';
import { IconWechat, IconFeishu } from '../../lib/icons.js';

export type IMProviderId = 'wechat' | 'feishu';
export type IMProviderStatus = 'available' | 'coming_soon';

export interface IMProvider {
  id: IMProviderId;
  name: string;
  brand: string;           // 主题色 hex
  brandWeak: string;       // 浅色容器底
  status: IMProviderStatus;
  icon: ReactNode;
  unboundDesc: string;
  bindTitlePrefix: string; // "用微信扫一扫绑定" — 渲染时拼助理名
  steps: [string, string, string];
}

export const IM_PROVIDERS: IMProvider[] = [
  {
    id: 'wechat', name: '微信', brand: '#07c160', brandWeak: '#07c1601f',
    status: 'available', icon: <IconWechat size={22} color="#07c160" />,
    unboundDesc: '绑定后在微信里直接给助理派活',
    bindTitlePrefix: '用微信扫一扫绑定',
    steps: ['打开微信 → 扫一扫', '扫描左侧二维码', '在微信里点确认授权'],
  },
  {
    id: 'feishu', name: '飞书', brand: '#3370ff', brandWeak: '#3370ff1f',
    status: 'coming_soon', icon: <IconFeishu size={22} color="#3370ff" />,
    unboundDesc: '绑定后在飞书里直接给助理派活',
    bindTitlePrefix: '用飞书扫一扫绑定',
    steps: ['打开飞书 → 扫一扫', '扫描二维码', '在飞书里点确认授权'],
  },
];
