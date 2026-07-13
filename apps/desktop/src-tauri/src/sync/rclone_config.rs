//! 生成 rclone 配置（文档 §11.5 尾 / §11.6）。
//!
//! rclone `azureblob` remote 用 `sas_url` 鉴权。每次 SAS 刷新后重写此配置文件的
//! `sas_url` 行。配置只含 `sas_url`（不含账户密钥），符合"密钥永不出 gateway"。
//!
//! sas_url 取 `CloudWriteSas::rclone_sas_url()`（container 级 URL；rclone 会 strip
//! container 名重建 endpoint，sr=d/sdd/sig 保真——见设计文档 §九源码结论）。

use crate::contracts::CloudWriteSas;

/// remote 名，固定。rclone 命令里以 `<REMOTE_NAME>:` 引用。
pub const REMOTE_NAME: &str = "laifu";

/// 渲染 rclone 配置文件内容（INI 格式）。
///
/// ```ini
/// [laifu]
/// type = azureblob
/// sas_url = https://<acct>.blob.core.windows.net/<container>?<sas>
/// ```
pub fn render(sas: &CloudWriteSas) -> String {
    format!(
        "[{name}]\ntype = azureblob\nsas_url = {url}\n",
        name = REMOTE_NAME,
        url = sas.rclone_sas_url(),
    )
}

/// 同步子目录名（§11.8 开放项 #3，已拍板：**限定子目录**）。
///
/// 只同步 `<user_id>/sync/` 子树，隔离 agent 工作区的临时/中间产物，避免噪声灌进用户机器。
/// agent 侧「要给用户看的」文件须产到此子目录（`cloud_file` 默认路径配合）。
pub const SYNC_SUBDIR: &str = "sync";

/// 同步对的远端路径：`<remote>:<container>/<user_id>/sync`。
///
/// `prefix` 形如 `<user_id>/`（含尾 `/`）——去尾 `/` 后追加 [`SYNC_SUBDIR`]。
/// SAS 签在 `<user_id>/`（目录 SAS 授权覆盖其所有子 blob），`sync/` 在其内，访问不越权。
pub fn remote_path(sas: &CloudWriteSas) -> String {
    let user_prefix = sas.prefix.trim_end_matches('/');
    format!("{}:{}/{}/{}", REMOTE_NAME, sas.container, user_prefix, SYNC_SUBDIR)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_sas() -> CloudWriteSas {
        CloudWriteSas {
            blob_endpoint: "https://stlingxidev.blob.core.windows.net".into(),
            container: "laifu-cloud".into(),
            prefix: "6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f/".into(),
            sas_token: "sv=2020-02-10&sr=d&sdd=1&sig=abc".into(),
            expires_at: "2026-07-09T00:15:00Z".into(),
        }
    }

    #[test]
    fn render_produces_valid_ini() {
        let cfg = render(&sample_sas());
        assert!(cfg.contains("[laifu]"));
        assert!(cfg.contains("type = azureblob"));
        assert!(cfg.contains(
            "sas_url = https://stlingxidev.blob.core.windows.net/laifu-cloud?sv=2020-02-10&sr=d&sdd=1&sig=abc"
        ));
    }

    #[test]
    fn render_has_no_account_key() {
        // 安全不变量：配置绝不含账户密钥字段。
        let cfg = render(&sample_sas());
        assert!(!cfg.contains("account"));
        assert!(!cfg.contains("key ="));
    }

    #[test]
    fn remote_path_appends_sync_subdir() {
        assert_eq!(
            remote_path(&sample_sas()),
            "laifu:laifu-cloud/6e8b21f0-3a4c-4f3d-9b9e-1a2b3c4d5e6f/sync"
        );
    }
}
