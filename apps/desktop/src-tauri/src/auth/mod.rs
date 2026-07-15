//! 认证子系统：设备 JWT 的续期判定与（app feature 下的）keychain 存储。
//!
//! `refresh` 的判定逻辑是纯函数，可独立测试；实际 IO（调 gateway、写 keychain）
//! 由 `state`/`app` 层用 `GatewayClient` 与 keychain 驱动。

pub mod refresh;

#[cfg(feature = "app")]
pub mod keychain;
