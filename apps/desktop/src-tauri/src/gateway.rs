//! Gateway HTTP 客户端：桌面客户端与 gateway 的端点交互。
//!
//!   - POST /api/auth/device-token           session cookie → 长效设备 JWT
//!   - POST /api/auth/device-token/exchange  一次性交接码 → 长效设备 JWT（系统浏览器 OAuth 回流）
//!   - POST /api/auth/refresh-token          Bearer 旧 JWT → 新 JWT（续期）
//!   - POST /api/auth/session-code           Bearer 设备 JWT → 一次性交接码（供 home 窗口种 cookie）
//!   - GET  /api/cloud/sas                   Bearer JWT → 目录 SAS
//!   - GET  /api/cloud/list                  Cookie session → 云端文件清单（变更发现轮询）
//!
//! 401 单独建模为 `GatewayError::Unauthorized`，让上层状态机区分"该重登/重刷"
//! 与普通失败（对齐 `sas_cache.py` 的 `AuthError` 语义）。

use crate::contracts::{CloudListResponse, CloudWriteSas, SessionCodeResponse, TokenResponse};

/// Gateway 交互错误。`Unauthorized` 专指 401，驱动上层重登/吊销处理。
#[derive(Debug, thiserror::Error)]
pub enum GatewayError {
    /// gateway 返回 401 —— JWT/session 过期或被吊销（token_version bump）。
    #[error("gateway returned 401 (auth expired or revoked): {0}")]
    Unauthorized(String),
    /// 其它非 2xx 状态。
    #[error("gateway returned HTTP {status}: {body}")]
    Http { status: u16, body: String },
    /// 网络/传输层错误。
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),
}

/// 规则 rs-result-type：错误类型作带默认值的泛型参数暴露。
pub type Result<T, E = GatewayError> = std::result::Result<T, E>;

/// gateway HTTP 客户端。持有 base URL 与共享 `reqwest::Client`（连接池复用）。
#[derive(Debug, Clone)]
pub struct GatewayClient {
    base_url: String,
    http: reqwest::Client,
}

impl GatewayClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            http: reqwest::Client::new(),
        }
    }

    /// 用已有 `reqwest::Client`（如带自定义 TLS/超时配置）构造。
    pub fn with_client(base_url: impl Into<String>, http: reqwest::Client) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            http,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    /// gateway base URL（含 scheme+host+port），供 native cookie 域匹配用。
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// POST /api/auth/device-token —— 用 session cookie 换设备 JWT。
    /// `session_cookie` 形如 `lingxi_sid=<jwt>`（整条 Cookie header 值）。
    pub async fn device_token(&self, session_cookie: &str) -> Result<TokenResponse> {
        let resp = self
            .http
            .post(self.url("/api/auth/device-token"))
            .header(reqwest::header::COOKIE, session_cookie)
            .send()
            .await?;
        Self::parse_json(resp).await
    }

    /// POST /api/auth/device-token/exchange —— 用一次性交接码换设备 JWT
    /// （桌面「系统浏览器走 OAuth」第一跳：deep link 带回的 code，见 gateway
    /// `auth/desktop-handoff.ts` 顶部注释）。
    pub async fn device_token_exchange(&self, code: &str) -> Result<TokenResponse> {
        let resp = self
            .http
            .post(self.url("/api/auth/device-token/exchange"))
            .json(&serde_json::json!({ "code": code }))
            .send()
            .await?;
        Self::parse_json(resp).await
    }

    /// POST /api/auth/refresh-token —— 用旧 JWT 换新 JWT（含 7 天宽限）。
    pub async fn refresh_token(&self, jwt: &str) -> Result<TokenResponse> {
        let resp = self
            .http
            .post(self.url("/api/auth/refresh-token"))
            .bearer_auth(jwt)
            .send()
            .await?;
        Self::parse_json(resp).await
    }

    /// POST /api/auth/session-code —— 用设备 JWT 换一次性交接码，供 `home` 窗口的
    /// WebView 导航到 gateway `session-from-code` 端点种上 session cookie。
    pub async fn session_code(&self, jwt: &str) -> Result<SessionCodeResponse> {
        let resp = self
            .http
            .post(self.url("/api/auth/session-code"))
            .bearer_auth(jwt)
            .send()
            .await?;
        Self::parse_json(resp).await
    }

    /// GET /api/cloud/sas —— 用设备 JWT 拿目录 SAS。
    pub async fn cloud_sas(&self, jwt: &str) -> Result<CloudWriteSas> {
        let resp = self
            .http
            .get(self.url("/api/cloud/sas"))
            .bearer_auth(jwt)
            .send()
            .await?;
        Self::parse_json(resp).await
    }

    /// GET /api/cloud/list —— 用设备 JWT 列 `<user_id>/<prefix>` 清单（变更发现轮询）。
    /// 该端点双鉴权（`cloud.ts` `jwtOrSession`）：有 Bearer 走 containerAuth，否则回落 session。
    /// 设备端持长效设备 JWT（90 天可续），故走 Bearer——避免依赖 7 天即过期且无续期的 session cookie。
    ///
    /// ⚠️ `prefix` 必传且应为同步范围（`SYNC_SUBDIR` = `sync/`）。gateway 用
    /// `listBlobsByHierarchy('/')` **只列一层**：不带 prefix 时只看到 `sync/` 文件夹、`files` 为空，
    /// poller 永远发现不了 `sync/` 内的远端变更 → 下行失效。传 `sync/` 才列出其中的真文件。
    pub async fn cloud_list(&self, jwt: &str, prefix: &str) -> Result<CloudListResponse> {
        let resp = self
            .http
            .get(self.url("/api/cloud/list"))
            .query(&[("prefix", prefix)])
            .bearer_auth(jwt)
            .send()
            .await?;
        Self::parse_json(resp).await
    }

    /// 统一响应处理：2xx → 反序列化；401 → Unauthorized；其它 → Http。
    async fn parse_json<T: serde::de::DeserializeOwned>(resp: reqwest::Response) -> Result<T> {
        let status = resp.status();
        if status.is_success() {
            return Ok(resp.json::<T>().await?);
        }
        let code = status.as_u16();
        let body = resp.text().await.unwrap_or_default();
        if code == 401 {
            return Err(GatewayError::Unauthorized(body));
        }
        Err(GatewayError::Http { status: code, body })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn device_token_success() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", "/api/auth/device-token")
            .match_header("cookie", "lingxi_sid=sess.jwt.x")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"token":"dev.jwt.y","expires_at":"2026-10-07T00:00:00Z"}"#)
            .create_async()
            .await;

        let client = GatewayClient::new(server.url());
        let tok = client.device_token("lingxi_sid=sess.jwt.x").await.unwrap();
        assert_eq!(tok.token, "dev.jwt.y");
        m.assert_async().await;
    }

    #[tokio::test]
    async fn device_token_401_maps_to_unauthorized() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("POST", "/api/auth/device-token")
            .with_status(401)
            .with_body(r#"{"error":"not authenticated"}"#)
            .create_async()
            .await;

        let client = GatewayClient::new(server.url());
        let err = client.device_token("lingxi_sid=bad").await.unwrap_err();
        assert!(matches!(err, GatewayError::Unauthorized(_)));
    }

    #[tokio::test]
    async fn cloud_sas_success_uses_bearer() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("GET", "/api/cloud/sas")
            .match_header("authorization", "Bearer dev.jwt.y")
            .with_status(200)
            .with_body(
                r#"{"blob_endpoint":"https://a.blob.core.windows.net","container":"laifu-cloud","prefix":"u/","sas_token":"sv=2020-02-10&sr=d&sdd=1&sig=z","expires_at":"2026-07-09T00:15:00Z"}"#,
            )
            .create_async()
            .await;

        let client = GatewayClient::new(server.url());
        let sas = client.cloud_sas("dev.jwt.y").await.unwrap();
        assert_eq!(sas.container, "laifu-cloud");
        assert_eq!(
            sas.rclone_sas_url(),
            "https://a.blob.core.windows.net/laifu-cloud?sv=2020-02-10&sr=d&sdd=1&sig=z"
        );
        m.assert_async().await;
    }

    #[tokio::test]
    async fn cloud_sas_403_maps_to_http_not_unauthorized() {
        // 403（entitlement 未开）不是 401，应走 Http 分支而非 Unauthorized。
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/api/cloud/sas")
            .with_status(403)
            .with_body(r#"{"error":"cloud entitlement not active"}"#)
            .create_async()
            .await;

        let client = GatewayClient::new(server.url());
        let err = client.cloud_sas("dev.jwt.y").await.unwrap_err();
        match err {
            GatewayError::Http { status, .. } => assert_eq!(status, 403),
            other => panic!("expected Http 403, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn cloud_list_success_sends_prefix() {
        let mut server = mockito::Server::new_async().await;
        server
            .mock("GET", "/api/cloud/list")
            .match_header("authorization", "Bearer devjwt")
            .match_query(mockito::Matcher::UrlEncoded("prefix".into(), "sync/".into()))
            .with_status(200)
            .with_body(r#"{"folders":[],"files":[{"virtual_path":"sync/a.txt","size":3,"last_modified":"2026-07-10T00:00:00Z","content_type":"text/plain","metadata":{"title":"a.txt","source":"agent"}}]}"#)
            .create_async()
            .await;

        let client = GatewayClient::new(server.url());
        let list = client.cloud_list("devjwt", "sync/").await.unwrap();
        assert_eq!(list.files.len(), 1);
        assert_eq!(list.files[0].virtual_path, "sync/a.txt");
    }
}
