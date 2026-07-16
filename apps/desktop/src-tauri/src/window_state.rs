//! 窗口 size/position 持久化（记住上次关闭时的窗口大小和位置）。
//!
//! 不依赖第三方插件：Tauri `WebviewWindow` 自带 `on_window_event` + `outer_size`/
//! `outer_position`/`set_size`/`set_position`，够用。落盘走物理像素（`PhysicalSize`/
//! `PhysicalPosition`），跨显示器缩放不失真；`WindowGeometry` 与实际 IO 分离，纯逻辑可测。
//!
//! `app` feature 专属：路径由调用方传入（现为 `~/.laifu/window_state.json`，见 `app/core.rs`
//! `config_dir()`），本模块只做纯 IO + 序列化，便于用 tempdir 单测。

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

const STATE_FILE: &str = "window_state.json";

/// 单个窗口的物理像素几何信息。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowGeometry {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
}

/// 全部窗口的几何信息，按 label 索引。留 `HashMap` 便于按需增删窗口而不破坏旧存档。
pub type WindowStateMap = HashMap<String, WindowGeometry>;

fn state_path(config_dir: &Path) -> std::path::PathBuf {
    config_dir.join(STATE_FILE)
}

/// 读全部窗口几何信息；文件不存在或解析失败→返回空 map（不因坏文件卡死启动）。
pub fn load(config_dir: &Path) -> WindowStateMap {
    match std::fs::read(state_path(config_dir)) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => WindowStateMap::default(),
    }
}

/// 读某一个窗口的几何信息。
pub fn load_one(config_dir: &Path, label: &str) -> Option<WindowGeometry> {
    load(config_dir).get(label).copied()
}

/// 写入/更新某一个窗口的几何信息并落盘（原子覆盖：先写临时文件再 rename）。
/// 其它窗口已存的记录保留不动。
pub fn save_one(config_dir: &Path, label: &str, geometry: WindowGeometry) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    let mut map = load(config_dir);
    map.insert(label.to_string(), geometry);
    let json = serde_json::to_vec_pretty(&map).map_err(std::io::Error::other)?;
    let final_path = state_path(config_dir);
    let tmp_path = final_path.with_extension("json.tmp");
    std::fs::write(&tmp_path, json)?;
    std::fs::rename(&tmp_path, &final_path)
}

/// 删除一个已废弃窗口的几何记录，保留其它窗口数据。
pub fn remove_one(config_dir: &Path, label: &str) -> std::io::Result<()> {
    let mut map = load(config_dir);
    if map.remove(label).is_none() {
        return Ok(());
    }
    std::fs::create_dir_all(config_dir)?;
    let json = serde_json::to_vec_pretty(&map).map_err(std::io::Error::other)?;
    let final_path = state_path(config_dir);
    let tmp_path = final_path.with_extension("json.tmp");
    std::fs::write(&tmp_path, json)?;
    std::fs::rename(&tmp_path, &final_path)
}

/// 判断存档几何是否至少部分落在当前显示器范围内。
///
/// 多显示器场景：存档时窗口在副屏，之后拔掉副屏（或换了台没有那块屏幕的机器）重开——
/// 存档坐标会落在任何当前显示器范围之外，此时直接套用只会把窗口开到看不见的地方。
/// `monitors` 是当前系统各显示器的物理像素 `(x, y, width, height)`；查询失败/为空时
/// 默认信任存档（不能因为查询失败误伤单显示器的正常场景）。
pub fn geometry_visible(geo: &WindowGeometry, monitors: &[(i32, i32, u32, u32)]) -> bool {
    if monitors.is_empty() {
        return true;
    }
    let (gx0, gy0) = (geo.x, geo.y);
    let (gx1, gy1) = (geo.x + geo.width as i32, geo.y + geo.height as i32);
    monitors.iter().any(|&(mx, my, mw, mh)| {
        let (mx1, my1) = (mx + mw as i32, my + mh as i32);
        gx0 < mx1 && gx1 > mx && gy0 < my1 && gy1 > my
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geo(w: u32, h: u32, x: i32, y: i32) -> WindowGeometry {
        WindowGeometry {
            width: w,
            height: h,
            x,
            y,
        }
    }

    #[test]
    fn load_missing_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load(dir.path()).is_empty());
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        save_one(dir.path(), "home", geo(1280, 800, 10, 20)).unwrap();
        assert_eq!(load_one(dir.path(), "home"), Some(geo(1280, 800, 10, 20)));
    }

    #[test]
    fn save_preserves_other_windows() {
        let dir = tempfile::tempdir().unwrap();
        save_one(dir.path(), "home", geo(1280, 800, 0, 0)).unwrap();
        save_one(dir.path(), "sync", geo(720, 520, 5, 5)).unwrap();
        assert_eq!(load_one(dir.path(), "home"), Some(geo(1280, 800, 0, 0)));
        assert_eq!(load_one(dir.path(), "sync"), Some(geo(720, 520, 5, 5)));
    }

    #[test]
    fn remove_one_only_deletes_requested_window() {
        let dir = tempfile::tempdir().unwrap();
        save_one(dir.path(), "home", geo(1280, 800, 0, 0)).unwrap();
        save_one(dir.path(), "sync", geo(720, 520, 5, 5)).unwrap();
        save_one(dir.path(), "settings", geo(720, 520, 10, 10)).unwrap();

        remove_one(dir.path(), "sync").unwrap();

        assert_eq!(load_one(dir.path(), "sync"), None);
        assert_eq!(load_one(dir.path(), "home"), Some(geo(1280, 800, 0, 0)));
        assert_eq!(load_one(dir.path(), "settings"), Some(geo(720, 520, 10, 10)));
    }

    #[test]
    fn save_overwrites_same_window() {
        let dir = tempfile::tempdir().unwrap();
        save_one(dir.path(), "home", geo(1280, 800, 0, 0)).unwrap();
        save_one(dir.path(), "home", geo(1000, 700, 3, 4)).unwrap();
        assert_eq!(load_one(dir.path(), "home"), Some(geo(1000, 700, 3, 4)));
    }

    #[test]
    fn load_corrupt_file_returns_empty() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(STATE_FILE), b"{not json").unwrap();
        assert!(load(dir.path()).is_empty());
    }

    #[test]
    fn load_one_missing_label_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        save_one(dir.path(), "home", geo(1280, 800, 0, 0)).unwrap();
        assert_eq!(load_one(dir.path(), "sync"), None);
    }

    #[test]
    fn geometry_visible_empty_monitors_trusts_archive() {
        assert!(geometry_visible(&geo(1280, 800, -5000, -5000), &[]));
    }

    #[test]
    fn geometry_visible_within_primary_monitor() {
        let monitors = [(0, 0, 2560, 1440)];
        assert!(geometry_visible(&geo(1280, 800, 100, 100), &monitors));
    }

    #[test]
    fn geometry_visible_partially_overlaps_secondary_monitor() {
        // 副屏挂在主屏右侧（x 从 2560 开始）；窗口跨界但与副屏有重叠，仍算可见。
        let monitors = [(0, 0, 2560, 1440), (2560, 0, 1920, 1080)];
        assert!(geometry_visible(&geo(1280, 800, 2000, 100), &monitors));
    }

    #[test]
    fn geometry_invisible_when_disconnected_monitor_missing() {
        // 存档窗口曾在副屏（x=2560 起），副屏已拔掉，只剩主屏 0..2560 —— 应判定不可见。
        let monitors = [(0, 0, 2560, 1440)];
        assert!(!geometry_visible(&geo(1280, 800, 2600, 100), &monitors));
    }
}
