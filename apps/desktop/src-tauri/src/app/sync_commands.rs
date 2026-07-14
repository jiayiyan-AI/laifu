//! 同步盘窗口 + 同步目录/状态相关 Tauri commands。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{Manager, State};

use crate::persist::{self, PendingMove};
use crate::state::SyncState;
use crate::sync::location;

use super::core::{config_dir, AppCore};
use super::window::{apply_saved_geometry, attach_hide_on_close, SYNC_WINDOW};

/// 打开（或聚焦）同步盘窗口：原生 Login/Sync/Settings 壳，经系统菜单唤出。
/// 首次调用建窗（指向现有 dist 前端，`WebviewUrl::App` 在 dev 下解析到 devUrl）；
/// 窗已存在则直接聚焦，不重复建。
#[tauri::command]
pub(super) async fn open_sync_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(SYNC_WINDOW) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        SYNC_WINDOW,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title(format!("来福同步盘{}", crate::channel::display_suffix()))
    .inner_size(720.0, 520.0);
    let win = builder.build().map_err(|e| e.to_string())?;
    apply_saved_geometry(&win, SYNC_WINDOW);
    attach_hide_on_close(&win);
    Ok(())
}

/// 选择一个将作为严格空同步目录的候选路径。
#[tauri::command]
pub(super) async fn pick_empty_sync_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    pick_folder(app).await
}

/// 选择移动同步目录时的新上级目录。
#[tauri::command]
pub(super) async fn pick_sync_move_destination(
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    pick_folder(app).await
}

/// 改用一个严格空的新同步目录。
///
/// 持有写锁期间不会有 rclone 使用旧路径；完成本地配置提交后才广播新路径，旧 watcher/
/// poller 因 watch 版本变化退出，新会话带 `--resync` 从远端重建基线。
#[tauri::command]
pub(super) async fn configure_empty_sync_dir(
    dir: String,
    core: State<'_, Arc<AppCore>>,
) -> Result<(), String> {
    let _operation = core.sync_directory_operation.lock().await;
    let current = core.sync_dir().map(PathBuf::from);
    let candidate = validate_empty_dir(dir, current.clone()).await?;
    if current.is_some() {
        core.flush_sync().await?;
    }
    let _paused = core.sync_run_lock.write().await;
    // 用户在确认框停留期间或等待在途同步结束时，其他程序仍可能写入候选目录。
    // 在真正切换前重新检查，避免 TOCTOU 让非空目录混入同步盘。
    let candidate = validate_empty_dir(candidate.to_string_lossy().into_owned(), current).await?;
    let configured = candidate.to_string_lossy().into_owned();

    persist::save_sync_dir(config_dir(), Some(configured.clone())).map_err(|e| e.to_string())?;
    core.sync_dir_tx.send_replace(Some(configured));
    Ok(())
}

/// 将当前同步根目录原子移动到用户选定的上级目录。
///
/// 只尝试单次 `rename`，因此跨磁盘不会退化为不可恢复的递归复制；失败时保留原目录与
/// 原配置。rename 前的 PendingMove 日志覆盖「目录已经移动、配置尚未来得及提交」的崩溃窗。
#[tauri::command]
pub(super) async fn relocate_sync_dir(
    destination_parent: String,
    core: State<'_, Arc<AppCore>>,
) -> Result<(), String> {
    let _operation = core.sync_directory_operation.lock().await;
    let source = core
        .sync_dir()
        .ok_or_else(|| "尚未配置同步目录，不能移动".to_string())?;
    validate_relocation(source.clone(), destination_parent.clone()).await?;
    core.flush_sync().await?;
    let _paused = core.sync_run_lock.write().await;
    // 在等待在途 rclone 结束时，目标可能已被别的程序创建；重新规划后才落日志。
    let relocation = validate_relocation(source, destination_parent).await?;
    let target = relocation.target.to_string_lossy().into_owned();

    persist::begin_sync_dir_move(
        config_dir(),
        PendingMove {
            from: relocation.source.to_string_lossy().into_owned(),
            to: target.clone(),
        },
    )
    .map_err(|e| e.to_string())?;

    if let Err(error) = location::move_directory(&relocation) {
        // rename 失败时它没有部分成功语义；清理 journal 后旧会话可继续工作。
        let _ = persist::recover_pending_move(config_dir());
        return Err(error.to_string());
    }

    if let Err(error) = persist::complete_sync_dir_move(config_dir(), target.clone()) {
        // 文件系统已安全 rename，但无法可靠提交配置。保持同步暂停，避免恢复到不存在的旧路径。
        core.sync_dir_tx.send_replace(None);
        *core.sync.lock().await = SyncState::NeedsAttention(format!(
            "同步目录已移到 {target}，但无法保存新配置：{error}"
        ));
        return Err(format!("目录已移动，但无法保存新配置：{error}"));
    }

    core.sync_dir_tx.send_replace(Some(target));
    Ok(())
}

async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked =
        tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
            .await
            .map_err(|e| e.to_string())?;
    match picked {
        Some(fp) => fp
            .into_path()
            .map(|p| Some(p.to_string_lossy().into_owned()))
            .map_err(|e| format!("bad picked path: {e}")),
        None => Ok(None),
    }
}

async fn validate_empty_dir(dir: String, current: Option<PathBuf>) -> Result<PathBuf, String> {
    tauri::async_runtime::spawn_blocking(move || {
        location::empty_sync_dir(Path::new(&dir), current.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

async fn validate_relocation(
    source: String,
    destination_parent: String,
) -> Result<location::Relocation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        location::relocation(Path::new(&source), Path::new(&destination_parent))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// 回读当前同步目录（供 UI 启动回显；无则 None）。
#[tauri::command]
pub(super) async fn get_sync_dir(core: State<'_, Arc<AppCore>>) -> Result<Option<String>, String> {
    Ok(core.sync_dir())
}

/// 查询同步状态（供 UI 展示）。
#[tauri::command]
pub(super) async fn get_sync_status(core: State<'_, Arc<AppCore>>) -> Result<String, String> {
    let s = core.sync.lock().await;
    Ok(match &*s {
        SyncState::Idle => "idle".into(),
        SyncState::Syncing => "syncing".into(),
        SyncState::Error(m) => format!("error: {m}"),
        SyncState::NeedsAttention(m) => format!("attention: {m}"),
    })
}
