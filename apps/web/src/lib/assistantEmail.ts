import { assistantLocalpartBase } from '@lingxi/shared';

/**
 * 激活页实时预览邮箱（无碰撞后缀，乐观）。base 复用 shared 与后端同源；
 * 域名来自后端 AuthMeResponse.email_domain。空名显示 — 占位，全丢弃显示 assistant。
 */
export const assistantEmailPreview = (name: string, domain: string): string => {
  const base = assistantLocalpartBase(name);
  const local = name.trim() ? (base || 'assistant') : '—';
  return `${local}@${domain}`;
};
