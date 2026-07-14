//! app 全局状态（`AppCore`）+ 本地数据目录约定。

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use tokio::sync::{mpsc, oneshot, watch, Mutex, RwLock};

use crate::auth::keychain;
use crate::gateway::GatewayClient;
use crate::state::{AuthState, SyncState};

/// gateway base URL。默认按编译期渠道（dev/canary/stable，见 `crate::channel`）取值；
/// `LINGXI_GATEWAY_URL` env 可临时覆盖（本地调试时指向别的环境）。
pub(super) fn gateway_base_url() -> String {
    std::env::var("LINGXI_GATEWAY_URL")
        .unwrap_or_else(|_| crate::channel::gateway_base_url_default().to_string())
}

/// 本地数据统一收拢目录：系统 home 目录（macOS `/Users/x`、Windows `C:\Users\x`）下的
/// 渠道专属子目录（`crate::channel::data_dir_components()`：stable=`~/.laifu/`（不变，
/// 老用户装机路径不受影响）；canary/dev 嵌套其下——`~/.laifu/canary-data/` /
/// `~/.laifu/dev-data/`）。放 config.json（同步目录选择）+ rclone.conf + SAS 缓存，
/// 三渠道各自隔离，互不覆盖。
/// 初始化不依赖运行时 `AppHandle`，`LazyLock` 声明即持有初始化器（规则 rs-lazylock）。
static LAIFU_HOME: LazyLock<PathBuf> = LazyLock::new(|| {
    let base = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    crate::channel::data_dir_components()
        .iter()
        .fold(base, |acc, component| acc.join(component))
});

/// 取本地数据目录（`~/.laifu/`）。
pub(super) fn config_dir() -> &'static Path {
    &LAIFU_HOME
}

/// Settings 在目录操作前请求编排器完成一次同步并返回确定结果。
pub(super) enum SyncControl {
    Flush(oneshot::Sender<Result<(), String>>),
}

/// app 全局状态。
pub(super) struct AppCore {
    pub(super) gateway: GatewayClient,
    pub(super) auth: Mutex<AuthState>,
    pub(super) sync: Mutex<SyncState>,
    /// 用户选择的同步目录（None = 未配置）。用 watch 通道而非普通 Mutex：
    /// 编排器订阅它，用户在 Settings 换目录时能**热重启**同步会话（旧 watcher 停、
    /// 新目录起），而不必重启整个 App。
    pub(super) sync_dir_tx: watch::Sender<Option<String>>,
    /// 串行化目录切换与物理移动，避免两个设置请求交错写入配置。
    pub(super) sync_directory_operation: Mutex<()>,
    /// 每次 rclone 运行持有读锁；目录操作拿写锁，等待当前同步结束并阻止旧路径再启动。
    pub(super) sync_run_lock: RwLock<()>,
    /// Settings → 编排器的有确认控制面；普通 fs/poller 触发仍走会话私有 channel。
    sync_control_tx: mpsc::Sender<SyncControl>,
    sync_control_rx: Mutex<Option<mpsc::Receiver<SyncControl>>>,
}

impl AppCore {
    pub(super) fn new() -> Self {
        let (sync_control_tx, sync_control_rx) = mpsc::channel(1);
        Self {
            gateway: GatewayClient::new(gateway_base_url()),
            auth: Mutex::new(AuthState::Unauthed),
            sync: Mutex::new(SyncState::Idle),
            sync_dir_tx: watch::channel(None).0,
            sync_directory_operation: Mutex::new(()),
            sync_run_lock: RwLock::new(()),
            sync_control_tx,
            sync_control_rx: Mutex::new(Some(sync_control_rx)),
        }
    }

    /// 当前同步目录快照（无订阅语义，仅读一次）。
    pub(super) fn sync_dir(&self) -> Option<String> {
        self.sync_dir_tx.borrow().clone()
    }

    /// 请求当前同步会话立即完成一轮 bisync；失败时目录操作不得继续。
    pub(super) async fn flush_sync(&self) -> Result<(), String> {
        let (reply_tx, reply_rx) = oneshot::channel();
        self.sync_control_tx
            .send(SyncControl::Flush(reply_tx))
            .await
            .map_err(|_| "同步编排器未运行，无法安全修改同步目录".to_string())?;
        reply_rx
            .await
            .map_err(|_| "同步编排器在完成目录操作前退出".to_string())?
    }

    /// 编排器在启动时独占取得控制面 receiver。
    pub(super) async fn take_sync_control_receiver(&self) -> Option<mpsc::Receiver<SyncControl>> {
        self.sync_control_rx.lock().await.take()
    }

    /// 启动时尝试从 keychain 恢复凭据 → 若在则进 Authed。
    pub(super) async fn restore_from_keychain(&self) {
        if let Ok(Some(cred)) = keychain::load() {
            *self.auth.lock().await = AuthState::Authed {
                jwt: cred.jwt,
                expires_at: cred.expires_at,
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    #[tokio::test]
    async fn flush_sync_waits_for_orchestrator_result() {
        let core = Arc::new(AppCore::new());
        let mut receiver = core.take_sync_control_receiver().await.unwrap();
        let request_core = core.clone();
        let request = tokio::spawn(async move { request_core.flush_sync().await });

        let Some(SyncControl::Flush(reply)) = receiver.recv().await else {
            panic!("missing flush request");
        };
        reply.send(Ok(())).unwrap();

        assert_eq!(request.await.unwrap(), Ok(()));
        assert!(core.take_sync_control_receiver().await.is_none());
    }
}
