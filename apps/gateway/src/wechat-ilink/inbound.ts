/**
 * iLink raw msg → typed inbound 解析。
 *
 * MVP 只处理 text;其他类型(image=2, voice=3, file=4, video=5)一律返 null 跳过。
 * 后续要支持时往这里加分支即可。
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

export interface WechatInbound {
  message_id: string;        // iLink 给的稳定 id,用于去重 (重启重放场景)
  from_user_id: string;      // 发送者 wxid (消息对方)
  context_token: string;     // 回复时必须带回去 iLink
  text: string;              // 所有 text_item 的 text 串联
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object';

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

  // 只取 text 类型,串联所有 text_item.text。MVP 不支持 image/voice/file/video
  const texts: string[] = [];
  for (const item of items) {
    if (!isObject(item)) continue;
    if (item.type !== ITEM_TYPE_TEXT) continue;
    const textItem = isObject(item.text_item) ? item.text_item : {};
    if (typeof textItem.text === 'string' && textItem.text.length > 0) {
      texts.push(textItem.text);
    }
  }
  if (texts.length === 0) return null;        // 全是不支持类型 / 全空 → 跳过

  return {
    message_id,
    from_user_id,
    context_token,
    text: texts.join(''),
  };
};
