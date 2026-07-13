//! 非机密本地配置持久化（当前仅同步目录）。
//!
//! keychain 存机密凭据（设备 JWT）；而同步目录这类**非机密**配置进普通 JSON 文件，
//! 使 App 重启后能恢复上次选择的目录、自动续跑同步——否则每次启动都要重选。
//!
//! `app` feature 专属：路径由调用方解析后传入（现为系统 home 目录下 `~/.laifu/`，
//! 见 `app/core.rs` `LAIFU_HOME`），故本模块只做纯 IO，便于用 tempdir 单测。

use std::path::Path;

use serde::{Deserialize, Serialize};

/// 配置文件名（落在 `~/.laifu/` 下）。
const CONFIG_FILE: &str = "config.json";

/// 持久化的本地配置。留 JSON 便于后续扩展字段。
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Config {
    /// 用户选择的同步目录（缺省/未选时为 None）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_dir: Option<String>,
}

fn config_path(config_dir: &Path) -> std::path::PathBuf {
    config_dir.join(CONFIG_FILE)
}

/// 读配置；文件不存在或解析失败→返回默认（不因坏文件卡死启动）。
pub fn load(config_dir: &Path) -> Config {
    match std::fs::read(config_path(config_dir)) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Config::default(),
    }
}

/// 写配置（原子覆盖）。父目录不存在时先建。
pub fn save(config_dir: &Path, cfg: &Config) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let json = serde_json::to_vec_pretty(cfg).map_err(std::io::Error::other)?;
    // 先写临时文件再 rename，避免写一半崩溃留下坏文件。
    let final_path = config_path(config_dir);
    let tmp_path = final_path.with_extension("json.tmp");
    std::fs::write(&tmp_path, json)?;
    std::fs::rename(&tmp_path, &final_path)
}

/// 便捷：只更新 sync_dir 并落盘。
pub fn save_sync_dir(config_dir: &Path, sync_dir: Option<String>) -> std::io::Result<()> {
    let mut cfg = load(config_dir);
    cfg.sync_dir = sync_dir;
    save(config_dir, &cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_missing_returns_default() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(dir.path()), Config::default());
    }

    #[test]
    fn save_then_load_roundtrips_sync_dir() {
        let dir = tempfile::tempdir().unwrap();
        save_sync_dir(dir.path(), Some("/Users/me/Desktop/sync".into())).unwrap();
        assert_eq!(load(dir.path()).sync_dir.as_deref(), Some("/Users/me/Desktop/sync"));
    }

    #[test]
    fn save_none_clears_sync_dir() {
        let dir = tempfile::tempdir().unwrap();
        save_sync_dir(dir.path(), Some("/tmp/x".into())).unwrap();
        save_sync_dir(dir.path(), None).unwrap();
        assert_eq!(load(dir.path()).sync_dir, None);
    }

    #[test]
    fn load_corrupt_file_returns_default() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(CONFIG_FILE), b"{not json").unwrap();
        assert_eq!(load(dir.path()), Config::default());
    }
}
