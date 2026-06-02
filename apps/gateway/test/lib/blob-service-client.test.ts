import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetBlobServiceClient, getBlobServiceClient, getUserDelegationKeyCache } from '../../src/lib/blob-service-client.js';

describe('blob-service-client factory', () => {
  beforeEach(() => {
    resetBlobServiceClient();
  });

  it('returns the same BlobServiceClient instance on repeated calls (singleton)', () => {
    const a = getBlobServiceClient({ accountName: 'fakeacct', blobEndpoint: 'https://fakeacct.blob.core.windows.net' });
    const b = getBlobServiceClient({ accountName: 'fakeacct', blobEndpoint: 'https://fakeacct.blob.core.windows.net' });
    expect(a).toBe(b);
  });

  it('returns the same UserDelegationKeyCache instance on repeated calls', () => {
    const a = getUserDelegationKeyCache({ accountName: 'fakeacct', blobEndpoint: 'https://fakeacct.blob.core.windows.net', udkLifetimeSeconds: 7 * 24 * 3600 });
    const b = getUserDelegationKeyCache({ accountName: 'fakeacct', blobEndpoint: 'https://fakeacct.blob.core.windows.net', udkLifetimeSeconds: 7 * 24 * 3600 });
    expect(a).toBe(b);
  });

  it('resetBlobServiceClient clears the singleton so a new instance can be made', () => {
    const a = getBlobServiceClient({ accountName: 'fakeacct', blobEndpoint: 'https://fakeacct.blob.core.windows.net' });
    resetBlobServiceClient();
    const b = getBlobServiceClient({ accountName: 'fakeacct', blobEndpoint: 'https://fakeacct.blob.core.windows.net' });
    expect(a).not.toBe(b);
  });
});
