import { randomBytes } from 'node:crypto';

export interface StreamEntry {
  containerUrl: string;
  innerStreamId: string;
}

interface StoredEntry extends StreamEntry {
  expiresAt: number;
}

export interface StreamRegistryOpts {
  ttlMs?: number;
}

export class StreamRegistry {
  private readonly map = new Map<string, StoredEntry>();
  private readonly ttlMs: number;

  constructor(opts: StreamRegistryOpts = {}) {
    this.ttlMs = opts.ttlMs ?? 60_000;
  }

  register(entry: StreamEntry): string {
    const id = `stm_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
    this.map.set(id, { ...entry, expiresAt: Date.now() + this.ttlMs });
    return id;
  }

  resolve(outerId: string): StreamEntry | null {
    const e = this.map.get(outerId);
    if (!e) return null;
    if (e.expiresAt < Date.now()) {
      this.map.delete(outerId);
      return null;
    }
    return { containerUrl: e.containerUrl, innerStreamId: e.innerStreamId };
  }

  release(outerId: string): void {
    this.map.delete(outerId);
  }
}
