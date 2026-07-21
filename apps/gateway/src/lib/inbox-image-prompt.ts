/**
 * 渠道入站附件 → 给 Hermes 的 prompt 拼装（渠道无关）。
 *
 * 纯文本时原样返回；带附件 / 有下载失败时，列出容器内稳定路径与元数据，让 agent 按文件类型
 * 读取、解析或交给对应工具处理。微信/飞书共用。
 */
import type { InboxAttachmentRef } from '@lingxi/shared';

/** bytes → 人类可读（MB / KB / B），用于 prompt 里标注附件大小。 */
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
  const images = attachments.filter((attachment) => attachment.kind === 'image');
  const files = attachments.filter((attachment) => attachment.kind === 'file');
  if (images.length > 0) {
    lines.push(`[图片附件] 收到 ${images.length} 张图片，已下载到本地：`);
    for (const image of images) {
      lines.push(`- ${image.cache_path} (${image.content_type}, ${formatSize(image.size)})`);
    }
    lines.push('');
  }
  if (files.length > 0) {
    lines.push(`[文件附件] 收到 ${files.length} 个文件，已下载到本地：`);
    for (const file of files) {
      lines.push(`- ${file.cache_path}（原文件名：${file.filename}；${file.content_type}, ${formatSize(file.size)}）`);
    }
    lines.push('');
  }
  lines.push(text);
  if (fetchErrors.length > 0) {
    lines.push('');
    lines.push(`⚠️ ${fetchErrors.length} 个附件下载失败`);
  }
  return lines.join('\n');
};
