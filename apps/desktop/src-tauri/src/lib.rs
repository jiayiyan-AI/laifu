//! 来福桌面同步盘客户端核心逻辑（lib）。
//!
//! 分两层：
//!
//! **默认 feature（纯逻辑核心，`cargo test` 全覆盖，不依赖系统库）：**
//!   - [`channel`]   dev/canary/stable 三渠道默认值（gateway/home/login URL、scheme、keychain service、数据目录）
//!   - [`contracts`] wire 契约的 serde 镜像（对齐 `packages/shared/src/contracts.ts`）
//!   - [`gateway`]   gateway HTTP 客户端（device-token / refresh / sas / list）
//!   - [`sas`]       SAS 刷新缓存（Rust 重写 `sas_cache.py`）
//!   - [`auth::refresh`] JWT 续期判定（纯函数）
//!   - [`sync::rclone_config`] rclone 配置生成
//!   - [`sync::engine`] bisync 命令构造 + 退出码分类
//!   - [`sync::location`] 同步目录空目录校验与同卷原子迁移
//!   - [`sync::poller`] 远端快照 diff
//!   - [`state`]     认证/同步状态机类型 + 触发去抖
//!
//! **`app` feature（系统集成，打包桌面 app 时启用）：**
//!   - [`auth::keychain`] keyring 存储设备 JWT
//!   - [`sync::watcher`]  notify 本地 fs 监听
//!   - [`window_state`]   窗口 size/position 持久化（纯 IO，落 `~/.laifu/window_state.json`）
//!   - [`app`]            Tauri 装配 + commands
//!
//! 设计见 [`docs/desktop-app.md`](../../../../docs/desktop-app.md)。

pub mod auth;
pub mod channel;
pub mod contracts;
pub mod gateway;
pub mod persist;
pub mod sas;
pub mod state;
pub mod sync;

#[cfg(feature = "app")]
pub mod app;
#[cfg(feature = "app")]
pub mod window_state;

pub use contracts::{CloudFileItem, CloudListResponse, CloudWriteSas, TokenResponse};
pub use gateway::{GatewayClient, GatewayError};
pub use sas::SasCache;
pub use state::{AuthState, SyncState, TriggerGate};
