//! 同步引擎子系统（文档 §11.6）。
//!
//! - `rclone_config`：生成 rclone `azureblob` remote 配置（含 sas_url）。纯字符串逻辑，可测。
//! - `engine`：构造 `rclone bisync` 命令行 + 解析退出码。命令构造纯逻辑可测；
//!   实际子进程 spawn 在 app 层。
//! - `location`：严格空目录校验与同卷目录迁移（纯文件系统逻辑，可测）。
//! - `poller`：轮询 `/api/cloud/list` 做快照 diff 发现远端变更。纯 diff 逻辑可测。
//! - `watcher`（app feature）：`notify` crate 本地 fs 监听。

pub mod engine;
pub mod location;
pub mod poller;
pub mod rclone_config;

#[cfg(feature = "app")]
pub mod watcher;
