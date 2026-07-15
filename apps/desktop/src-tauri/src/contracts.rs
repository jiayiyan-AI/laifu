//! Wire 契约的 Rust serde 镜像。
//!
//! ⚠️ 必须与 `packages/shared/src/contracts.ts` 保持同步（文档决策①：手写镜像，
//! 契约少且稳定，成本远低于 codegen）。字段名/类型/可空性一改，这里同步改。
//!
//! 覆盖桌面同步盘客户端实际消费的端点响应：
//!   - POST /api/auth/device-token   -> DeviceTokenResponse
//!   - POST /api/auth/refresh-token  -> RefreshTokenResponse（shape 同 device-token）
//!   - GET  /api/cloud/sas           -> CloudWriteSasResponse
//!   - GET  /api/cloud/list          -> CloudListResponse

use serde::{Deserialize, Serialize};

/// `POST /api/auth/device-token` 响应（`contracts.ts` DeviceTokenResponse）。
/// 与 `RefreshTokenResponse` 同 shape，客户端两处复用同一结构。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenResponse {
    pub token: String,
    /// ISO-8601，JWT exp 的人可读形式。
    pub expires_at: String,
}

/// `POST /api/auth/session-code` 响应（`contracts.ts` SessionCodeResponse）。
/// 桌面「系统浏览器走 OAuth」第二跳：设备 JWT 换一次性交接码，供 `home` 窗口的
/// WebView 导航到 `GET /api/auth/session-from-code?code=...` 种 session cookie。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionCodeResponse {
    pub code: String,
}

/// `GET /api/cloud/sas` 响应（`contracts.ts` CloudWriteSasResponse）。
///
/// `sas_token` 已是 directory-scoped（sr=d, sdd=1），不含前导 `?`。
/// 客户端拼 URL：`{blob_endpoint}/{container}/{prefix}<virtual_path>?{sas_token}`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudWriteSas {
    pub blob_endpoint: String,
    pub container: String,
    /// `<user_id>/`，含尾随 `/`。
    pub prefix: String,
    /// 不含前导 `?` 的 query 字符串。
    pub sas_token: String,
    /// ISO-8601。
    pub expires_at: String,
}

impl CloudWriteSas {
    /// 拼给 rclone `azureblob` remote 的 `sas_url`：
    /// `{blob_endpoint}/{container}?{sas_token}`。
    ///
    /// 注意：故意只到 container 级 URL（不含 prefix）——rclone 从 URL path 取
    /// container 名判为"容器级 SAS"后会 strip 并重建 endpoint（见设计文档 §九源码结论），
    /// sr=d/sdd 与 sig 在重建中保真。同步对里的 `<user_id>` 子树由 remote 路径
    /// `<remote>:<container>/<user_id>` 指定。
    pub fn rclone_sas_url(&self) -> String {
        format!(
            "{}/{}?{}",
            self.blob_endpoint.trim_end_matches('/'),
            self.container,
            self.sas_token,
        )
    }
}

/// `GET /api/cloud/list` 里的单个文件项（`contracts.ts` CloudFileItem）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudFileItem {
    /// 相对 `<user_id>/`。
    pub virtual_path: String,
    pub size: u64,
    /// ISO-8601。
    pub last_modified: String,
    pub content_type: Option<String>,
    pub metadata: CloudFileMetadata,
}

/// CloudFileItem.metadata（`contracts.ts` 内联对象）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudFileMetadata {
    /// 已解码 UTF-8。
    pub title: String,
    pub session_id: Option<String>,
    pub published_at: Option<String>,
    pub tool_version: Option<String>,
    pub description: Option<String>,
    pub tags: Option<Vec<String>>,
    /// 文件来源；旧文件缺省 `agent`。桌面上行未来可能扩展 `desktop`（§10.3），
    /// 故用 String 而非 enum，容忍未知取值不致反序列化失败。
    pub source: String,
}

/// `GET /api/cloud/list` 里的单个文件夹项（`contracts.ts` CloudFolderItem）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudFolderItem {
    /// 相对 `<user_id>/`，含尾随 `/`。
    pub virtual_path: String,
}

/// `GET /api/cloud/list` 响应（`contracts.ts` CloudListResponse）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudListResponse {
    pub folders: Vec<CloudFolderItem>,
    pub files: Vec<CloudFileItem>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_response_roundtrip() {
        let json = r#"{"token":"eyJ.abc.def","expires_at":"2026-10-07T00:00:00.000Z"}"#;
        let parsed: TokenResponse = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.token, "eyJ.abc.def");
        assert_eq!(parsed.expires_at, "2026-10-07T00:00:00.000Z");
    }

    #[test]
    fn cloud_write_sas_builds_rclone_url() {
        let sas = CloudWriteSas {
            blob_endpoint: "https://stlingxidev.blob.core.windows.net".into(),
            container: "laifu-cloud".into(),
            prefix: "6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f/".into(),
            sas_token: "sv=2020-02-10&sr=d&sdd=1&sig=abc".into(),
            expires_at: "2026-07-09T00:15:00Z".into(),
        };
        assert_eq!(
            sas.rclone_sas_url(),
            "https://stlingxidev.blob.core.windows.net/laifu-cloud?sv=2020-02-10&sr=d&sdd=1&sig=abc"
        );
    }

    #[test]
    fn rclone_url_trims_trailing_slash_on_endpoint() {
        let sas = CloudWriteSas {
            blob_endpoint: "https://acct.blob.core.windows.net/".into(),
            container: "c".into(),
            prefix: "u/".into(),
            sas_token: "sig=x".into(),
            expires_at: "2026-07-09T00:15:00Z".into(),
        };
        assert_eq!(
            sas.rclone_sas_url(),
            "https://acct.blob.core.windows.net/c?sig=x"
        );
    }

    #[test]
    fn cloud_list_parses_real_shape() {
        let json = r#"{
            "folders": [{"virtual_path": "reports/"}],
            "files": [{
                "virtual_path": "reports/q2.xlsx",
                "size": 12345,
                "last_modified": "2026-07-08T10:00:00Z",
                "content_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "metadata": {
                    "title": "Q2 Report",
                    "session_id": null,
                    "published_at": "2026-07-08T10:00:00Z",
                    "tool_version": "0.1.0",
                    "description": null,
                    "tags": null,
                    "source": "agent"
                }
            }]
        }"#;
        let parsed: CloudListResponse = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.folders.len(), 1);
        assert_eq!(parsed.folders[0].virtual_path, "reports/");
        assert_eq!(parsed.files.len(), 1);
        assert_eq!(parsed.files[0].virtual_path, "reports/q2.xlsx");
        assert_eq!(parsed.files[0].size, 12345);
        assert_eq!(parsed.files[0].metadata.title, "Q2 Report");
        assert_eq!(parsed.files[0].metadata.source, "agent");
        assert_eq!(parsed.files[0].metadata.session_id, None);
    }

    #[test]
    fn cloud_list_tolerates_unknown_source_value() {
        // §10.3 未来的 source=desktop 不能让反序列化失败。
        let json = r#"{
            "folders": [],
            "files": [{
                "virtual_path": "a.docx", "size": 1, "last_modified": "2026-07-08T10:00:00Z",
                "content_type": null,
                "metadata": {"title":"a","session_id":null,"published_at":null,
                    "tool_version":null,"description":null,"tags":null,"source":"desktop"}
            }]
        }"#;
        let parsed: CloudListResponse = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.files[0].metadata.source, "desktop");
    }
}
