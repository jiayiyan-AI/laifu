import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { UserDelegationKeyCache } from './user-delegation-key-cache.js';

export interface BlobServiceClientConfig {
  accountName: string;        // e.g. 'stlingxidev'
  blobEndpoint: string;       // e.g. 'https://stlingxidev.blob.core.windows.net'
}

export interface UdkCacheConfig extends BlobServiceClientConfig {
  udkLifetimeSeconds: number;
}

let _blobClient: BlobServiceClient | null = null;
let _udkCache: UserDelegationKeyCache | null = null;

/**
 * Returns the singleton BlobServiceClient. Constructs on first call using
 * DefaultAzureCredential (works locally via az login, in ACA via Managed Identity).
 */
export function getBlobServiceClient(cfg: BlobServiceClientConfig): BlobServiceClient {
  if (!_blobClient) {
    const credential = new DefaultAzureCredential();
    _blobClient = new BlobServiceClient(cfg.blobEndpoint, credential);
  }
  return _blobClient;
}

/**
 * Returns the singleton UserDelegationKeyCache that knows how to fetch a fresh
 * UDK from the BlobServiceClient.
 */
export function getUserDelegationKeyCache(cfg: UdkCacheConfig): UserDelegationKeyCache {
  if (!_udkCache) {
    const client = getBlobServiceClient(cfg);
    _udkCache = new UserDelegationKeyCache({
      fetcher: async () => {
        const start = new Date(Date.now() - 60 * 1000);
        const expiry = new Date(Date.now() + cfg.udkLifetimeSeconds * 1000);
        return client.getUserDelegationKey(start, expiry);
      },
      refreshWithinSeconds: 3600,
    });
  }
  return _udkCache;
}

/** Test helper: clear the singletons so each test gets fresh state. */
export function resetBlobServiceClient(): void {
  _blobClient = null;
  _udkCache = null;
}
