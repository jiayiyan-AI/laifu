import { describe, it, expect } from 'vitest';
import { parseWechatEvent } from '../../src/wechat/webhook-parser.js';

const wrap = (inner: string) => `<xml>${inner}</xml>`;
const cdata = (tag: string, value: string) => `<${tag}><![CDATA[${value}]]></${tag}>`;
const raw = (tag: string, value: string) => `<${tag}>${value}</${tag}>`;

describe('parseWechatEvent', () => {
  it('parses SCAN event (已关注用户扫带参 QR), strips no prefix', () => {
    const xml = wrap(
      cdata('ToUserName', 'gh_xxx')
      + cdata('FromUserName', 'openid_user_a')
      + raw('CreateTime', '1700000000')
      + cdata('MsgType', 'event')
      + cdata('Event', 'SCAN')
      + cdata('EventKey', 'bind_abc123')
      + cdata('Ticket', 'gQ...'),
    );

    const evt = parseWechatEvent(xml);

    expect(evt).toEqual({
      type: 'SCAN',
      fromUser: 'openid_user_a',
      sceneStr: 'bind_abc123',
    });
  });

  it('parses subscribe event with qrscene_ prefix, strips it', () => {
    const xml = wrap(
      cdata('ToUserName', 'gh_xxx')
      + cdata('FromUserName', 'openid_user_b')
      + cdata('MsgType', 'event')
      + cdata('Event', 'subscribe')
      + cdata('EventKey', 'qrscene_bind_def456')
      + cdata('Ticket', 'gQ...'),
    );

    const evt = parseWechatEvent(xml);

    expect(evt).toEqual({
      type: 'subscribe',
      fromUser: 'openid_user_b',
      sceneStr: 'bind_def456',
    });
  });

  it('parses subscribe without EventKey (普通关注,非扫码)', () => {
    const xml = wrap(
      cdata('FromUserName', 'openid_x')
      + cdata('MsgType', 'event')
      + cdata('Event', 'subscribe'),
    );

    const evt = parseWechatEvent(xml);

    expect(evt).toEqual({
      type: 'subscribe',
      fromUser: 'openid_x',
      // 没扫码就没 sceneStr
    });
  });

  it('parses unsubscribe event', () => {
    const xml = wrap(
      cdata('FromUserName', 'openid_x')
      + cdata('MsgType', 'event')
      + cdata('Event', 'unsubscribe'),
    );

    expect(parseWechatEvent(xml)).toEqual({ type: 'unsubscribe', fromUser: 'openid_x' });
  });

  it('parses text message', () => {
    const xml = wrap(
      cdata('FromUserName', 'openid_y')
      + cdata('MsgType', 'text')
      + cdata('Content', '你好')
      + raw('MsgId', '12345678'),
    );

    expect(parseWechatEvent(xml)).toEqual({
      type: 'text',
      fromUser: 'openid_y',
      content: '你好',
    });
  });

  it('returns unknown for unrecognized MsgType', () => {
    const xml = wrap(cdata('FromUserName', 'x') + cdata('MsgType', 'image'));
    const evt = parseWechatEvent(xml);
    expect(evt.type).toBe('unknown');
  });

  it('returns unknown on malformed XML (no <xml>)', () => {
    const evt = parseWechatEvent('garbage');
    expect(evt.type).toBe('unknown');
  });

  it('handles CDATA with brackets in content', () => {
    const xml = wrap(cdata('FromUserName', 'x') + cdata('MsgType', 'text') + cdata('Content', 'hi [test] there'));
    const evt = parseWechatEvent(xml);
    expect(evt.type).toBe('text');
    if (evt.type === 'text') expect(evt.content).toBe('hi [test] there');
  });
});
