//! rclone bisync 编排（文档 §11.6）。
//!
//! 命令行**构造**与退出码**判定**是纯逻辑（可测）；实际子进程 spawn / stdout 解析
//! 在 app 层用 `tokio::process` 驱动。分离让命令拼装与结果分类脱离 IO 可单测。

use std::future::Future;
use std::path::Path;

use super::rclone_config::remote_path;
use crate::contracts::CloudWriteSas;

/// bisync 一次运行的参数。
#[derive(Debug, Clone)]
pub struct BisyncPlan {
    /// 远端同步路径 `<remote>:<container>/<user_id>`。
    pub remote: String,
    /// 本地同步目录。
    pub local: String,
    /// rclone 配置文件路径（含 sas_url 的 remote 定义）。
    pub config_path: String,
    /// 首次运行需 `--resync` 建立基线；之后省略（文档 §11.6 步骤 2）。
    pub first_run: bool,
}

impl BisyncPlan {
    pub fn new(sas: &CloudWriteSas, local_dir: &Path, config_path: &Path, first_run: bool) -> Self {
        Self {
            remote: remote_path(sas),
            local: local_dir.to_string_lossy().into_owned(),
            config_path: config_path.to_string_lossy().into_owned(),
            first_run,
        }
    }

    /// 构造完整 rclone 参数向量（不含 `rclone` 二进制本身）。
    ///
    /// set-and-forget 组合（官方推荐，文档 §132/343）：
    /// `--resilient --recover --max-lock 2m --conflict-resolve newer --compare size,modtime`。
    /// 删除安全（§11.7）：`--max-delete 50`（bisync 语义下裸数字即百分比，默认 50%；显式写出以自证意图。注意非 `50%`——`%` 会被 rclone CLI 的 int 解析拒绝并 fatal）。
    pub fn to_args(&self) -> Vec<String> {
        let mut args = vec![
            "bisync".to_string(),
            self.remote.clone(),
            self.local.clone(),
            "--config".to_string(),
            self.config_path.clone(),
            "--resilient".to_string(),
            "--recover".to_string(),
            "--max-lock".to_string(),
            "2m".to_string(),
            "--conflict-resolve".to_string(),
            "newer".to_string(),
            "--compare".to_string(),
            "size,modtime".to_string(),
            "--max-delete".to_string(),
            "50".to_string(),
        ];
        if self.first_run {
            args.push("--resync".to_string());
        }
        args
    }
}

/// bisync 退出后的分类（文档 §11.6 步骤 5）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BisyncOutcome {
    /// 退出码 0：成功。
    Success,
    /// 检测到 403（SAS 过期/失效）：应 `SasCache::force_refresh()` 后重跑该次。
    SasExpired,
    /// bisync 要求 `--resync` 才能恢复（基线丢失/破损）：记录并提示用户。
    NeedsResync,
    /// 其它失败：退出码非 0 且不属上述。
    Failed(i32),
}

/// 从退出码 + stderr 文本判定结果。
///
/// rclone bisync 无专用 403 退出码（统一为通用错误码），故 403 从 stderr 文本识别；
/// "resync" 提示同理。判定顺序：成功 → 403 → 需 resync → 泛化失败。
pub fn classify(exit_code: i32, stderr: &str) -> BisyncOutcome {
    if exit_code == 0 {
        return BisyncOutcome::Success;
    }
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("403")
        || lower.contains("authenticationfailed")
        || lower.contains("authorizationfailure")
    {
        return BisyncOutcome::SasExpired;
    }
    if lower.contains("--resync")
        || lower.contains("run resync")
        || lower.contains("cannot find prior")
    {
        return BisyncOutcome::NeedsResync;
    }
    BisyncOutcome::Failed(exit_code)
}

/// 实际跑一次 rclone bisync 子进程（`app` feature；tokio::process 驱动）。
///
/// 用 `rclone_bin` 路径（sidecar 二进制）+ `plan.to_args()` spawn，捕获 stderr，
/// 用 [`classify`] 分类退出码。命令构造与分类均已单测覆盖；此函数是它们的 IO 外壳。
/// 需 rclone 二进制就位才能真跑；不就位时返回启动错误。
#[cfg(feature = "app")]
pub async fn run_bisync(
    rclone_bin: &std::path::Path,
    plan: &BisyncPlan,
) -> std::io::Result<BisyncOutcome> {
    let output = tokio::process::Command::new(rclone_bin)
        .args(plan.to_args())
        .output()
        .await?;
    let code = output.status.code().unwrap_or(-1);
    let stderr = String::from_utf8_lossy(&output.stderr);
    Ok(classify(code, &stderr))
}

/// 单次同步编排决策（文档 §11.6 步骤 5 的 403 重试语义）：
///
/// 跑一次 bisync；若结果为 [`BisyncOutcome::SasExpired`]（中途 403），调 `refresh`
/// 强制刷新 SAS + 重写 rclone config，然后**重跑一次**；仍失败则返回该次结果。
/// 其它结果（成功 / 需 resync / 泛化失败）直接返回，不重试。
///
/// runner 与 refresh 以 async 闭包注入，使该决策脱离子进程/HTTP IO 可单测。
/// 生产接线：runner = [`run_bisync`]，refresh = `SasCache::force_refresh` + 重写 config。
pub async fn run_sync_once<E, Run, RunFut, Refresh, RefreshFut>(
    plan: &BisyncPlan,
    mut runner: Run,
    mut refresh: Refresh,
) -> Result<BisyncOutcome, E>
where
    Run: FnMut(BisyncPlan) -> RunFut,
    RunFut: Future<Output = Result<BisyncOutcome, E>>,
    Refresh: FnMut() -> RefreshFut,
    RefreshFut: Future<Output = Result<(), E>>,
{
    let first = runner(plan.clone()).await?;
    if first != BisyncOutcome::SasExpired {
        return Ok(first);
    }
    // 403：刷新 SAS（force_refresh 会重写 config 的 sas_url），重跑一次。
    refresh().await?;
    runner(plan.clone()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn sample_sas() -> CloudWriteSas {
        CloudWriteSas {
            blob_endpoint: "https://a.blob.core.windows.net".into(),
            container: "laifu-cloud".into(),
            prefix: "u123/".into(),
            sas_token: "sig=x".into(),
            expires_at: "2026-07-09T00:15:00Z".into(),
        }
    }

    #[test]
    fn args_include_setandforget_flags() {
        let plan = BisyncPlan::new(
            &sample_sas(),
            &PathBuf::from("/home/me/laifu"),
            &PathBuf::from("/tmp/rclone.conf"),
            false,
        );
        let args = plan.to_args();
        assert_eq!(args[0], "bisync");
        assert_eq!(args[1], "laifu:laifu-cloud/u123/sync");
        assert_eq!(args[2], "/home/me/laifu");
        for flag in [
            "--resilient",
            "--recover",
            "--conflict-resolve",
            "newer",
            "--max-lock",
            "2m",
            "--compare",
            "size,modtime",
            "--max-delete",
            "50",
        ] {
            assert!(args.iter().any(|a| a == flag), "missing flag {flag}");
        }
        assert!(!args.contains(&"--resync".to_string()));
    }

    #[test]
    fn first_run_appends_resync() {
        let plan = BisyncPlan::new(
            &sample_sas(),
            &PathBuf::from("/l"),
            &PathBuf::from("/c"),
            true,
        );
        assert!(plan.to_args().contains(&"--resync".to_string()));
    }

    #[test]
    fn uses_remote_name_constant() {
        let plan = BisyncPlan::new(
            &sample_sas(),
            &PathBuf::from("/l"),
            &PathBuf::from("/c"),
            false,
        );
        assert!(plan
            .remote
            .starts_with(&format!("{}:", super::super::rclone_config::REMOTE_NAME)));
    }

    #[test]
    fn classify_success() {
        assert_eq!(classify(0, ""), BisyncOutcome::Success);
    }

    #[test]
    fn classify_403_as_sas_expired() {
        assert_eq!(
            classify(
                1,
                "ERROR: AuthenticationFailed 403 Server failed to authenticate"
            ),
            BisyncOutcome::SasExpired
        );
    }

    #[test]
    fn classify_resync_hint() {
        assert_eq!(
            classify(
                2,
                "Bisync critical error: cannot find prior listing, run resync"
            ),
            BisyncOutcome::NeedsResync
        );
    }

    #[test]
    fn classify_generic_failure() {
        assert_eq!(classify(7, "some other error"), BisyncOutcome::Failed(7));
    }

    #[test]
    fn classify_403_takes_priority_over_resync_text() {
        // 同时含 403 与 resync 字样时，优先按 SAS 过期处理（先刷新再重跑，可能就不需 resync）。
        assert_eq!(
            classify(1, "403 authorizationfailure; you may need --resync"),
            BisyncOutcome::SasExpired
        );
    }

    fn sample_plan() -> BisyncPlan {
        BisyncPlan::new(
            &sample_sas(),
            &PathBuf::from("/l"),
            &PathBuf::from("/c"),
            false,
        )
    }

    // run_sync_once 用一个共享计数器记录 runner/refresh 调用次数，验证重试语义。
    use std::cell::Cell;

    #[tokio::test]
    async fn sync_once_success_no_retry() {
        let runs = Cell::new(0);
        let refreshes = Cell::new(0);
        let out = run_sync_once::<(), _, _, _, _>(
            &sample_plan(),
            |_plan| {
                runs.set(runs.get() + 1);
                async { Ok(BisyncOutcome::Success) }
            },
            || {
                refreshes.set(refreshes.get() + 1);
                async { Ok(()) }
            },
        )
        .await
        .unwrap();
        assert_eq!(out, BisyncOutcome::Success);
        assert_eq!(runs.get(), 1, "success 不应重跑");
        assert_eq!(refreshes.get(), 0, "success 不应刷新 SAS");
    }

    #[tokio::test]
    async fn sync_once_403_refreshes_then_reruns_success() {
        let runs = Cell::new(0);
        let refreshes = Cell::new(0);
        let out = run_sync_once::<(), _, _, _, _>(
            &sample_plan(),
            |_plan| {
                runs.set(runs.get() + 1);
                let n = runs.get();
                async move {
                    // 首跑 403，刷新后二跑成功。
                    Ok(if n == 1 {
                        BisyncOutcome::SasExpired
                    } else {
                        BisyncOutcome::Success
                    })
                }
            },
            || {
                refreshes.set(refreshes.get() + 1);
                async { Ok(()) }
            },
        )
        .await
        .unwrap();
        assert_eq!(out, BisyncOutcome::Success);
        assert_eq!(runs.get(), 2, "403 后应恰好重跑一次");
        assert_eq!(refreshes.get(), 1, "重跑前应刷新一次 SAS");
    }

    #[tokio::test]
    async fn sync_once_403_twice_returns_second_result_no_third_run() {
        let runs = Cell::new(0);
        let refreshes = Cell::new(0);
        let out = run_sync_once::<(), _, _, _, _>(
            &sample_plan(),
            |_plan| {
                runs.set(runs.get() + 1);
                async { Ok(BisyncOutcome::SasExpired) }
            },
            || {
                refreshes.set(refreshes.get() + 1);
                async { Ok(()) }
            },
        )
        .await
        .unwrap();
        // 仍 403：返回第二次结果，不再无限重试（只重试一次）。
        assert_eq!(out, BisyncOutcome::SasExpired);
        assert_eq!(runs.get(), 2, "最多重跑一次，不无限重试");
        assert_eq!(refreshes.get(), 1);
    }

    #[tokio::test]
    async fn sync_once_refresh_error_propagates() {
        let out = run_sync_once::<&str, _, _, _, _>(
            &sample_plan(),
            |_plan| async { Ok(BisyncOutcome::SasExpired) },
            || async { Err("refresh failed") },
        )
        .await;
        assert_eq!(out, Err("refresh failed"));
    }

    #[tokio::test]
    async fn sync_once_runner_error_propagates_without_refresh() {
        let refreshes = Cell::new(0);
        let out = run_sync_once::<&str, _, _, _, _>(
            &sample_plan(),
            |_plan| async { Err("run failed") },
            || {
                refreshes.set(refreshes.get() + 1);
                async { Ok(()) }
            },
        )
        .await;
        assert_eq!(out, Err("run failed"));
        assert_eq!(refreshes.get(), 0, "首跑就报错不应触发刷新");
    }
}
