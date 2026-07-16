//! Desktop surface construction, visibility, and flyout placement.

use tauri::{Manager, PhysicalPosition, PhysicalSize, Rect};

use super::window::{apply_saved_geometry, attach_hide_on_close, FLYOUT_WINDOW, SETTINGS_WINDOW};

pub(super) const MAIN_TRAY_ID: &str = "main-tray";

const SETTINGS_SIZE: (f64, f64) = (720.0, 520.0);
const FLYOUT_SIZE: (f64, f64) = (380.0, 400.0);


#[derive(Debug, Clone, Copy)]
pub(super) enum FlyoutAnchor {
    Tray(Rect),
    SettingsFallback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PhysicalRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl PhysicalRect {
    fn right(self) -> i32 {
        self.x.saturating_add(self.width as i32)
    }

    fn bottom(self) -> i32 {
        self.y.saturating_add(self.height as i32)
    }

    fn center_x(self) -> i32 {
        self.x.saturating_add((self.width / 2) as i32)
    }

    fn center_y(self) -> i32 {
        self.y.saturating_add((self.height / 2) as i32)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Placement {
    x: i32,
    y: i32,
}

/// Shows and focuses the single settings window, creating it on first use.
pub(super) fn show_settings(app: &tauri::AppHandle) -> Result<(), String> {
    hide_flyout(app);

    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let window = tauri::WebviewWindowBuilder::new(
        app,
        SETTINGS_WINDOW,
        tauri::WebviewUrl::App("index.html#/settings-window".into()),
    )
    .title(format!("来福设置{}", crate::channel::display_suffix()))
    .inner_size(SETTINGS_SIZE.0, SETTINGS_SIZE.1)
    .resizable(false)
    .maximizable(false)
    .build()
    .map_err(|error| error.to_string())?;
    apply_saved_geometry(&window, SETTINGS_WINDOW);
    attach_hide_on_close(&window);
    Ok(())
}

/// Shows the flyout from the settings surface, preferring the current tray position.
#[tauri::command]
pub(super) fn show_sync_flyout_from_settings(app: tauri::AppHandle) -> Result<(), String> {
    let anchor = tray_rect(&app)
        .map(FlyoutAnchor::Tray)
        .unwrap_or(FlyoutAnchor::SettingsFallback);
    show_flyout(&app, anchor, false)
}

/// Shows or hides the flyout under the tray icon for a remote home action.
#[tauri::command]
pub(super) fn show_sync_flyout_from_home(app: tauri::AppHandle) -> Result<(), String> {
    let rect = tray_rect(&app).ok_or_else(|| "tray icon unavailable".to_string())?;
    show_flyout(&app, FlyoutAnchor::Tray(rect), true)
}

/// Opens settings from the bundled flyout UI.
#[tauri::command]
pub(super) fn show_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    show_settings(&app)
}

/// Opens settings from the remote home UI without exposing any local state.
#[tauri::command]
pub(super) fn show_settings_window_from_home(app: tauri::AppHandle) -> Result<(), String> {
    show_settings(&app)
}

/// Toggles the flyout for a tray click. The event rect is already physical pixels.
pub(super) fn toggle_flyout_from_tray(app: &tauri::AppHandle, rect: Rect) {
    if let Err(error) = show_flyout(app, FlyoutAnchor::Tray(rect), true) {
        eprintln!("[flyout] tray toggle failed: {error}");
    }
}

fn show_flyout(
    app: &tauri::AppHandle,
    anchor: FlyoutAnchor,
    toggle_visible: bool,
) -> Result<(), String> {
    let window = flyout_window(app)?;
    if toggle_visible && window.is_visible().map_err(|error| error.to_string())? {
        window.hide().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let anchor = resolve_anchor(app, anchor)?;
    let monitor = monitor_for_anchor(&window, anchor)?;
    let bounds = monitor_bounds(monitor);
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let placement = place_flyout(anchor, bounds, size);

    window
        .set_position(PhysicalPosition::new(placement.x, placement.y))
        .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

fn flyout_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(FLYOUT_WINDOW) {
        return Ok(window);
    }

    let window = tauri::WebviewWindowBuilder::new(
        app,
        FLYOUT_WINDOW,
        tauri::WebviewUrl::App("index.html#/flyout".into()),
    )
    .title("来福状态")
    .inner_size(FLYOUT_SIZE.0, FLYOUT_SIZE.1)
    .decorations(false)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .visible(false)
    .shadow(true)
    .transparent(true)
    .build()
    .map_err(|error| error.to_string())?;
    let on_blur = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Focused(false)) {
            let _ = on_blur.hide();
        }
    });
    Ok(window)
}

fn hide_flyout(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(FLYOUT_WINDOW) {
        let _ = window.hide();
    }
}

fn tray_rect(app: &tauri::AppHandle) -> Option<Rect> {
    app.tray_by_id(MAIN_TRAY_ID)
        .and_then(|tray| tray.rect().ok().flatten())
}

fn resolve_anchor(app: &tauri::AppHandle, anchor: FlyoutAnchor) -> Result<PhysicalRect, String> {
    match anchor {
        FlyoutAnchor::Tray(rect) => {
            let position = rect.position.to_physical::<i32>(1.0);
            let size = rect.size.to_physical::<u32>(1.0);
            Ok(PhysicalRect {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            })
        }
        FlyoutAnchor::SettingsFallback => settings_fallback_rect(app),
    }
}


fn settings_fallback_rect(app: &tauri::AppHandle) -> Result<PhysicalRect, String> {
    let settings = app
        .get_webview_window(SETTINGS_WINDOW)
        .ok_or_else(|| "settings window unavailable".to_string())?;
    let position = settings.outer_position().map_err(|error| error.to_string())?;
    let size = settings.outer_size().map_err(|error| error.to_string())?;
    Ok(PhysicalRect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

fn monitor_for_anchor(
    window: &tauri::WebviewWindow,
    anchor: PhysicalRect,
) -> Result<tauri::Monitor, String> {
    let monitors = window.available_monitors().map_err(|error| error.to_string())?;
    monitors
        .into_iter()
        .find(|monitor| contains(monitor_bounds(monitor.clone()), anchor.center_x(), anchor.center_y()))
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "no monitor available for flyout".to_string())
}

fn monitor_bounds(monitor: tauri::Monitor) -> PhysicalRect {
    PhysicalRect {
        x: monitor.position().x,
        y: monitor.position().y,
        width: monitor.size().width,
        height: monitor.size().height,
    }
}

fn contains(bounds: PhysicalRect, x: i32, y: i32) -> bool {
    x >= bounds.x && x < bounds.right() && y >= bounds.y && y < bounds.bottom()
}

fn place_flyout(anchor: PhysicalRect, bounds: PhysicalRect, size: PhysicalSize<u32>) -> Placement {
    let edge = 24;
    let near_top = anchor.y.saturating_sub(bounds.y) <= edge;
    let near_bottom = bounds.bottom().saturating_sub(anchor.bottom()) <= edge;
    let near_left = anchor.x.saturating_sub(bounds.x) <= edge;
    let near_right = bounds.right().saturating_sub(anchor.right()) <= edge;
    let width = size.width as i32;
    let height = size.height as i32;

    let (x, y) = if near_top {
        (anchor.center_x() - width / 2, anchor.bottom())
    } else if near_bottom {
        (anchor.center_x() - width / 2, anchor.y - height)
    } else if near_left {
        (anchor.right(), anchor.center_y() - height / 2)
    } else if near_right {
        (anchor.x - width, anchor.center_y() - height / 2)
    } else {
        (anchor.center_x() - width / 2, anchor.y - height)
    };

    Placement {
        x: clamp(x, bounds.x, bounds.right().saturating_sub(width)),
        y: clamp(y, bounds.y, bounds.bottom().saturating_sub(height)),
    }
}

fn clamp(value: i32, minimum: i32, maximum: i32) -> i32 {
    value.clamp(minimum, maximum.max(minimum))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: PhysicalRect = PhysicalRect { x: 0, y: 0, width: 1920, height: 1080 };
    const FLYOUT: PhysicalSize<u32> = PhysicalSize::new(400, 400);

    fn rect(x: i32, y: i32, width: u32, height: u32) -> PhysicalRect {
        PhysicalRect { x, y, width, height }
    }

    #[test]
    fn top_anchor_expands_downward() {
        assert_eq!(place_flyout(rect(1500, 0, 24, 24), SCREEN, FLYOUT), Placement { x: 1312, y: 24 });
    }

    #[test]
    fn bottom_anchor_expands_upward() {
        assert_eq!(place_flyout(rect(1500, 1056, 24, 24), SCREEN, FLYOUT), Placement { x: 1312, y: 656 });
    }

    #[test]
    fn side_anchors_expand_toward_work_area() {
        assert_eq!(place_flyout(rect(0, 400, 24, 24), SCREEN, FLYOUT), Placement { x: 24, y: 212 });
        assert_eq!(place_flyout(rect(1896, 400, 24, 24), SCREEN, FLYOUT), Placement { x: 1496, y: 212 });
    }

    #[test]
    fn placement_clamps_at_screen_edges() {
        assert_eq!(place_flyout(rect(0, 0, 16, 16), SCREEN, FLYOUT), Placement { x: 0, y: 16 });
        assert_eq!(place_flyout(rect(1910, 1064, 10, 16), SCREEN, FLYOUT), Placement { x: 1520, y: 664 });
    }

    #[test]
    fn negative_coordinate_monitor_is_supported() {
        let secondary = rect(-1280, 0, 1280, 1024);
        assert_eq!(place_flyout(rect(-100, 1000, 24, 24), secondary, FLYOUT), Placement { x: -400, y: 600 });
    }

    #[test]
    fn clamp_never_places_outside_bounds() {
        assert_eq!(clamp(-50, 0, 100), 0);
        assert_eq!(clamp(150, 0, 100), 100);
    }
}
