// re-export @lingxi/shared 的 wire 契约（决策①：前端零重复，直接复用共享类型）。
export type {
  DeviceTokenResponse,
  RefreshTokenResponse,
  CloudWriteSasResponse,
  CloudListResponse,
  CloudFileItem,
  CloudFolderItem,
} from '@lingxi/shared';
