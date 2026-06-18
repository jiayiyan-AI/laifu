import type { Db } from '@lingxi/db';
import { schema } from '@lingxi/db';
import type { ContainerMapping } from '@lingxi/shared';

export class ContainerMappingCache {
  private readonly map = new Map<string, ContainerMapping>();

  constructor(private readonly db: Db) {}

  get(userId: string): ContainerMapping | null {
    return this.map.get(userId) ?? null;
  }

  set(row: ContainerMapping): void {
    this.map.set(row.user_id, row);
  }

  delete(userId: string): void {
    this.map.delete(userId);
  }

  /** 快照所有缓存行 (sweep reconcile 用)。返回数组副本, 不暴露内部 Map。 */
  entries(): ContainerMapping[] {
    return [...this.map.values()];
  }

  async loadAll(): Promise<void> {
    const rows = await this.db.select().from(schema.containerMapping);
    this.map.clear();
    rows.forEach((row) => {
      this.map.set(row.user_id, {
        ...row,
        progress_pct: row.progress_pct ?? 0,
        created_at: row.created_at?.toISOString() ?? new Date().toISOString(),
        ready_at: row.ready_at?.toISOString() ?? null,
        policy_hash: row.policy_hash ?? null,
      } as ContainerMapping);
    });
  }
}
