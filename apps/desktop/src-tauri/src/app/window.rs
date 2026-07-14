//! 窗口 label 常量 + size/position 记忆（建窗/关窗时的几何持久化）。

use crate::window_state;

use super::core::config_dir;

/// 登录窗口 label，供 on_navigation 回调用 `get_webview_window` 取回。
pub(super) const LOGIN_WINDOW: &str = "login";

/// 首页窗口 label：桌面 app 启动即展示的 web 首页（虚拟桌面等业务 UI，走自己的
/// httpOnly session cookie 鉴权，与同步盘的 device JWT 完全独立）。
pub(super) const HOME_WINDOW: &str = "home";

/// 同步盘窗口 label：原生 Login/Sync/Settings 壳（现有 dist 前端）。不再是启动默认视图，
/// 经系统菜单「同步盘 → 打开同步盘」按需唤出。
pub(super) const SYNC_WINDOW: &str = "sync";

/// 挂"后台常驻"行为：`home`/`sync` 这两个主窗口点红色关闭按钮时不应退出整个 app
/// （同步编排还要在后台跑），改为拦截 `CloseRequested`——阻止真正销毁窗口，先把当前
/// `inner_size`/`outer_position` 落盘（`~/.laifu/window_state.json`，下次建同 label
/// 窗口据此恢复），再 `hide()`。真正退出只能走托盘菜单「退出」（`app.exit(0)`），那里
/// 走的是进程级 `RunEvent::ExitRequested`，不经过这个逐窗口的 `CloseRequested`。
///
/// 只在 `CloseRequested` 这一刻查询几何再落盘，不必额外挂 `Resized`/`Moved`——足够覆盖
/// "关闭前的最终大小/位置"，且窗口隐藏后不会被用户拖拽。
pub(super) fn attach_hide_on_close(win: &tauri::WebviewWindow) {
    let label = win.label().to_string();
    let win_evt = win.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let (Ok(size), Ok(pos)) = (win_evt.inner_size(), win_evt.outer_position()) {
                let geometry = window_state::WindowGeometry {
                    width: size.width,
                    height: size.height,
                    x: pos.x,
                    y: pos.y,
                };
                let _ = window_state::save_one(config_dir(), &label, geometry);
            }
            let _ = win_evt.hide();
        }
    });
}

/// 建窗后按存档恢复 size/position。
///
/// 关键修复：`WebviewWindowBuilder::inner_size`/`position` 吃**逻辑像素**，而存档
/// （`attach_hide_on_close` 落盘的）是 `inner_size()`/`outer_position()` 读到的**物理像素**
/// ——直接把物理像素喂给建窗期的逻辑像素参数，会在 Retina/高 DPI 屏上把窗口开大
/// `scale_factor` 倍（2x scale 下面积变 4 倍，正是「尺寸偏大」的根因）。改为建窗后
/// 用 `set_size`/`set_position` 配 `PhysicalSize`/`PhysicalPosition`，与存档单位对齐、
/// 不经过任何隐式的逻辑↔物理换算。
///
/// 多显示器：存档坐标若已不落在任何当前显示器范围内（副屏被拔掉/换机器），放弃存档、
/// 保留 builder 给的默认尺寸与 OS 默认位置，避免窗口开到看不见的地方。
pub(super) fn apply_saved_geometry(win: &tauri::WebviewWindow, label: &str) {
    let Some(g) = window_state::load_one(config_dir(), label) else {
        return;
    };
    let monitors: Vec<(i32, i32, u32, u32)> = win
        .available_monitors()
        .map(|ms| {
            ms.iter()
                .map(|m| {
                    (
                        m.position().x,
                        m.position().y,
                        m.size().width,
                        m.size().height,
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    if !window_state::geometry_visible(&g, &monitors) {
        return;
    }
    let _ = win.set_size(tauri::PhysicalSize::new(g.width, g.height));
    let _ = win.set_position(tauri::PhysicalPosition::new(g.x, g.y));
}
