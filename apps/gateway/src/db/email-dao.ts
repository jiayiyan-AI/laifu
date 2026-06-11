import type { Db } from '@lingxi/db';
import { schema } from '@lingxi/db';
import { eq, and, or, ilike, desc } from 'drizzle-orm';
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
  insertAddress(userId: string, localpart: string, displayName: string | null): Promise<void>;
  insertInbound(parsed: ParsedInboundEmail, userId: string): Promise<string>;
  insertOutbound(row: OutboundInsert): Promise<string>;
  list(userId: string, opts: { q?: string; limit: number }): Promise<EmailListItem[]>;
  get(userId: string, id: string): Promise<EmailDetail | null>;
}

const newId = (): string =>
  `eml_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export const makeEmailDao = (db: Db): EmailDao => {
  const addr = schema.emailAddresses;
  const em = schema.emails;

  return {
    async findUserByLocalpart(localpart) {
      const rows = await db.select({ user_id: addr.user_id })
        .from(addr)
        .where(eq(addr.localpart, localpart.toLowerCase()))
        .limit(1);
      return rows[0]?.user_id ?? null;
    },

    async getAddress(userId) {
      const rows = await db.select({ localpart: addr.localpart, display_name: addr.display_name })
        .from(addr)
        .where(eq(addr.user_id, userId))
        .limit(1);
      return rows[0] ?? null;
    },

    async insertAddress(userId, localpart, displayName) {
      await db.insert(addr).values({
        localpart: localpart.toLowerCase(),
        user_id: userId,
        display_name: displayName,
      });
    },

    async insertInbound(parsed, userId) {
      const id = newId();
      await db.insert(em).values({
        id,
        user_id: userId,
        direction: 'inbound',
        from_addr: parsed.from_addr,
        to_addrs: parsed.to_addrs,
        cc_addrs: parsed.cc_addrs,
        subject: parsed.subject,
        message_id: parsed.message_id,
        in_reply_to: parsed.in_reply_to,
        reference_ids: parsed.reference_ids,
        body_text: parsed.body_text,
        has_attachments: parsed.has_attachments,
      });
      return id;
    },

    async insertOutbound(row) {
      const id = newId();
      await db.insert(em).values({
        id,
        user_id: row.user_id,
        direction: 'outbound',
        from_addr: row.from_addr,
        to_addrs: row.to_addrs,
        cc_addrs: row.cc_addrs,
        subject: row.subject,
        message_id: row.message_id,
        in_reply_to: row.in_reply_to,
        reference_ids: row.reference_ids,
        body_text: row.body_text,
        has_attachments: false,
      });
      return id;
    },

    async list(userId, opts) {
      const conditions = [eq(em.user_id, userId)];
      if (opts.q) {
        conditions.push(or(
          ilike(em.subject, `%${opts.q}%`),
          ilike(em.from_addr, `%${opts.q}%`),
        )!);
      }
      const rows = await db.select({
        id: em.id,
        direction: em.direction,
        from_addr: em.from_addr,
        to_addrs: em.to_addrs,
        subject: em.subject,
        has_attachments: em.has_attachments,
        received_at: em.received_at,
      })
        .from(em)
        .where(and(...conditions))
        .orderBy(desc(em.received_at))
        .limit(opts.limit);
      return rows.map((r) => ({
        ...r,
        received_at: r.received_at.toISOString(),
      })) as unknown as EmailListItem[];
    },

    async get(userId, id) {
      const rows = await db.select({
        id: em.id,
        direction: em.direction,
        from_addr: em.from_addr,
        to_addrs: em.to_addrs,
        cc_addrs: em.cc_addrs,
        subject: em.subject,
        message_id: em.message_id,
        in_reply_to: em.in_reply_to,
        reference_ids: em.reference_ids,
        body_text: em.body_text,
        has_attachments: em.has_attachments,
        received_at: em.received_at,
      })
        .from(em)
        .where(and(eq(em.user_id, userId), eq(em.id, id)))
        .limit(1);
      if (!rows[0]) return null;
      return {
        ...rows[0],
        received_at: rows[0].received_at.toISOString(),
      } as unknown as EmailDetail;
    },
  };
};
