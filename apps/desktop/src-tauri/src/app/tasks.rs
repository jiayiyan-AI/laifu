//! 常驻后台 task：JWT 续期守护 + SAS 刷新/sync 编排。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, watch, Mutex};

use crate::auth::keychain;
use crate::auth::keychain::StoredCredential;
use crate::auth::refresh::{self, RefreshDecision};
use crate::contracts::CloudWriteSas;
use crate::gateway::GatewayError;
use crate::sas::SasCache;
use crate::state::{AuthState, SyncState, TriggerGate};
use crate::sync::engine::{self, BisyncOutcome, BisyncPlan};
use crate::sync::watcher;
use crate::sync::{poller, rclone_config};

use super::core::{config_dir, AppCore, SyncControl};

/// JWT 续期守护：每 24h 检查一次，进入续期窗口则调 refresh-token。
/// 续期 401（token_version 被 bump/超宽限）→ 清凭据回 Unauthed。
pub(super) async fn spawn_refresh_guard(core: Arc<AppCore>) {
    loop {
        tokio::time::sleep(Duration::from_secs(24 * 3600)).await;

        let (jwt, expires_at) = {
            let auth = core.auth.lock().await;
            match &*auth {
                AuthState::Authed { jwt, expires_at } => (jwt.clone(), expires_at.clone()),
                AuthState::Unauthed => continue,
            }
        };

        if refresh::decide_from_iso(&expires_at, chrono::Utc::now()) == RefreshDecision::Fresh {
            continue;
        }

        match core.gateway.refresh_token(&jwt).await {
            Ok(tok) => {
                let _ = keychain::store(&StoredCredential {
                    jwt: tok.token.clone(),
                    expires_at: tok.expires_at.clone(),
                });
                let mut auth = core.auth.lock().await;
                *auth = auth.refreshed(tok);
            }
            Err(GatewayError::Unauthorized(_)) => {
                // 被吊销或超宽限：清凭据，要求重登。
                let _ = keychain::clear();
                *core.auth.lock().await = AuthState::Unauthed;
            }
            Err(_) => { /* 网络等瞬时错误：下轮再试 */ }
        }
    }
}

/// SAS 刷新与同步编排常驻 task。
///
/// **监督者**：订阅 `sync_dir` watch 通道。等到 Authed 且已配置目录后起一轮同步会话；
/// 用户在 Settings 换目录时，watch 变更让当前会话优雅收尾（旧 watcher/poller 停），
/// 再以新目录重起会话——无需重启整个 App。
pub(super) async fn spawn_sync_orchestrator(core: Arc<AppCore>) {
    let mut dir_rx = core.sync_dir_tx.subscribe();
    let Some(mut control_rx) = core.take_sync_control_receiver().await else {
        eprintln!("[sync] control receiver already taken");
        return;
    };

    // 会话无关的公共资源：工作目录 + SAS 缓存，跨目录切换复用（SAS 只与账号绑定）。
    // 与 config.json 共用 `~/.laifu/`，本地数据统一收拢一处。
    let work_dir = config_dir().to_path_buf();
    let _ = std::fs::create_dir_all(&work_dir);
    let config_path = work_dir.join("rclone.conf");
    let cache_path = work_dir.join("_cloud_sas.json");
    let rclone_bin = rclone_bin_path();

    // SasCache 包 Arc<Mutex>：run_sync_once 的 refresh 闭包按引用捕获会触发 FnMut 借用冲突，
    // 故捕获 Arc 克隆、async 块内 lock。jwt_provider 每次从 keychain 取最新 JWT（续期守护滚动更新）。
    let sas_cache = Arc::new(Mutex::new(SasCache::new(
        core.gateway.clone(),
        Box::new(|| {
            keychain::load()
                .ok()
                .flatten()
                .map(|c| c.jwt)
                .unwrap_or_default()
        }),
        &cache_path,
    )));

    loop {
        // 等待进入 Authed 且已配置同步目录。dir 变更或每 5s 唤醒一次重判。
        let local_dir: PathBuf = loop {
            let dir = dir_rx.borrow().clone();
            if let Some(dir) = dir {
                if core.auth.lock().await.is_authed() {
                    break PathBuf::from(dir);
                }
            }
            tokio::select! {
                _ = dir_rx.changed() => {}
                _ = tokio::time::sleep(Duration::from_secs(5)) => {}
            }
        };

        // 跑一轮会话；返回即代表目录已变更（或通道关闭），回到顶部以新目录重起。
        run_sync_session(
            &core,
            &local_dir,
            &config_path,
            &rclone_bin,
            sas_cache.clone(),
            &mut dir_rx,
            &mut control_rx,
        )
        .await;
    }
}

/// 单次同步会话：针对固定 `local_dir` 起 watcher + poller + 编排主循环，
/// 直到 `dir_rx` 报告同步目录变更才返回（此时旧 watcher guard / poller task 均被回收）。
async fn run_sync_session(
    core: &Arc<AppCore>,
    local_dir: &Path,
    config_path: &Path,
    rclone_bin: &Path,
    sas_cache: Arc<Mutex<SasCache>>,
    dir_rx: &mut watch::Receiver<Option<String>>,
    control_rx: &mut mpsc::Receiver<SyncControl>,
) {
    // 触发汇流通道：watcher(fs) + poller(远端轮询) → 编排主循环。
    let (trig_tx, mut trig_rx) = tokio::sync::mpsc::channel::<()>(8);

    // ① 本地 fs 监听：watcher 用 std mpsc，起桥接线程转发到 tokio 通道。
    //    _watcher_guard 必须在本会话生命周期内持有——drop（函数返回）即停监听。
    let _watcher_guard = match watcher::watch(local_dir) {
        Ok((w, rx)) => {
            let tx = trig_tx.clone();
            std::thread::spawn(move || {
                while rx.recv().is_ok() {
                    if tx.blocking_send(()).is_err() {
                        break; // 编排端已退出
                    }
                }
            });
            Some(w)
        }
        Err(e) => {
            eprintln!("[sync] fs watch 启动失败，降级为纯轮询: {e}");
            None
        }
    };

    // ② 远端轮询：定时列 blob，快照 diff 有变更即触发（发现 agent 的远端改动）。
    //    task 句柄在会话结束时 abort，避免旧目录的轮询泄漏到下一会话。
    let poller_task = {
        let tx = trig_tx.clone();
        let gw = core.gateway.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(45));
            let mut prev = poller::Snapshot::default();
            loop {
                interval.tick().await;
                let jwt = keychain::load()
                    .ok()
                    .flatten()
                    .map(|c| c.jwt)
                    .unwrap_or_default();
                if jwt.is_empty() {
                    continue; // 未登录/凭据被清，跳过本轮
                }
                let prefix = format!("{}/", rclone_config::SYNC_SUBDIR);
                match gw.cloud_list(&jwt, &prefix).await {
                    Ok(list) => {
                        let next = poller::Snapshot::from_list(&list);
                        if poller::diff(&prev, &next).has_changes() {
                            let _ = tx.send(()).await;
                        }
                        prev = next;
                    }
                    Err(_) => { /* 瞬时错误：下轮再试 */ }
                }
            }
        })
    };

    // 首次触发：新会话立即跑一轮 bisync。目录两端都还没有文件时，rclone 的 `--resync`
    // 会留下空基线，后续增量同步仍会拒绝；此时保持 `--resync` 直到出现首个文件。
    let _ = trig_tx.try_send(());

    // ③ 编排主循环：TriggerGate 保证同一时刻只一个 bisync；跑中来的触发标 dirty，跑完补一轮。
    //    与 dir_rx.changed() 竞争：目录一变，收尾退出让监督者以新目录重起。
    let mut gate = TriggerGate::default();
    let mut needs_initial_resync = true;
    loop {
        tokio::select! {
            _ = dir_rx.changed() => break,
            control = control_rx.recv() => {
                let Some(SyncControl::Flush(reply)) = control else {
                    break;
                };
                if needs_initial_resync {
                    let _ = reply.send(Err("同步正在建立初始基线，请完成后再修改同步目录".into()));
                    continue;
                }
                let run_guard = core.sync_run_lock.read().await;
                *core.sync.lock().await = SyncState::Syncing;
                let outcome = run_one_sync(
                    sas_cache.clone(),
                    local_dir,
                    config_path,
                    rclone_bin,
                    needs_initial_resync,
                )
                .await;
                advance_initial_resync(&mut needs_initial_resync, &outcome, local_dir);
                drop(run_guard);
                let _ = reply.send(record_sync_outcome(core, &outcome).await);
            },
            recv = trig_rx.recv() => {
                if recv.is_none() {
                    break;
                }
                if !gate.on_trigger() {
                    continue; // 已在跑，已标 dirty
                }
                loop {
                    // 目录操作先申请写锁；其一旦排队，tokio 的公平 RwLock 不再让新读锁插队。
                    // 这里在获取读锁前后都检查 watch 版本，确保已暂停的旧会话不会再起一轮 rclone。
                    if dir_rx.has_changed().unwrap_or(true) {
                        break;
                    }
                    let run_guard = core.sync_run_lock.read().await;
                    if dir_rx.has_changed().unwrap_or(true) {
                        drop(run_guard);
                        break;
                    }
                    *core.sync.lock().await = SyncState::Syncing;
                    let outcome = run_one_sync(
                        sas_cache.clone(),
                        local_dir,
                        config_path,
                        rclone_bin,
                        needs_initial_resync,
                    )
                    .await;
                    advance_initial_resync(&mut needs_initial_resync, &outcome, local_dir);
                    drop(run_guard);

                    let _ = record_sync_outcome(core, &outcome).await;

                    if !gate.on_finish() {
                        break; // 期间无新触发
                    }
                }
            }
        }
    }

    poller_task.abort();
}

/// rclone bisync 不能把两个空目录的 `--resync` 产物当作增量基线。只有首次 resync
/// 已经同步出至少一个文件后，才允许之后的触发去掉 `--resync`。
fn advance_initial_resync(
    needs_initial_resync: &mut bool,
    outcome: &Result<BisyncOutcome, String>,
    local_dir: &Path,
) {
    if !*needs_initial_resync || !matches!(outcome, Ok(BisyncOutcome::Success)) {
        return;
    }

    match directory_contains_file(local_dir) {
        Ok(has_file) => *needs_initial_resync = !has_file,
        Err(error) => eprintln!("[sync] 无法确认首次同步基线是否建立，继续使用 --resync: {error}"),
    }
}

/// rclone 的 Azure Blob 后端不持久化空目录；仅有空子目录也不能形成有效 bisync 基线。
fn directory_contains_file(dir: &Path) -> std::io::Result<bool> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_file() {
            return Ok(true);
        }
        if file_type.is_dir() && directory_contains_file(&entry.path())? {
            return Ok(true);
        }
    }
    Ok(false)
}
/// 将一次 bisync 结果同步到 UI 状态；控制面调用者还会收到同一份成功/失败结果。
async fn record_sync_outcome(
    core: &AppCore,
    outcome: &Result<BisyncOutcome, String>,
) -> Result<(), String> {
    let (state, result) = match outcome {
        Ok(BisyncOutcome::Success) => (SyncState::Idle, Ok(())),
        Ok(BisyncOutcome::NeedsResync) => {
            let message = "同步基线丢失，需重建（--resync）".to_string();
            (SyncState::NeedsAttention(message.clone()), Err(message))
        }
        Ok(BisyncOutcome::SasExpired) => {
            let message = "SAS 刷新后仍鉴权失败".to_string();
            (SyncState::Error(message.clone()), Err(message))
        }
        // 走到这里说明 `should_force` 已判定它**不是**误报（规模大或含删除），
        // 即这道检查真的抓到了异常（如 DST 全盘时间戳漂移）——正是它该响的时候。
        // 停下让用户确认，不要自作主张覆盖任何一边。
        Ok(BisyncOutcome::AllFilesChanged { path1, path2 }) => {
            let message = format!(
                "本地或云端文件全部发生变化（本地改 {} 删 {}，云端改 {} 删 {}），\
                 已暂停同步以防误覆盖，请确认后再继续",
                path2.modified, path2.deleted, path1.modified, path1.deleted
            );
            (SyncState::NeedsAttention(message.clone()), Err(message))
        }
        Ok(BisyncOutcome::Failed(code)) => {
            let message = format!("bisync 失败（退出码 {code}）");
            (SyncState::Error(message.clone()), Err(message))
        }
        Err(error) => (SyncState::Error(error.clone()), Err(error.clone())),
    };
    *core.sync.lock().await = state;
    result
}

/// 单次同步：确保 SAS 新鲜 + 写 rclone config，然后跑 `run_sync_once`（含 403 重试）。
async fn run_one_sync(
    sas_cache: Arc<Mutex<SasCache>>,
    local_dir: &Path,
    config_path: &Path,
    rclone_bin: &Path,
    first_run: bool,
) -> Result<BisyncOutcome, String> {
    // 1. 拿新鲜 SAS 并写入 rclone config 的 sas_url。
    let sas = sas_cache
        .lock()
        .await
        .get()
        .await
        .map_err(|e| e.to_string())?;
    write_rclone_config(config_path, &sas).map_err(|e| e.to_string())?;
    let plan = BisyncPlan::new(&sas, local_dir, config_path, first_run);

    // 2. 跑（403 → force_refresh 重写 config → 重跑一次）。闭包捕获 Arc/PathBuf 克隆，避免借用冲突。
    let rclone = rclone_bin.to_path_buf();
    let cfg = config_path.to_path_buf();
    let sc = sas_cache.clone();
    engine::run_sync_once::<String, _, _, _, _>(
        &plan,
        move |p| {
            let rclone = rclone.clone();
            async move {
                engine::run_bisync(&rclone, &p)
                    .await
                    .map_err(|e| format!("rclone 启动/运行失败: {e}"))
            }
        },
        move || {
            let sc = sc.clone();
            let cfg = cfg.clone();
            async move {
                let sas = sc
                    .lock()
                    .await
                    .force_refresh()
                    .await
                    .map_err(|e| e.to_string())?;
                write_rclone_config(&cfg, &sas).map_err(|e| e.to_string())
            }
        },
    )
    .await
}

/// 解析 rclone sidecar 二进制路径。优先级：
///   1. `LINGXI_RCLONE_BIN` 环境变量（任何情况都最高优先，用于临时指定）。
///   2. dev 构建（`debug_assertions`）：编译期 `CARGO_MANIFEST_DIR` + target-triple 拼出
///      仓库内 `binaries/rclone-<triple>[.exe]`，免去每次手带 env（`scripts/fetch-rclone.sh` 落此名）。
///   3. 打包运行：sidecar 与主程序同目录，裸名 `rclone`。
pub(super) fn rclone_bin_path() -> PathBuf {
    if let Ok(p) = std::env::var("LINGXI_RCLONE_BIN") {
        return PathBuf::from(p);
    }

    // dev 兜底：指向仓库内已 fetch 的 sidecar。仅 debug 构建启用，release 打包不受影响。
    #[cfg(debug_assertions)]
    {
        let ext = if cfg!(target_os = "windows") {
            ".exe"
        } else {
            ""
        };
        let dev_sidecar = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("rclone-{}{}", DEV_RCLONE_TARGET_TRIPLE, ext));
        if dev_sidecar.is_file() {
            return dev_sidecar;
        }
    }

    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("rclone")))
        .unwrap_or_else(|| PathBuf::from("rclone"))
}

/// dev sidecar 的 target-triple（对齐 `scripts/fetch-rclone.mjs` 命名）。
/// 支持 Apple Silicon macOS，以及 aarch64 / x86_64 Windows（不考虑 Linux 与 Intel Mac）。
#[cfg(debug_assertions)]
const DEV_RCLONE_TARGET_TRIPLE: &str = {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        "aarch64-pc-windows-msvc"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else {
        panic!("Laifu desktop supports Apple Silicon macOS and Windows only")
    }
};

/// 写 rclone 配置文件（含 sas_url，不含账户密钥）。每次 SAS 刷新后重写。
fn write_rclone_config(path: &Path, sas: &CloudWriteSas) -> std::io::Result<()> {
    std::fs::write(path, rclone_config::render(sas))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// rclone_bin_path 的两条行为在一个测试内串行覆盖，避免并发测试争用进程级
    /// `LINGXI_RCLONE_BIN`（env 是进程全局，拆两个 #[test] 并发跑会相互污染 → 偶发失败）。
    #[test]
    fn rclone_bin_path_resolution() {
        // ① env 覆盖优先级最高：任何构建下都原样采用。
        std::env::set_var("LINGXI_RCLONE_BIN", "/tmp/custom-rclone");
        assert_eq!(rclone_bin_path(), PathBuf::from("/tmp/custom-rclone"));

        // ② dev 构建、无 env 覆盖时，解析到仓库内已 fetch 的 sidecar。
        //    这是"免 LINGXI_RCLONE_BIN 前缀"这一行为的实证：sidecar 就位则 dev 零配置可用。
        std::env::remove_var("LINGXI_RCLONE_BIN");
        let ext = if cfg!(target_os = "windows") {
            ".exe"
        } else {
            ""
        };
        let expected = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("rclone-{DEV_RCLONE_TARGET_TRIPLE}{ext}"));
        let got = rclone_bin_path();
        assert_eq!(got, expected, "dev 应指向仓库内 sidecar，免手带 env");
        assert!(
            got.is_file(),
            "sidecar 未就位于 {got:?}；先跑 scripts/fetch-rclone.sh"
        );
    }

    #[test]
    fn initial_resync_stays_enabled_until_a_file_exists() {
        let temp = tempfile::tempdir().unwrap();
        assert!(!directory_contains_file(temp.path()).unwrap());

        let nested = temp.path().join("empty");
        std::fs::create_dir(&nested).unwrap();
        assert!(!directory_contains_file(temp.path()).unwrap());

        std::fs::write(nested.join("first.txt"), "content").unwrap();
        assert!(directory_contains_file(temp.path()).unwrap());
    }

    #[test]
    fn initial_resync_completes_only_after_successful_file_sync() {
        let temp = tempfile::tempdir().unwrap();
        let mut needs_resync = true;
        let success = Ok(BisyncOutcome::Success);

        advance_initial_resync(&mut needs_resync, &success, temp.path());
        assert!(needs_resync);

        std::fs::write(temp.path().join("first.txt"), "content").unwrap();
        advance_initial_resync(&mut needs_resync, &success, temp.path());
        assert!(!needs_resync);
    }
}
