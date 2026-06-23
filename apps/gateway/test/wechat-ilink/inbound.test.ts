import { describe, it, expect } from 'vitest';
import { parseInbound } from '../../src/wechat-ilink/inbound.js';

const baseMsg = (overrides: Record<string, unknown> = {}) => ({
  message_id: 'm1',
  message_type: 1,     // 1=user, 2=bot
  message_state: 0,    // 1=generating
  from_user_id: 'wxid_friend',
  context_token: 'ctx_xyz',
  item_list: [{ type: 1, text_item: { text: '你好' } }],
  ...overrides,
});

const imageItem = (over: Record<string, unknown> = {}) => ({
  type: 2,
  image_item: {
    aeskey: '87e0b2320ddbb8dee3804ec8b48203e1',   // 32 hex chars = 16B
    media: { full_url: 'https://cdn.example/c2c/download?encrypted_query_param=blob&taskid=t1' },
    ...over,
  },
});

describe('parseInbound', () => {
  it('parses a normal text message into a text part', () => {
    const r = parseInbound(baseMsg());
    expect(r).toEqual({
      message_id: 'm1',
      from_user_id: 'wxid_friend',
      context_token: 'ctx_xyz',
      parts: [{ kind: 'text', text: '你好' }],
      unsupported_hints: [],
    });
  });

  it('returns null for bot own messages (message_type=2)', () => {
    expect(parseInbound(baseMsg({ message_type: 2 }))).toBeNull();
  });

  it('returns null for generating state (message_state=1, partial stream)', () => {
    expect(parseInbound(baseMsg({ message_state: 1 }))).toBeNull();
  });

  it('returns null when item_list is missing or empty', () => {
    expect(parseInbound(baseMsg({ item_list: undefined }))).toBeNull();
    expect(parseInbound(baseMsg({ item_list: [] }))).toBeNull();
  });

  it('parses an image item into an image part', () => {
    const r = parseInbound(baseMsg({
      item_list: [{
        type: 2,
        image_item: {
          aeskey: '87e0b2320ddbb8dee3804ec8b48203e1',
          media: {
            full_url: 'https://cdn.example/c2c/download?encrypted_query_param=blob&taskid=t1',
            content_type: 'image/png',
          },
          hd_size: 12345,
        },
      }],
    }));
    expect(r?.parts).toEqual([
      {
        kind: 'image',
        aes_key_hex: '87e0b2320ddbb8dee3804ec8b48203e1',
        download_url: 'https://cdn.example/c2c/download?encrypted_query_param=blob&taskid=t1',
        content_type_hint: 'image/png',
        size_hint: 12345,
      },
    ]);
    expect(r?.unsupported_hints).toEqual([]);
  });

  it('skips an image item missing aeskey or full_url', () => {
    // 缺 full_url → 该 image 跳过, 只剩 text part
    const r = parseInbound(baseMsg({
      item_list: [
        { type: 1, text_item: { text: 'hi' } },
        { type: 2, image_item: { aeskey: '87e0b2320ddbb8dee3804ec8b48203e1', media: {} } },
      ],
    }));
    expect(r?.parts).toEqual([{ kind: 'text', text: 'hi' }]);
  });

  it('keeps both text and image parts in a mixed message', () => {
    const r = parseInbound(baseMsg({
      item_list: [
        { type: 1, text_item: { text: 'hello' } },
        imageItem(),
      ],
    }));
    expect(r?.parts.map((p) => p.kind)).toEqual(['text', 'image']);
  });

  it('concats multiple text items into separate parts', () => {
    const r = parseInbound(baseMsg({
      item_list: [
        { type: 1, text_item: { text: '第一段' } },
        { type: 1, text_item: { text: '第二段' } },
      ],
    }));
    expect(r?.parts).toEqual([
      { kind: 'text', text: '第一段' },
      { kind: 'text', text: '第二段' },
    ]);
  });

  it('records unsupported hints for voice/file/video and returns non-null', () => {
    const r = parseInbound(baseMsg({ item_list: [{ type: 3 }, { type: 5 }] }));
    expect(r?.parts).toEqual([]);
    expect(r?.unsupported_hints).toEqual([
      '语音消息暂不支持，请用文字描述。',
      '视频消息暂不支持，目前仅支持图片。',
    ]);
  });

  it('dedupes repeated unsupported hints', () => {
    const r = parseInbound(baseMsg({ item_list: [{ type: 3 }, { type: 3 }] }));
    expect(r?.unsupported_hints).toEqual(['语音消息暂不支持，请用文字描述。']);
  });

  it('returns null when all items yield nothing actionable', () => {
    // empty text items + an unparseable image (no media) → no parts, no hints
    expect(parseInbound(baseMsg({
      item_list: [
        { type: 1, text_item: { text: '' } },
        { type: 1, text_item: {} },
        { type: 2, image_item: {} },
      ],
    }))).toBeNull();
  });

  it('returns null when message_id is missing', () => {
    expect(parseInbound(baseMsg({ message_id: undefined }))).toBeNull();
    expect(parseInbound(baseMsg({ message_id: '' }))).toBeNull();
  });

  it('returns null when from_user_id is missing', () => {
    expect(parseInbound(baseMsg({ from_user_id: '' }))).toBeNull();
  });

  it('tolerates missing context_token (still parses, empty string)', () => {
    const r = parseInbound(baseMsg({ context_token: undefined }));
    expect(r?.context_token).toBe('');
  });

  it('tolerates non-object input (null/undefined/garbage)', () => {
    expect(parseInbound(null)).toBeNull();
    expect(parseInbound(undefined)).toBeNull();
    expect(parseInbound('not a msg')).toBeNull();
    expect(parseInbound(42)).toBeNull();
  });
});
