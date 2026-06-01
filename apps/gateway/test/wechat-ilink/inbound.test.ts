import { describe, it, expect } from 'vitest';
import { parseInbound } from '../../src/wechat-ilink/inbound.js';

const baseMsg = (overrides: Record<string, any> = {}) => ({
  message_id: 'm1',
  message_type: 1,     // 1=user, 2=bot
  message_state: 0,    // 1=generating
  from_user_id: 'wxid_friend',
  context_token: 'ctx_xyz',
  item_list: [{ type: 1, text_item: { text: '你好' } }],
  ...overrides,
});

describe('parseInbound', () => {
  it('parses a normal text message', () => {
    const r = parseInbound(baseMsg());
    expect(r).toEqual({
      message_id: 'm1',
      from_user_id: 'wxid_friend',
      context_token: 'ctx_xyz',
      text: '你好',
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

  it('returns null when no text items (only voice/image/file)', () => {
    expect(parseInbound(baseMsg({ item_list: [{ type: 3 }, { type: 4 }] }))).toBeNull();
  });

  it('concats multiple text items', () => {
    const r = parseInbound(baseMsg({
      item_list: [
        { type: 1, text_item: { text: '第一段' } },
        { type: 1, text_item: { text: '第二段' } },
      ],
    }));
    expect(r?.text).toBe('第一段第二段');
  });

  it('picks only text items when mixed with image', () => {
    const r = parseInbound(baseMsg({
      item_list: [
        { type: 1, text_item: { text: 'hello' } },
        { type: 2, image_item: { media: {} } },     // image, ignored MVP
      ],
    }));
    expect(r?.text).toBe('hello');
  });

  it('returns null when all text items are empty strings', () => {
    expect(parseInbound(baseMsg({
      item_list: [
        { type: 1, text_item: { text: '' } },
        { type: 1, text_item: {} },
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

  it('tolerates missing context_token (still parses,empty string)', () => {
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
