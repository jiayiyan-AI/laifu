//! Tauri 装配、commands 与常驻同步编排。
//!
//! `app` feature 专属。默认 feature 下不编译（需 tauri 工具链 + 前端 dist + 系统 webkit）。
//!
//! 四个 surface：`home`（启动默认展示的远程 web 首页）、`flyout`（tray/Dock 状态面板）、
//! `settings`（持久化桌面壳配置）与 `login`（短生命周期登录 webview）。
//! 同步状态机为 `Unauthed` → 登录 webview → device-token → `Authed`；认证后常驻 JWT 续期、
//! SAS 刷新与同步编排 task。
//!
//! 共享状态跨 `.await` 持有 → 用 `tokio::sync::Mutex`（规则 rs-parking-lot：async 协调用 tokio 锁）。
//!
//! 模块划分：
//! - [`core`] `AppCore` 全局状态 + `~/.laifu/` 本地数据目录约定
//! - [`window`] 窗口 label 常量 + size/position 记忆
//! - [`auth_commands`] 登录 webview / 桌面 OAuth 回流 / 登出
//! - [`sync_commands`] 同步目录/状态业务 commands
//! - [`surfaces`] flyout/settings 构建、定位与显隐
//! - 本文件（`mod.rs`）：`run()` 入口——插件/菜单/托盘/deep-link 装配

mod auth_commands;
mod core;
mod sync_commands;
mod surfaces;
mod tasks;
mod window;

use std::sync::Arc;

use tauri::{Emitter, Manager};

use crate::persist;

use core::{config_dir, AppCore};
use surfaces::{show_settings, toggle_flyout_from_tray, MAIN_TRAY_ID};
use window::{apply_saved_geometry, attach_hide_on_close, HOME_WINDOW};

/// Tauri app 装配入口，由 `main.rs`（`app` feature）调用。
pub fn run() {
    let core = Arc::new(AppCore::new());
    let core_setup = core.clone();

    // 区分「点红色关闭按钮」（隐藏到后台，同步编排继续跑）与「真正退出」（托盘菜单
    // 「退出」/ 系统「Quit」）：`RunEvent::ExitRequested` 在两种触发源下都会收到，
    // 只有这个 flag 置位时才放行退出，否则 `prevent_exit()` 把进程留在后台。
    let quitting = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let quitting_tray = quitting.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window(HOME_WINDOW) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell_stub())
        .manage(core)
        .invoke_handler(tauri::generate_handler![
            auth_commands::open_login,
            auth_commands::logout,
            auth_commands::is_authed,
            surfaces::show_settings_window,
            surfaces::show_settings_window_from_home,
            surfaces::show_sync_flyout_from_settings,
            surfaces::show_sync_flyout_from_home,
            auth_commands::open_oauth_in_browser,
            auth_commands::download_cloud_file,
            sync_commands::pick_empty_sync_dir,
            sync_commands::pick_sync_move_destination,
            sync_commands::configure_empty_sync_dir,
            sync_commands::relocate_sync_dir,
            sync_commands::get_sync_dir,
            sync_commands::get_sync_status,
        ])
        .menu(build_app_menu)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "show-settings" {
                if let Err(error) = show_settings(app) {
                    eprintln!("[menu] show settings failed: {error}");
                }
            }
        })
        .setup(move |app| {
            let _ = crate::window_state::remove_one(config_dir(), "sync");
            // 在启动同步前先恢复可能卡在 `rename` 与配置提交之间的目录移动。
            // 模糊状态不猜测目录归属，直接进入 NeedsAttention 并禁止自动同步。
            match persist::recover_pending_move(config_dir()) {
                Ok(_) => {
                    if let Some(dir) = persist::load(config_dir()).sync_dir {
                        core_setup.sync_dir_tx.send_replace(Some(dir));
                    }
                }
                Err(error) => {
                    let core_recovery = core_setup.clone();
                    tauri::async_runtime::spawn(async move {
                        *core_recovery.sync.lock().await = crate::state::SyncState::NeedsAttention(
                            format!("同步目录移动未完成：{error}"),
                        );
                    });
                }
            }

            // 桌面「系统浏览器走 OAuth」回流：deep link 命中渠道专属 scheme
            // （`crate::channel::deep_link_scheme()`：stable=`laifu`/canary=`laifu-canary`/
            // dev=`laifu-dev`，须与 `tauri.conf.*.json` 的 `plugins.deep-link` 声明一致）。
            // 已运行的 app 经 `on_open_url` 收到；由 deep link 冷启动的 app 则必须读取
            // `get_current()`，否则 URL 可能早于 listener 注册而丢失。
            {
                use tauri_plugin_deep_link::DeepLinkExt;

                let app_dl = app.handle().clone();
                let core_dl = core_setup.clone();
                let latest_oauth_code = Arc::new(std::sync::Mutex::new(None));
                let callback_code = latest_oauth_code.clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        handle_desktop_oauth_url(&app_dl, &core_dl, &callback_code, url);
                    }
                });

                match app.deep_link().get_current() {
                    Ok(Some(urls)) => {
                        for url in urls {
                            handle_desktop_oauth_url(
                                app.handle(),
                                &core_setup,
                                &latest_oauth_code,
                                url,
                            );
                        }
                    }
                    Ok(None) => {}
                    Err(error) => eprintln!("[deep-link] failed to read initial URL: {error}"),
                }
            }

            // 启动即展示远程 home；settings 按需建立并记住关闭时的几何。
            // flyout 始终按当前入口重新定位，不保存几何。
            let home_title = format!("来福{}", crate::channel::display_suffix());
            let home_builder = tauri::WebviewWindowBuilder::new(
                app,
                HOME_WINDOW,
                tauri::WebviewUrl::External(
                    auth_commands::home_url()
                        .parse()
                        .map_err(|e| format!("bad home url: {e}"))?,
                ),
            )
            .title(&home_title)
            .inner_size(1280.0, 800.0);
            let home_win = home_builder.build()?;
            apply_saved_geometry(&home_win, HOME_WINDOW);
            attach_hide_on_close(&home_win);

            // 托盘保留 home 与设置入口；左键只切换 flyout，退出才真正终止进程。
            let show_item =
                tauri::menu::MenuItem::with_id(app, "tray-show", "显示来福", true, None::<&str>)?;
            let settings_item =
                tauri::menu::MenuItem::with_id(app, "tray-settings", "设置…", true, None::<&str>)?;
            let separator = tauri::menu::PredefinedMenuItem::separator(app)?;
            let quit_item =
                tauri::menu::MenuItem::with_id(app, "tray-quit", "退出", true, None::<&str>)?;
            let tray_menu = tauri::menu::Menu::with_items(
                app,
                &[&show_item, &settings_item, &separator, &quit_item],
            )?;
            let quitting_menu = quitting_tray.clone();
            tauri::tray::TrayIconBuilder::with_id(MAIN_TRAY_ID)
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .expect("bundle.icon 未配置"),
                )
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .tooltip(format!("来福{}", crate::channel::display_suffix()))
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "tray-show" => {
                        if let Some(win) = app.get_webview_window(HOME_WINDOW) {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "tray-settings" => {
                        if let Err(error) = show_settings(app) {
                            eprintln!("[tray] show settings failed: {error}");
                        }
                    }
                    "tray-quit" => {
                        quitting_menu.store(true, std::sync::atomic::Ordering::SeqCst);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        rect,
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_flyout_from_tray(tray.app_handle(), rect);
                    }
                })
                .build(app)?;

            let core = core_setup.clone();
            tauri::async_runtime::spawn(async move {
                core.restore_from_keychain().await;
                let c1 = core.clone();
                let c2 = core.clone();
                tauri::async_runtime::spawn(tasks::spawn_refresh_guard(c1));
                tauri::async_runtime::spawn(tasks::spawn_sync_orchestrator(c2));
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building lingxi-desktop");

    app.run(move |app_handle, event| match event {
        // home/settings 关闭后只是 hide()；未显式走 tray「退出」的进程退出请求一律挡住。
        tauri::RunEvent::ExitRequested { api, .. } => {
            if !quitting.load(std::sync::atomic::Ordering::SeqCst) {
                api.prevent_exit();
            }
        }
        // macOS Dock 图标被点击且所有 surface 都隐藏时，唤出 home。
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen {
            has_visible_windows,
            ..
        } => {
            if !has_visible_windows {
                if let Some(win) = app_handle.get_webview_window(HOME_WINDOW) {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        }
        _ => {}
    });
}


fn build_app_menu(handle: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let menu = tauri::menu::Menu::default(handle)?;
    let settings_item = tauri::menu::MenuItem::with_id(
        handle,
        "show-settings",
        "设置…",
        true,
        Some("CmdOrCtrl+,")
    )?;

    #[cfg(target_os = "macos")]
    {
        let items = menu.items()?;
        let app_menu = items
            .first()
            .and_then(tauri::menu::MenuItemKind::as_submenu)
            .expect("default macOS menu includes an application submenu");
        app_menu.insert(&settings_item, 1)?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let settings_menu =
            tauri::menu::Submenu::with_items(handle, "设置", true, &[&settings_item])?;
        menu.append(&settings_menu)?;
    }

    Ok(menu)
}

fn handle_desktop_oauth_url(
    app: &tauri::AppHandle,
    core: &Arc<AppCore>,
    latest_oauth_code: &Arc<std::sync::Mutex<Option<String>>>,
    url: tauri::Url,
) {
    if url.scheme() != crate::channel::deep_link_scheme() {
        return;
    }

    let Some(code) = url
        .query_pairs()
        .find(|(key, _)| key == "code")
        .map(|(_, value)| value.into_owned())
    else {
        return;
    };

    let mut latest_code = match latest_oauth_code.lock() {
        Ok(latest_code) => latest_code,
        Err(error) => {
            eprintln!("[deep-link] callback de-duplication lock failed: {error}");
            return;
        }
    };
    if latest_code.as_deref() == Some(code.as_str()) {
        return;
    }
    *latest_code = Some(code.clone());
    drop(latest_code);

    let app = app.clone();
    let core = core.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = auth_commands::complete_desktop_oauth(&app, &core, &code).await {
            eprintln!("[deep-link] complete_desktop_oauth failed: {error}");
            let _ = app.emit("login-failed", error);
        }
    });
}

/// 占位：autostart / notification / updater 等尚未接入的插件。保留 no-op，避免在
/// 这些 crate 尚未引入时影响 app feature 编译。
fn tauri_plugin_shell_stub() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("lingxi-noop").build()
}
