import type { SupabaseClient } from '@supabase/supabase-js';
import type { ContainerMapping } from '@lingxi/shared';

export class ContainerMappingCache {
  private readonly map = new Map<string, ContainerMapping>();

  constructor(private readonly sb: SupabaseClient) {}

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
    const { data, error } = await this.sb.from('container_mapping').select('*');
    if (error) throw new Error(error.message);
    this.map.clear();
    (data as ContainerMapping[]).forEach((row) => this.map.set(row.user_id, row));
  }
}
