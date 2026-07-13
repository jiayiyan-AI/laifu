//! Tauri 装配 + commands + 常驻编排（文档 §11.1 / §11.3-§11.6）。
//!
//! `app` feature 专属。默认 feature 下不编译（需 tauri 工具链 + 前端 dist + 系统 webkit）。
//!
//! 三窗口：`home`（启动默认展示，web 首页，自带 cookie 鉴权，与本文件的登录/同步逻辑无关）、
//! `sync`（原生 Login/Sync/Settings 壳，经系统菜单「同步盘 → 打开同步盘」按需唤出）、
//! `login`（`sync` 壳内触发登录时短暂建的登录 webview，完成后即关）。
//!
//! `sync` 壳状态机（§11.1）：`Unauthed` → 登录 webview 拿 session → device-token 换 JWT → `Authed`。
//! `Authed` 下常驻三 task：JWT 续期 timer、SAS shim、sync 编排（fs watch + 轮询触发）。
//!
//! 共享状态跨 `.await` 持有 → 用 `tokio::sync::Mutex`（规则 rs-parking-lot：async 协调用 tokio 锁）。
//!
//! 模块划分：
//! - [`core`] `AppCore` 全局状态 + `~/.laifu/` 本地数据目录约定
//! - [`window`] 窗口 label 常量 + size/position 记忆
//! - [`auth_commands`] 登录 webview / 桌面 OAuth 回流 / 登出
//! - [`sync_commands`] 同步盘窗口 + 同步目录/状态
//! - [`tasks`] JWT 续期守护 + SAS 刷新/sync 编排常驻 task
//! - 本文件（`mod.rs`）：`run()` 入口——插件/菜单/托盘/deep-link 装配

mod auth_commands;
mod core;
mod sync_commands;
mod tasks;
mod window;

use std::sync::Arc;

use tauri::{Emitter, Manager};

use crate::persist;

use core::{config_dir, AppCore};
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
        .plugin(tauri_plugin_shell_stub())
        .manage(core)
        .invoke_handler(tauri::generate_handler![
            auth_commands::open_login,
            auth_commands::logout,
            auth_commands::is_authed,
            sync_commands::open_sync_window,
            auth_commands::open_oauth_in_browser,
            sync_commands::pick_sync_dir,
            sync_commands::set_sync_dir,
            sync_commands::get_sync_dir,
            sync_commands::get_sync_status,
        ])
        .menu(|handle| {
            // 保留系统默认菜单（macOS 下含 App 菜单 Quit / Edit 等）+ 追加「同步盘」顶级菜单，
            // 内含「打开同步盘」项，触发 open_sync_window 唤出原生 Login/Sync/Settings 窗口。
            let menu = tauri::menu::Menu::default(handle)?;
            let open_sync_item = tauri::menu::MenuItem::with_id(
                handle,
                "open-sync-window",
                "打开同步盘",
                true,
                None::<&str>,
            )?;
            let sync_menu =
                tauri::menu::Submenu::with_items(handle, "同步盘", true, &[&open_sync_item])?;
            menu.append(&sync_menu)?;
            Ok(menu)
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "open-sync-window" {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = sync_commands::open_sync_window(app).await {
                        eprintln!("[menu] open_sync_window failed: {e}");
                    }
                });
            }
        })
        .setup(move |app| {
            // 恢复上次选择的同步目录 → 广播到编排器，重启后自动续跑，无需用户重选。
            //
            // 用 `send_replace` 而非 `send`：此刻 `spawn_sync_orchestrator` 的 `subscribe()`
            // 还没跑（它在下面异步 spawn 的 task 里，等 `restore_from_keychain().await` 完成后
            // 才订阅），`sync_dir_tx` 订阅者数为 0。`send()` 在零订阅者时直接返回 `Err` 且**不
            // 写入内部值**（tokio watch 文档原话），之前用 `send` + `let _ =` 吞掉这个错误，
            // 导致恢复的目录从未真正写进 channel——`get_sync_dir` 永远读到 `None`，UI 显示
            // "未选择"，即使 `~/.laifu/config.json` 里的值一直是对的。`send_replace` 无论有无
            // 订阅者都无条件写值，才能保证后来才订阅的 orchestrator 能看到它。
            if let Some(dir) = persist::load(config_dir()).sync_dir {
                core_setup.sync_dir_tx.send_replace(Some(dir));
            }

            // 桌面「系统浏览器走 OAuth」回流：deep link 命中渠道专属 scheme
            // （`crate::channel::deep_link_scheme()`：stable=`laifu`/canary=`laifu-canary`/
            // dev=`laifu-dev`，须与 `tauri.conf.*.json` 的 `plugins.deep-link` 声明一致）
            // `?code=...` → complete_desktop_oauth 换设备 JWT + 让 home 窗口种 session cookie。
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let app_dl = app.handle().clone();
                let core_dl = core_setup.clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        if url.scheme() != crate::channel::deep_link_scheme() {
                            continue;
                        }
                        let Some(code) = url.query_pairs().find(|(k, _)| k == "code").map(|(_, v)| v.into_owned()) else {
                            continue;
                        };
                        let app2 = app_dl.clone();
                        let core2 = core_dl.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = auth_commands::complete_desktop_oauth(&app2, &core2, &code).await {
                                eprintln!("[deep-link] complete_desktop_oauth failed: {e}");
                                let _ = app2.emit("login-failed", e);
                            }
                        });
                    }
                });
            }

            // 启动即展示 web 首页（虚拟桌面等业务 UI）；同步盘壳按需经菜单唤出，见 open_sync_window。
            // 记住上次关闭时的 size/position（`~/.laifu/window_state.json`），无存档则用默认值。
            let home_title = format!("来福{}", crate::channel::display_suffix());
            let home_builder = tauri::WebviewWindowBuilder::new(
                app,
                HOME_WINDOW,
                tauri::WebviewUrl::External(
                    auth_commands::home_url().parse().map_err(|e| format!("bad home url: {e}"))?,
                ),
            )
            .title(&home_title)
            .inner_size(1280.0, 800.0);
            let home_win = home_builder.build()?;
            apply_saved_geometry(&home_win, HOME_WINDOW);
            attach_hide_on_close(&home_win);

            // 系统托盘：home/sync 窗口关了也不退出 app（见 attach_hide_on_close），
            // 托盘是重新唤出窗口 / 真正退出的入口。左键点图标唤出 home；菜单「退出」
            // 才是唯一真退出路径（置位 quitting 后 app.exit(0)，见下方 run 回调）。
            let show_item = tauri::menu::MenuItem::with_id(app, "tray-show", "显示来福", true, None::<&str>)?;
            let quit_item = tauri::menu::MenuItem::with_id(app, "tray-quit", "退出", true, None::<&str>)?;
            let tray_menu = tauri::menu::Menu::with_items(app, &[&show_item, &quit_item])?;
            let quitting_menu = quitting_tray.clone();
            tauri::tray::TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("bundle.icon 未配置"))
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
                    "tray-quit" => {
                        quitting_menu.store(true, std::sync::atomic::Ordering::SeqCst);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window(HOME_WINDOW) {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
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
        // home/sync 窗口只是 hide()，不会真的把窗口数归零；这个分支主要兜底系统级退出
        // 请求（比如 Cmd+Q，虽然当前 tauri 在 macOS 下走的是原生 terminate 路径，未必
        // 触发这里，见踩坑记录）—— 未显式走 tray「退出」就一律挡住，保持后台常驻。
        tauri::RunEvent::ExitRequested { api, .. } => {
            if !quitting.load(std::sync::atomic::Ordering::SeqCst) {
                api.prevent_exit();
            }
        }
        // macOS Dock 图标被点击且当前无可见窗口（home/sync 均处于 hide 状态）：唤出 home。
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

/// 占位：真实插件（autostart/notification/single-instance/updater）在 tauri.conf.json
/// 声明并在此链式 `.plugin(...)`。为保持本函数在无这些 crate 时可编译，返回一个 no-op。
/// 打包时替换为实际插件注册。
fn tauri_plugin_shell_stub() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("lingxi-noop").build()
}
