import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ParsedInboundEmail, EmailListItem, EmailDetail,
} from '@lingxi/shared';

export interface OutboundInsert {
  user_id: string;
  from_addr: string;
  to_addrs: string[];
  cc_addrs: string[];
  subject: string;
  message_id: string;
  in_reply_to: string | null;
  reference_ids: string[];
  body_text: string;
}

export interface EmailDao {
  findUserByLocalpart(localpart: string): Promise<string | null>;
  getAddress(userId: string): Promise<{ localpart: string; display_name: string | null } | null>;
  insertInbound(parsed: ParsedInboundEmail, userId: string): Promise<string>;
  insertOutbound(row: OutboundInsert): Promise<string>;
  list(userId: string, opts: { q?: string; limit: number }): Promise<EmailListItem[]>;
  get(userId: string, id: string): Promise<EmailDetail | null>;
}

const newId = (): string =>
  `eml_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const LIST_COLS = 'id,direction,from_addr,to_addrs,subject,has_attachments,received_at';
const DETAIL_COLS = `${LIST_COLS},cc_addrs,message_id,in_reply_to,reference_ids,body_text`;

export const makeEmailDao = (sb: SupabaseClient): EmailDao => ({
  async findUserByLocalpart(localpart) {
    const { data, error } = await sb
      .from('email_addresses').select('user_id')
      .eq('localpart', localpart.toLowerCase()).maybeSingle();
    if (error) throw new Error(`findUserByLocalpart: ${error.message}`);
    return data ? (data as { user_id: string }).user_id : null;
  },

  async getAddress(userId) {
    const { data, error } = await sb
      .from('email_addresses').select('localpart,display_name')
      .eq('user_id', userId).maybeSingle();
    if (error) throw new Error(`getAddress: ${error.message}`);
    return data ? (data as { localpart: string; display_name: string | null }) : null;
  },

  async insertInbound(parsed, userId) {
    const id = newId();
    const { error } = await sb.from('emails').insert({
      id, user_id: userId, direction: 'inbound',
      from_addr: parsed.from_addr, to_addrs: parsed.to_addrs, cc_addrs: parsed.cc_addrs,
      subject: parsed.subject, message_id: parsed.message_id,
      in_reply_to: parsed.in_reply_to, reference_ids: parsed.reference_ids,
      body_text: parsed.body_text, has_attachments: parsed.has_attachments,
    });
    if (error) throw new Error(`insertInbound: ${error.message}`);
    return id;
  },

  async insertOutbound(row) {
    const id = newId();
    const { error } = await sb.from('emails').insert({
      id, user_id: row.user_id, direction: 'outbound',
      from_addr: row.from_addr, to_addrs: row.to_addrs, cc_addrs: row.cc_addrs,
      subject: row.subject, message_id: row.message_id,
      in_reply_to: row.in_reply_to, reference_ids: row.reference_ids,
      body_text: row.body_text, has_attachments: false,
    });
    if (error) throw new Error(`insertOutbound: ${error.message}`);
    return id;
  },

  async list(userId, opts) {
    let query = sb.from('emails').select(LIST_COLS).eq('user_id', userId);
    if (opts.q) {
      // 主题或发件人模糊匹配
      query = query.or(`subject.ilike.%${opts.q}%,from_addr.ilike.%${opts.q}%`);
    }
    const { data, error } = await query
      .order('received_at', { ascending: false })
      .limit(opts.limit);
    if (error) throw new Error(`list: ${error.message}`);
    return (data ?? []) as unknown as EmailListItem[];
  },

  async get(userId, id) {
    const { data, error } = await sb
      .from('emails').select(DETAIL_COLS)
      .eq('user_id', userId).eq('id', id).maybeSingle();
    if (error) throw new Error(`get: ${error.message}`);
    return data ? (data as unknown as EmailDetail) : null;
  },
});
