import type { ReactNode } from 'react';
import { IconGlobe, IconFile, IconMessage, IconFolder, IconMail } from './icons.js';

/** 确认/退订弹窗文案。`lines` 是弹窗里逐行的小字(价格/容量/影响说明)。 */
export interface CapabilityCopy {
  title: string;
  desc: string;
  lines?: string[];
}

export interface Capability {
  /** entitlement key, 与后端 ALLOWED_FEATURES 一致 */
  id: string;
  name: string;
  icon: ReactNode;
  /** 市场卡片 / 已装备卡片副文案 */
  blurb: string;
  /** 仅展示, 0=免费, 不影响逻辑 */
  price: number;
  /** 默认基线能力 = false(不出现 ✕、不进市场) */
  removable: boolean;
  /** 是否在"市场" tab 列出 */
  inMarket: boolean;
  /** 装备后桌面/Dock 出现的 app id;无则不进桌面 */
  desktopApp?: string;
  /** removable/inMarket 能力必填 */
  enableCopy?: CapabilityCopy;
  disableCopy?: CapabilityCopy;
}

export const CAPABILITIES: Capability[] = [
  {
    id: 'web', name: '联网搜索', icon: <IconGlobe size={22} color="var(--accent)" />,
    blurb: '让助理联网搜索信息', price: 0, removable: false, inMarket: false,
  },
  {
    id: 'file', name: '文件读写', icon: <IconFile size={22} color="var(--accent)" />,
    blurb: '让助理读写工作区文件', price: 0, removable: false, inMarket: false,
  },
  {
    id: 'wechat', name: '微信收发', icon: <IconMessage size={22} color="var(--accent)" />,
    blurb: '让助理通过微信收发消息', price: 0, removable: false, inMarket: false,
  },
  {
    id: 'cloud', name: '云盘', icon: <IconFolder size={22} color="var(--accent)" />,
    blurb: '让助理把成果保存到云端，桌面会出现"文件"应用',
    price: 0, removable: true, inMarket: true, desktopApp: 'files',
    enableCopy: {
      title: '云盘',
      desc: '让助理把成果保存到云端，桌面会出现"文件"应用',
      lines: ['价格: 免费（后续可能收费）', '容量: 无限制'],
    },
    disableCopy: {
      title: '退订云盘',
      desc: '退订后：',
      lines: ['• 桌面"文件"应用会消失', '• 已发布的文件保留（不删除），重新装备后可继续访问'],
    },
  },
  {
    id: 'email', name: '邮件', icon: <IconMail size={22} color="var(--accent)" />,
    blurb: '给助理一个专属邮箱，可代收代发业务邮件（在对话里让它读信/回信）',
    price: 0, removable: true, inMarket: true,
    enableCopy: {
      title: '邮件',
      desc: '给助理一个专属邮箱地址，第三方可直接发邮件给它，你也可转发业务邮件进来。',
      lines: [
        '价格: 免费（后续可能收费）',
        '装备后系统会自动分配一个邮箱地址',
        '收到邮件不会主动通知，在对话里让助理「看看新邮件」即可',
      ],
    },
    disableCopy: {
      title: '退订邮件',
      desc: '退订后：',
      lines: ['• 助理不再能收发邮件', '• 已收到的邮件记录保留，重新装备后可继续访问'],
    },
  },
];

export const MARKET_CAPABILITIES: Capability[] = CAPABILITIES.filter((c) => c.inMarket);

export const getCapability = (id: string): Capability | undefined =>
  CAPABILITIES.find((c) => c.id === id);

/** 默认能力恒为已装备;可装备能力看 observed 是否包含。 */
export const isEquipped = (cap: Capability, observed: string[]): boolean =>
  !cap.removable || observed.includes(cap.id);
