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

/// 已写入磁盘、尚未完成的同卷目录移动。
///
/// 先落此意图，再执行原子 `rename`，最后提交新 `sync_dir`。进程若恰在两步之间退出，
/// 下次启动可根据两个路径的存在性无歧义恢复，而不是把已移动的目录当成丢失。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingMove {
    pub from: String,
    pub to: String,
}

/// 启动时处理迁移日志的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MoveRecovery {
    None,
    KeptSource,
    CompletedTarget(String),
}

/// 持久化的本地配置。留 JSON 便于后续扩展字段。
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Config {
    /// 用户选择的同步目录（缺省/未选时为 None）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_dir: Option<String>,
    /// 正在执行的目录 rename；正常完成时不会持久化此字段。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_move: Option<PendingMove>,
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
    cfg.pending_move = None;
    cfg.sync_dir = sync_dir;
    save(config_dir, &cfg)
}

/// 记录目录移动意图。调用方必须在此后立即执行同卷 `rename`，再调用
/// [`complete_sync_dir_move`] 提交新路径。
pub fn begin_sync_dir_move(config_dir: &Path, pending_move: PendingMove) -> std::io::Result<()> {
    let mut cfg = load(config_dir);
    cfg.pending_move = Some(pending_move);
    save(config_dir, &cfg)
}

/// 提交已成功移动的同步目录，并清理迁移日志。
pub fn complete_sync_dir_move(config_dir: &Path, sync_dir: String) -> std::io::Result<()> {
    let mut cfg = load(config_dir);
    cfg.sync_dir = Some(sync_dir);
    cfg.pending_move = None;
    save(config_dir, &cfg)
}

/// 恢复在目录 rename 前后崩溃留下的移动日志。
///
/// 两个路径都存在或都不存在时无法安全推断，保留日志并返回错误，调用方必须进入
/// `NeedsAttention`，不能擅自选择其中一份数据。
pub fn recover_pending_move(config_dir: &Path) -> std::io::Result<MoveRecovery> {
    let mut cfg = load(config_dir);
    let Some(pending) = cfg.pending_move.clone() else {
        return Ok(MoveRecovery::None);
    };
    let source_exists = Path::new(&pending.from).exists();
    let target_exists = Path::new(&pending.to).exists();

    match (source_exists, target_exists) {
        (true, false) => {
            cfg.pending_move = None;
            save(config_dir, &cfg)?;
            Ok(MoveRecovery::KeptSource)
        }
        (false, true) => {
            cfg.sync_dir = Some(pending.to.clone());
            cfg.pending_move = None;
            save(config_dir, &cfg)?;
            Ok(MoveRecovery::CompletedTarget(pending.to))
        }
        (true, true) => Err(std::io::Error::other(
            "同步目录迁移中断：原目录与目标目录同时存在",
        )),
        (false, false) => Err(std::io::Error::other(
            "同步目录迁移中断：原目录与目标目录均不存在",
        )),
    }
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
        assert_eq!(
            load(dir.path()).sync_dir.as_deref(),
            Some("/Users/me/Desktop/sync")
        );
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

    #[test]
    fn recovery_keeps_source_when_rename_never_happened() {
        let config_dir = tempfile::tempdir().unwrap();
        let files = tempfile::tempdir().unwrap();
        let source = files.path().join("source");
        let target = files.path().join("target");
        std::fs::create_dir(&source).unwrap();
        save_sync_dir(config_dir.path(), Some(source.display().to_string())).unwrap();
        begin_sync_dir_move(
            config_dir.path(),
            PendingMove {
                from: source.display().to_string(),
                to: target.display().to_string(),
            },
        )
        .unwrap();

        assert_eq!(
            recover_pending_move(config_dir.path()).unwrap(),
            MoveRecovery::KeptSource
        );
        assert_eq!(load(config_dir.path()).sync_dir.as_deref(), source.to_str());
        assert_eq!(load(config_dir.path()).pending_move, None);
    }

    #[test]
    fn recovery_commits_target_after_rename() {
        let config_dir = tempfile::tempdir().unwrap();
        let files = tempfile::tempdir().unwrap();
        let source = files.path().join("source");
        let target = files.path().join("target");
        std::fs::create_dir(&source).unwrap();
        save_sync_dir(config_dir.path(), Some(source.display().to_string())).unwrap();
        begin_sync_dir_move(
            config_dir.path(),
            PendingMove {
                from: source.display().to_string(),
                to: target.display().to_string(),
            },
        )
        .unwrap();
        std::fs::rename(&source, &target).unwrap();

        assert_eq!(
            recover_pending_move(config_dir.path()).unwrap(),
            MoveRecovery::CompletedTarget(target.display().to_string())
        );
        assert_eq!(load(config_dir.path()).sync_dir.as_deref(), target.to_str());
        assert_eq!(load(config_dir.path()).pending_move, None);
    }

    #[test]
    fn recovery_refuses_ambiguous_move() {
        let config_dir = tempfile::tempdir().unwrap();
        let files = tempfile::tempdir().unwrap();
        let source = files.path().join("source");
        let target = files.path().join("target");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&target).unwrap();
        begin_sync_dir_move(
            config_dir.path(),
            PendingMove {
                from: source.display().to_string(),
                to: target.display().to_string(),
            },
        )
        .unwrap();

        assert!(recover_pending_move(config_dir.path()).is_err());
        assert!(load(config_dir.path()).pending_move.is_some());
    }
}
