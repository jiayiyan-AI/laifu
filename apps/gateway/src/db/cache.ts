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

  async loadAll(): Promise<void> {
    const rows = await this.db.select().from(schema.containerMapping);
    this.map.clear();
    rows.forEach((row) => {
      this.map.set(row.user_id, {
        ...row,
        progress_pct: row.progress_pct ?? 0,
        created_at: row.created_at?.toISOString() ?? new Date().toISOString(),
        ready_at: row.ready_at?.toISOString() ?? null,
      } as ContainerMapping);
    });
  }
}
