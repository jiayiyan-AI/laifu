//! 同步盘窗口 + 同步目录/状态相关 Tauri commands。

use std::sync::Arc;

use tauri::{Manager, State};

use crate::persist;
use crate::state::SyncState;

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
    let builder =
        tauri::WebviewWindowBuilder::new(&app, SYNC_WINDOW, tauri::WebviewUrl::App("index.html".into()))
            .title(format!("来福同步盘{}", crate::channel::display_suffix()))
            .inner_size(720.0, 520.0);
    let win = builder.build().map_err(|e| e.to_string())?;
    apply_saved_geometry(&win, SYNC_WINDOW);
    attach_hide_on_close(&win);
    Ok(())
}

/// 弹原生目录选择对话框（文档 §9.5）。阻塞式选择放到 blocking 线程，避免卡 UI。
/// 返回裸文件系统路径（`FilePath::into_path` 归一化 `file://` URL 变体），
/// 直接可喂给 rclone/watcher。
#[tauri::command]
pub(super) async fn pick_sync_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().blocking_pick_folder()
    })
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

/// 设置同步目录：落盘持久化（重启后恢复）+ 广播到编排器（热重启同步会话）。
#[tauri::command]
pub(super) async fn set_sync_dir(dir: String, core: State<'_, Arc<AppCore>>) -> Result<(), String> {
    persist::save_sync_dir(config_dir(), Some(dir.clone())).map_err(|e| e.to_string())?;
    // send_replace（而非 send）：`send` 在零订阅者时静默丢弃新值不写入（见 mod.rs setup()
    // 恢复逻辑的同类踩坑注释），若编排器 subscribe() 尚未跑到，用户刚选的目录会连
    // `core.sync_dir()` 自己都读不到。send_replace 无条件写值，规避这个时序窗口。
    core.sync_dir_tx.send_replace(Some(dir));
    Ok(())
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
