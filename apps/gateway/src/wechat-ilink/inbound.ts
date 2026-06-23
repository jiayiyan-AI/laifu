/**
 * iLink raw msg → typed inbound 解析。
 *
 * P1 支持 text + image;其余类型 (voice=3, file=4, video=5) 不解析,但会在
 * unsupported_hints 里留一句提示, 让 inbound-handler 能 sendText 告知用户一次。
 *
 * 过滤逻辑跟 mitsein providers/weixin/inbound/__init__.py 对齐:
 *   - message_type=2 (bot 自己发的) → null (避免回声循环)
 *   - message_state=1 (generating, 部分流式片段) → null
 *
 * 缺关键字段 (message_id/from_user_id) 也 null,这种 msg 没法去重/回复。
 */

const MSG_TYPE_BOT = 2;
const MSG_STATE_GENERATING = 1;

const ITEM_TYPE_TEXT = 1;
const ITEM_TYPE_IMAGE = 2;
const ITEM_TYPE_VOICE = 3;
const ITEM_TYPE_FILE = 4;
const ITEM_TYPE_VIDEO = 5;

// 不支持类型 → 给用户的一句提示 (按 item.type)
const UNSUPPORTED_HINT: Record<number, string> = {
  [ITEM_TYPE_VOICE]: '语音消息暂不支持，请用文字描述。',
  [ITEM_TYPE_FILE]: '文件消息暂不支持，目前仅支持图片。',
  [ITEM_TYPE_VIDEO]: '视频消息暂不支持，目前仅支持图片。',
};

export type InboundPart =
  | { kind: 'text'; text: string }
  | {
      kind: 'image';
      aes_key_hex: string;          // image_item.aeskey — 16B key 的 hex 文本 (fetcher 走 hex 解)
      download_url: string;         // image_item.media.full_url — 完整 CDN 下载 URL (含 encrypted_query_param + taskid)
      content_type_hint?: string;   // iLink 给的图片格式提示, 没有则 fetcher fallback image/jpeg
      size_hint?: number;           // image_item.hd_size, 用于下载前预判超限
    };

export interface WechatInbound {
  message_id: string;          // iLink 给的稳定 id,用于去重 (重启重放场景)
  from_user_id: string;        // 发送者 wxid (消息对方)
  context_token: string;       // 回复时必须带回去 iLink
  parts: InboundPart[];        // text + image 的有序集合
  unsupported_hints: string[]; // 去重后的 unsupported 类型提示
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object';

const asString = (v: unknown): string =>
  typeof v === 'string' ? v : '';

const asNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v
  : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v)
  : undefined;

const parseImagePart = (item: Record<string, unknown>): InboundPart | null => {
  const imageItem = isObject(item.image_item) ? item.image_item : null;
  if (!imageItem) return null;
  const media = isObject(imageItem.media) ? imageItem.media : null;

  // 真机抓包 (2026-06-18 dev): key 在 image_item.aeskey (16B 的 hex 文本); 下载用 media.full_url
  // (完整 URL, 自带 encrypted_query_param + taskid)。
  //   ⚠ media.aes_key 是同一 key 的 base64(hex文本) 双重编码 (解出 32B), 不可用;
  //   ⚠ media.encrypt_query_param 只是裸 blob, 单独拼 URL 缺 taskid/路径拉不到。
  const aes_key_hex = asString(imageItem.aeskey);
  const download_url = media ? asString(media.full_url) : '';
  // 缺 key 或下载 URL 无法解密/下载 → 跳过该 item (不让整条消息 null)
  if (!aes_key_hex || !download_url) return null;

  // content_type / size 是 best-effort hint
  const content_type_hint = (media && (asString(media.content_type) || asString(media.mime_type))) || undefined;
  const size_hint = asNumber(imageItem.hd_size) ?? asNumber(imageItem.mid_size);

  return { kind: 'image', aes_key_hex, download_url, content_type_hint, size_hint };
};

export const parseInbound = (raw: unknown): WechatInbound | null => {
  if (!isObject(raw)) return null;

  // 过滤掉 bot 自己发的和生成中的
  if (raw.message_type === MSG_TYPE_BOT) return null;
  if (raw.message_state === MSG_STATE_GENERATING) return null;

  const message_id = typeof raw.message_id === 'string' ? raw.message_id
    : typeof raw.message_id === 'number' ? String(raw.message_id)
    : '';
  if (!message_id) return null;

  const from_user_id = typeof raw.from_user_id === 'string' ? raw.from_user_id : '';
  if (!from_user_id) return null;

  const context_token = typeof raw.context_token === 'string' ? raw.context_token : '';

  const items = Array.isArray(raw.item_list) ? raw.item_list : [];
  if (items.length === 0) return null;

  const parts: InboundPart[] = [];
  const unsupported = new Set<string>();

  for (const item of items) {
    if (!isObject(item)) continue;
    switch (item.type) {
      case ITEM_TYPE_TEXT: {
        const textItem = isObject(item.text_item) ? item.text_item : {};
        const text = asString(textItem.text);
        if (text.length > 0) parts.push({ kind: 'text', text });
        break;
      }
      case ITEM_TYPE_IMAGE: {
        const img = parseImagePart(item);
        if (img) parts.push(img);
        break;
      }
      case ITEM_TYPE_VOICE:
      case ITEM_TYPE_FILE:
      case ITEM_TYPE_VIDEO: {
        const hint = UNSUPPORTED_HINT[item.type as number];
        if (hint) unsupported.add(hint);
        break;
      }
      default:
        break;
    }
  }

  // 没有任何可处理的 part 且没有 unsupported 提示 → 整条跳过
  if (parts.length === 0 && unsupported.size === 0) return null;

  return {
    message_id,
    from_user_id,
    context_token,
    parts,
    unsupported_hints: [...unsupported],
  };
};
