//! 桌面 app 二进制入口。
//!
//! 真正的 Tauri 装配在 `app` feature 下（`lingxi_desktop::app::run()`），需完整
//! tauri 工具链 + 前端 dist + 系统 webkit。默认 feature（headless / CI 逻辑测试）
//! 下二进制不装配 GUI，仅打印提示，保证 `cargo build` 在无 GUI 依赖时也能过。

#[cfg(feature = "app")]
fn main() {
    lingxi_desktop::app::run();
}

#[cfg(not(feature = "app"))]
fn main() {
    eprintln!(
        "lingxi-desktop 逻辑核心已构建。GUI 需以 `--features app` 编译（要求 tauri 工具链 + 前端 dist）。"
    );
}
