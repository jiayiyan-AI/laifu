/**
 * container_mapping 表 DAO — 集中所有 provisioning / purchase / recovery 的读写。
 * 消费方: provisioning/manager.ts, provisioning/local.ts, provisioning/recovery.ts, api/purchase.ts
 */
import type { Db } from '@lingxi/db';
import { schema } from '@lingxi/db';
import { eq } from 'drizzle-orm';
import type { ContainerMapping } from '@lingxi/shared';

export interface ContainerMappingDao {
  insert(row: {
    user_id: string;
    container_name: string;
    azure_files_share: string;
    status: string;
    progress_pct: number;
  }): Promise<void>;
  getByUserId(userId: string): Promise<ContainerMapping | null>;
  listByStatus(status: string): Promise<{ user_id: string; container_name: string }[]>;
  updateStep(userId: string, step: string, pct: number): Promise<void>;
  markReady(userId: string, url: string, step: string, pct: number): Promise<void>;
  markFailed(userId: string, errorMessage: string): Promise<void>;
}

const toMapping = (r: typeof schema.containerMapping.$inferSelect): ContainerMapping => ({
  user_id: r.user_id,
  container_name: r.container_name,
  container_url: r.container_url,
  status: r.status as ContainerMapping['status'],
  provisioning_step: r.provisioning_step,
  progress_pct: r.progress_pct ?? 0,
  error_message: r.error_message,
  azure_files_share: r.azure_files_share,
  created_at: r.created_at?.toISOString() ?? new Date().toISOString(),
  ready_at: r.ready_at?.toISOString() ?? null,
});

export const makeContainerMappingDao = (db: Db): ContainerMappingDao => {
  const t = schema.containerMapping;
  return {
    async insert(row) {
      await db.insert(t).values({
        user_id: row.user_id,
        container_name: row.container_name,
        azure_files_share: row.azure_files_share,
        status: row.status,
        progress_pct: row.progress_pct,
      });
    },

    async getByUserId(userId) {
      const rows = await db.select().from(t).where(eq(t.user_id, userId)).limit(1);
      return rows[0] ? toMapping(rows[0]) : null;
    },

    async listByStatus(status) {
      const rows = await db.select({
        user_id: t.user_id,
        container_name: t.container_name,
      }).from(t).where(eq(t.status, status));
      return rows;
    },

    async updateStep(userId, step, pct) {
      await db.update(t).set({ provisioning_step: step, progress_pct: pct }).where(eq(t.user_id, userId));
    },

    async markReady(userId, url, step, pct) {
      await db.update(t).set({
        status: 'ready',
        container_url: url,
        provisioning_step: step,
        progress_pct: pct,
        ready_at: new Date(),
      }).where(eq(t.user_id, userId));
    },

    async markFailed(userId, errorMessage) {
      await db.update(t).set({
        status: 'failed',
        error_message: errorMessage,
      }).where(eq(t.user_id, userId));
    },
  };
};
