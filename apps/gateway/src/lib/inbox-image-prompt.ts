/**
 * 渠道入站图片 → 给 hermes 的 prompt 拼装（渠道无关）。
 *
 * 纯文本时原样返回; 带附件 / 有下载失败时, 把本地路径清单 + 用户原文 + 失败计数拼成一段,
 * 让 agent 用 vision / PIL 直接读路径。微信/飞书共用。
 */
import type { InboxAttachmentRef } from '@lingxi/shared';

/** bytes → 人类可读 (MB / KB / B), 用于 prompt 里标注图片大小。 */
export const formatSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};

export const buildInboxPrompt = (
  text: string,
  attachments: InboxAttachmentRef[],
  fetchErrors: string[],
): string => {
  if (attachments.length === 0 && fetchErrors.length === 0) return text;
  const lines: string[] = [];
  if (attachments.length > 0) {
    lines.push(`[图片附件] 收到 ${attachments.length} 张图片，已下载到本地：`);
    for (const a of attachments) {
      lines.push(`- ${a.cache_path} (${a.content_type}, ${formatSize(a.size)})`);
    }
    lines.push('');
  }
  lines.push(text);
  if (fetchErrors.length > 0) {
    lines.push('');
    lines.push(`⚠️ ${fetchErrors.length} 张图片下载失败`);
  }
  return lines.join('\n');
};
