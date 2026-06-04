import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cloudUpload } from '../src/lib/api.js';

class FakeXHR {
  static instances: FakeXHR[] = [];
  upload = { onprogress: null as any };
  onload: any = null;
  onerror: any = null;
  status = 0;
  responseText = '';
  method = ''; url = '';
  withCredentials = false;
  constructor() { FakeXHR.instances.push(this); }
  open(m: string, u: string) { this.method = m; this.url = u; }
  setRequestHeader() {}
  send(_body: any) {}
  emitProgress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  finish(status: number, body: any) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

describe('cloudUpload', () => {
  beforeEach(() => { FakeXHR.instances = []; (globalThis as any).XMLHttpRequest = FakeXHR as any; });
  afterEach(() => { delete (globalThis as any).XMLHttpRequest; });

  it('POSTs multipart to /api/cloud/upload and resolves on 200', async () => {
    const file = new File(['a,b,c'], 'data.csv', { type: 'text/csv' });
    const p = cloudUpload(file, 'inbox/data.csv', { title: '数据' });
    const xhr = FakeXHR.instances[0]!;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/cloud/upload');
    xhr.finish(200, { ok: true, virtual_path: 'inbox/data.csv', size: 5, last_modified: 'x' });
    await expect(p).resolves.toMatchObject({ ok: true, virtual_path: 'inbox/data.csv' });
  });

  it('reports progress fractions', async () => {
    const file = new File(['x'], 'x.txt', { type: 'text/plain' });
    const seen: number[] = [];
    const p = cloudUpload(file, 'x.txt', { onProgress: (f) => seen.push(f) });
    const xhr = FakeXHR.instances[0]!;
    xhr.emitProgress(50, 100);
    xhr.emitProgress(100, 100);
    xhr.finish(200, { ok: true, virtual_path: 'x.txt', size: 1, last_modified: 'x' });
    await p;
    expect(seen).toEqual([0.5, 1]);
  });

  it('rejects on non-2xx with status', async () => {
    const file = new File(['x'], 'x.txt', { type: 'text/plain' });
    const p = cloudUpload(file, 'x.txt');
    const xhr = FakeXHR.instances[0]!;
    xhr.finish(413, { error: 'file too large (10MB limit)' });
    await expect(p).rejects.toThrow(/413|too large/);
  });
});
