//! SAS 刷新 shim —— Rust 重写 `docker/hermes/skills/cloud/cloud_file/sas_cache.py`。
//!
//! 语义严格对齐 Python 版：
//!   - `get()`：缓存新鲜（`expires_at - now >= 60s`）则复用，否则 fetch 并写缓存。
//!   - `force_refresh()`：无条件 fetch（403 后强制刷新用）。
//!   - 401 → 上抛 `GatewayError::Unauthorized`（Python 版的 `AuthError`），驱动重登。
//!   - 缓存落地 JSON 文件（对齐 `~/.hermes/_cloud_sas.json` 语义），进程重启可复用未过期 SAS。
//!
//! 与 Python 版差异（有意）：JWT 不再是构造期固定值——设备 JWT 会被续期守护滚动更新，
//! 故 `fetch` 时从注入的 `jwt_provider` 闭包取当前 JWT，避免持有过期 JWT。

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};

use crate::contracts::CloudWriteSas;
use crate::gateway::{GatewayClient, GatewayError};

/// 过期前多少秒即视为需要刷新（对齐 Python `_REFRESH_MARGIN_SECONDS`）。
const REFRESH_MARGIN_SECONDS: i64 = 60;

#[derive(Debug, thiserror::Error)]
pub enum SasError {
    #[error(transparent)]
    Gateway(#[from] GatewayError),
    #[error("cache io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("cache decode error: {0}")]
    Decode(#[from] serde_json::Error),
}

/// 规则 rs-result-type：错误类型作带默认值的泛型参数暴露。
pub type Result<T, E = SasError> = std::result::Result<T, E>;

/// 取当前设备 JWT 的回调。续期守护更新 keychain 后，这里总能拿到最新值。
pub type JwtProvider = Box<dyn Fn() -> String + Send + Sync>;

/// SAS 缓存 + 刷新协调器。
pub struct SasCache {
    gateway: GatewayClient,
    jwt_provider: JwtProvider,
    cache_path: PathBuf,
    /// 内存态当前 SAS，避免每次 `get` 读盘。
    current: Option<CloudWriteSas>,
}

impl SasCache {
    pub fn new(
        gateway: GatewayClient,
        jwt_provider: JwtProvider,
        cache_path: impl AsRef<Path>,
    ) -> Self {
        Self {
            gateway,
            jwt_provider,
            cache_path: cache_path.as_ref().to_path_buf(),
            current: None,
        }
    }

    /// 返回一把新鲜（剩余 > 60s）的 SAS：内存/磁盘缓存够新则复用，否则刷新。
    /// 对齐 Python `SasCache.get()`。
    pub async fn get(&mut self) -> Result<CloudWriteSas> {
        if let Some(sas) = self.current.as_ref() {
            if is_fresh(sas) {
                return Ok(sas.clone());
            }
        } else if let Some(sas) = self.read_cache_file() {
            if is_fresh(&sas) {
                self.current = Some(sas.clone());
                return Ok(sas);
            }
        }
        self.fetch_and_store().await
    }

    /// 无条件刷新（403 后调用）。对齐 Python `force_refresh()`。
    pub async fn force_refresh(&mut self) -> Result<CloudWriteSas> {
        self.fetch_and_store().await
    }

    /// 当前内存态 SAS（不触发刷新）；主要给测试与只读探查。
    pub fn peek(&self) -> Option<&CloudWriteSas> {
        self.current.as_ref()
    }

    async fn fetch_and_store(&mut self) -> Result<CloudWriteSas> {
        let jwt = (self.jwt_provider)();
        let sas = self.gateway.cloud_sas(&jwt).await?; // 401 → GatewayError::Unauthorized 上抛
        self.write_cache_file(&sas)?;
        self.current = Some(sas.clone());
        Ok(sas)
    }

    fn read_cache_file(&self) -> Option<CloudWriteSas> {
        // 对齐 Python：文件不存在/坏 JSON → 视作无缓存，返回 None（不报错）。
        let bytes = std::fs::read(&self.cache_path).ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    fn write_cache_file(&self, sas: &CloudWriteSas) -> Result<()> {
        if let Some(parent) = self.cache_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_vec(sas)?;
        std::fs::write(&self.cache_path, json)?;
        Ok(())
    }
}

/// `expires_at - now >= 60s` 视为新鲜。解析失败保守判为不新鲜（触发刷新）。
/// 对齐 Python `_is_fresh`（支持 `Z` 与 `+00:00` 后缀，`fromisoformat` 等价）。
fn is_fresh(sas: &CloudWriteSas) -> bool {
    match DateTime::parse_from_rfc3339(&sas.expires_at) {
        Ok(expires_at) => {
            let remaining = expires_at.with_timezone(&Utc) - Utc::now();
            remaining.num_seconds() >= REFRESH_MARGIN_SECONDS
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sas_expiring_in(secs: i64) -> CloudWriteSas {
        let expires = Utc::now() + chrono::Duration::seconds(secs);
        CloudWriteSas {
            blob_endpoint: "https://a.blob.core.windows.net".into(),
            container: "laifu-cloud".into(),
            prefix: "u/".into(),
            sas_token: "sig=x".into(),
            expires_at: expires.to_rfc3339(),
        }
    }

    #[test]
    fn fresh_when_far_from_expiry() {
        assert!(is_fresh(&sas_expiring_in(900)));
    }

    #[test]
    fn stale_within_margin() {
        assert!(!is_fresh(&sas_expiring_in(30)));
    }

    #[test]
    fn stale_when_already_expired() {
        assert!(!is_fresh(&sas_expiring_in(-10)));
    }

    #[test]
    fn stale_on_unparseable_expiry() {
        let mut sas = sas_expiring_in(900);
        sas.expires_at = "not-a-date".into();
        assert!(!is_fresh(&sas));
    }

    #[tokio::test]
    async fn get_fetches_when_no_cache_then_reuses_from_memory() {
        let mut server = mockito::Server::new_async().await;
        let fresh = sas_expiring_in(900);
        let m = server
            .mock("GET", "/api/cloud/sas")
            .with_status(200)
            .with_body(serde_json::to_string(&fresh).unwrap())
            .expect(1) // 只应打一次：第二次 get 命中内存缓存
            .create_async()
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let cache_path = tmp.path().join("_cloud_sas.json");
        let gateway = GatewayClient::new(server.url());
        let mut cache = SasCache::new(gateway, Box::new(|| "dev.jwt".into()), &cache_path);

        let first = cache.get().await.unwrap();
        assert_eq!(first.container, "laifu-cloud");
        // 缓存文件已落地
        assert!(cache_path.exists());
        // 第二次命中内存，不再打 gateway
        let second = cache.get().await.unwrap();
        assert_eq!(second.expires_at, first.expires_at);
        m.assert_async().await;
    }

    #[tokio::test]
    async fn get_reuses_fresh_disk_cache_without_fetch() {
        let mut server = mockito::Server::new_async().await;
        // 不应打 gateway：磁盘缓存新鲜。
        let m = server
            .mock("GET", "/api/cloud/sas")
            .expect(0)
            .create_async()
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let cache_path = tmp.path().join("_cloud_sas.json");
        std::fs::write(
            &cache_path,
            serde_json::to_vec(&sas_expiring_in(900)).unwrap(),
        )
        .unwrap();

        let gateway = GatewayClient::new(server.url());
        let mut cache = SasCache::new(gateway, Box::new(|| "dev.jwt".into()), &cache_path);
        let sas = cache.get().await.unwrap();
        assert_eq!(sas.container, "laifu-cloud");
        m.assert_async().await;
    }

    #[tokio::test]
    async fn get_refreshes_when_disk_cache_stale() {
        let mut server = mockito::Server::new_async().await;
        let fresh = sas_expiring_in(900);
        let m = server
            .mock("GET", "/api/cloud/sas")
            .with_status(200)
            .with_body(serde_json::to_string(&fresh).unwrap())
            .expect(1)
            .create_async()
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let cache_path = tmp.path().join("_cloud_sas.json");
        // 写一个已过期的缓存
        std::fs::write(
            &cache_path,
            serde_json::to_vec(&sas_expiring_in(10)).unwrap(),
        )
        .unwrap();

        let gateway = GatewayClient::new(server.url());
        let mut cache = SasCache::new(gateway, Box::new(|| "dev.jwt".into()), &cache_path);
        let sas = cache.get().await.unwrap();
        // 拿到的是刷新后的新鲜 SAS
        assert!(is_fresh(&sas));
        m.assert_async().await;
    }

    #[tokio::test]
    async fn force_refresh_always_fetches() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/cloud/sas")
            .with_status(200)
            .with_body(serde_json::to_string(&sas_expiring_in(900)).unwrap())
            .expect(2) // force_refresh 两次都打
            .create_async()
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let gateway = GatewayClient::new(server.url());
        let mut cache = SasCache::new(
            gateway,
            Box::new(|| "dev.jwt".into()),
            tmp.path().join("s.json"),
        );
        cache.force_refresh().await.unwrap();
        cache.force_refresh().await.unwrap();
        m.assert_async().await;
    }

    #[tokio::test]
    async fn unauthorized_propagates() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/api/cloud/sas")
            .with_status(401)
            .with_body(r#"{"error":"invalid token"}"#)
            .create_async()
            .await;

        let tmp = tempfile::tempdir().unwrap();
        let gateway = GatewayClient::new(server.url());
        let mut cache = SasCache::new(
            gateway,
            Box::new(|| "expired.jwt".into()),
            tmp.path().join("s.json"),
        );
        let err = cache.get().await.unwrap_err();
        assert!(matches!(
            err,
            SasError::Gateway(GatewayError::Unauthorized(_))
        ));
    }
}
