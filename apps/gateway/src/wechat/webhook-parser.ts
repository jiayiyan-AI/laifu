/**
 * 微信公众号 webhook XML → typed event。
 *
 * 微信推送 XML 结构超规律: 一层 <xml>,字段都是 <Tag><![CDATA[v]]></Tag> 或 <Tag>num</Tag>。
 * 没必要拉 XML parser 依赖,自己 20 行正则扛住所有事件类型。
 *
 * 我们只关心绑定相关的事件:
 *   - SCAN        已关注用户扫带参 QR  → 直接拿 EventKey (即 scene_str)
 *   - subscribe   关注事件,如果是扫 QR 触发的,EventKey 是 'qrscene_' + scene_str,需要 strip
 *   - unsubscribe 取关
 *   - text        普通文本消息(以后 Phase 1.5 转发到 Hermes 用)
 *   - unknown     其它一律降级,webhook 必须回 200 防微信重试
 */

export type WechatEvent =
  | { type: 'SCAN'; fromUser: string; sceneStr: string }
  | { type: 'subscribe'; fromUser: string; sceneStr?: string }
  | { type: 'unsubscribe'; fromUser: string }
  | { type: 'text'; fromUser: string; content: string }
  | { type: 'unknown' };

const SCENE_PREFIX = 'qrscene_';

// 同时兼容 CDATA 包裹和裸文本(微信数字字段如 CreateTime/MsgId 不带 CDATA)。
// CDATA 内容用懒匹配 `(.*?)` 防止跨 tag 吞内容。
const tagRe = (tag: string) => new RegExp(`<${tag}>(?:<!\\[CDATA\\[(.*?)\\]\\]>|([^<]*))<\\/${tag}>`, 's');

const getField = (xml: string, tag: string): string | undefined => {
  const m = xml.match(tagRe(tag));
  if (!m) return undefined;
  return m[1] ?? m[2];
};

export const parseWechatEvent = (xml: string): WechatEvent => {
  if (!xml.includes('<xml>')) return { type: 'unknown' };

  const fromUser = getField(xml, 'FromUserName');
  const msgType = getField(xml, 'MsgType');
  if (!fromUser || !msgType) return { type: 'unknown' };

  if (msgType === 'text') {
    const content = getField(xml, 'Content');
    if (content === undefined) return { type: 'unknown' };
    return { type: 'text', fromUser, content };
  }

  if (msgType === 'event') {
    const evt = getField(xml, 'Event');
    if (!evt) return { type: 'unknown' };

    if (evt === 'SCAN') {
      const eventKey = getField(xml, 'EventKey');
      if (!eventKey) return { type: 'unknown' };
      return { type: 'SCAN', fromUser, sceneStr: eventKey };
    }
    if (evt === 'subscribe') {
      const eventKey = getField(xml, 'EventKey');
      // subscribe 可能有/无 EventKey: 扫码关注带 qrscene_ 前缀,普通点关注没 EventKey 或 EventKey 空。
      if (eventKey && eventKey.length > 0) {
        const sceneStr = eventKey.startsWith(SCENE_PREFIX)
          ? eventKey.slice(SCENE_PREFIX.length)
          : eventKey;
        return { type: 'subscribe', fromUser, sceneStr };
      }
      return { type: 'subscribe', fromUser };
    }
    if (evt === 'unsubscribe') {
      return { type: 'unsubscribe', fromUser };
    }
  }

  return { type: 'unknown' };
};
