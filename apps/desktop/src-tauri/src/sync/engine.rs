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
    /// 仅由 [`run_sync_once`] 在确认 "all files were changed" 属误报后置位，
    /// 用于单次重跑；[`BisyncPlan::new`] 永远产出 `false`。
    ///
    /// **不要无条件置位**：rclone 的 `--force` 同时关掉 `excessDeletes`
    /// （即 `--max-delete` 删除保护），二者共用同一个 `if !opt.Force` 分支
    /// （见 `cmd/bisync/operations.go`）。放行条件见 [`should_force`]。
    pub force: bool,
}

impl BisyncPlan {
    pub fn new(sas: &CloudWriteSas, local_dir: &Path, config_path: &Path, first_run: bool) -> Self {
        Self {
            remote: remote_path(sas),
            local: local_dir.to_string_lossy().into_owned(),
            config_path: config_path.to_string_lossy().into_owned(),
            first_run,
            force: false,
        }
    }

    /// 同一 plan 的 `--force` 版本，用于 [`should_force`] 判定误报后的单次重跑。
    pub fn forced(&self) -> Self {
        Self {
            force: true,
            ..self.clone()
        }
    }

    /// 构造完整 rclone 参数向量（不含 `rclone` 二进制本身）。
    ///
    /// set-and-forget 组合（官方推荐，文档 §132/343）：
    /// `--resilient --recover --max-lock 2m --conflict-resolve newer --compare size,modtime`。
    /// 删除安全（§11.7）：`--max-delete 50`（bisync 语义下裸数字即百分比，默认 50%；显式写出以自证意图。注意非 `50%`——`%` 会被 rclone CLI 的 int 解析拒绝并 fatal）。
    ///
    /// `-v` + `--color NEVER` 是 [`classify`] 的**硬依赖**，不是调试便利：
    /// delta 摘要行（`Path2: 1 changes: 0 new, 1 modified, 0 deleted`）在 rclone 里是
    /// `fs.Infof`，默认 NOTICE 级别下根本不输出；其格式串又内嵌 ANSI 颜色，且实测走管道
    /// 时不会自动禁用。少任一个，[`parse_delta_summary`] 就取不到变更规模，
    /// "all files were changed" 只能 fail-safe 退化成 [`BisyncOutcome::Failed`]。
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
            "-v".to_string(),
            "--color".to_string(),
            "NEVER".to_string(),
        ];
        if self.first_run {
            args.push("--resync".to_string());
        }
        if self.force {
            args.push("--force".to_string());
        }
        args
    }
}

/// 一侧（Path1/Path2）本轮的变更规模，解析自 rclone 的 delta 摘要行。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DeltaSummary {
    pub new: u32,
    pub modified: u32,
    pub deleted: u32,
}

/// 「分母小到该判据无意义」的上限，见 [`should_force`]。
///
/// 取 3：同步盘只有 1~3 个文件时，「所有文件都变了」与「我改了我仅有的那个文件」
/// 是同一件事，rclone 无从区分，其结论不携带信息。再大就该让人来看一眼。
const TRIVIAL_DENOMINATOR: u32 = 3;

/// 是否可判定 "all files were changed" 属误报、从而用 `--force` 重跑一次。
///
/// 背景：这道检查是 rclone 的 **DST 检测器**——源码注释写明「找到一个没变的文件，
/// 就知道不是 DST 那种全盘时间戳漂移」，故它只问「有没有一个文件没变」（`foundSame`
/// 是 bool），**完全不问「变了多少个」**。分母为 1 时它必然误报。
///
/// 放行需同时满足两条：
///
/// 1. **本轮无删除**。`--force` 唯一的实质副作用是连带关掉 `excessDeletes`
///    （`--max-delete 50`）；无删除时该副作用恒为零，删除保护不受影响。
///    真出现大规模删除时 rclone 会先以 `"too many deletes"` 中止（该检查在
///    `operations.go` 里排在前面），根本走不到这里。
/// 2. **分母足够小**。abort 当下 `foundSame == false` 意味着每个旧文件都进了 deltas，
///    而 `new` 统计的是旧列表里没有的文件，故此刻 `modified + deleted` **恰好等于该侧
///    原文件总数**——即这道判据的分母本身。配合条件 1（deleted == 0），`modified`
///    即分母。该值 ≤ [`TRIVIAL_DENOMINATOR`] 时判据无意义，才放行；这同时把误判
///    时的爆炸半径限死在这个量级（且 `--conflict-resolve newer` 会取较新那份）。
pub fn should_force(path1: &DeltaSummary, path2: &DeltaSummary) -> bool {
    if path1.deleted > 0 || path2.deleted > 0 {
        return false;
    }
    path1.modified <= TRIVIAL_DENOMINATOR && path2.modified <= TRIVIAL_DENOMINATOR
}

/// 取 `tokens` 中 `label` 前一个 token 并解析成数字。
fn number_before(tokens: &[&str], label: &str) -> Option<u32> {
    let idx = tokens.iter().position(|t| *t == label)?;
    tokens.get(idx.checked_sub(1)?)?.parse().ok()
}

/// 取某一侧本轮的变更规模。
///
/// **零变更的一侧不会有摘要行**——rclone 的 `printStats()` 开头就是
/// `if ds.empty() { return }`（`cmd/bisync/deltas.go`），故只有有 delta 的一侧才打印。
/// 因此「没有摘要行」有两种截然不同的含义，必须区分：
///
/// - **该侧零变更**：`"PathN checking for diffs"` 是 `printStats` 之前的无条件 `fs.Infof`，
///   见到它即证明 `-v` 生效且已走到差异检测 → 此时无摘要行只能是零变更 → 返回全零。
/// - **拿不到信息**（漏了 `-v`／格式变了）：连 `checking for diffs` 都没有 → 返回 `None`，
///   由 [`classify`] fail-safe 成 [`BisyncOutcome::Failed`]，绝不 `--force`。
///
/// 实测佐证（rclone v1.74.4，远端零变更、本地 3 个文件全改）：
/// ```text
/// INFO  : Path1 checking for diffs
/// INFO  : Path2 checking for diffs
/// INFO  : Path2:    3 changes:    0 new,    3 modified,    0 deleted
/// ERROR : Safety abort: all files were changed on Path2 "D:\sync\".
/// ```
fn side_delta(stderr: &str, side: &str) -> Option<DeltaSummary> {
    if let Some(summary) = parse_delta_summary(stderr, side) {
        return Some(summary);
    }
    // 走到差异检测却无摘要行 ⇒ 该侧零变更。
    if stderr.contains(&format!("{side} checking for diffs")) {
        return Some(DeltaSummary::default());
    }
    None
}

/// 解析某一侧的 delta 摘要行，形如：
/// `2026/07/15 17:17:15 INFO  : Path2:    1 changes:    0 new,    1 modified,    0 deleted`
///
/// 对应 rclone `cmd/bisync/deltas.go` 的格式串
/// `"%s: %4d changes: %4d new, %4d modified, %4d deleted"`。
/// 取最后一次出现（一轮里每侧最多打一行；取末次可容忍重跑）。
///
/// rclone 是本仓库自带的固定版本 sidecar（`scripts/fetch-rclone.mjs`），格式由我们
/// 控制，不随用户环境漂移；即便如此，解析失败一律 fail-safe——见 [`side_delta`]。
fn parse_delta_summary(stderr: &str, side: &str) -> Option<DeltaSummary> {
    let marker = format!("{side}:");
    stderr.lines().rev().find_map(|line| {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        let start = tokens.iter().position(|t| *t == marker.as_str())?;
        let tail = &tokens[start..];
        // 认准摘要行本身，避开 `Path2 checking for diffs` 等同前缀行。
        if tail.get(2).copied() != Some("changes:") {
            return None;
        }
        Some(DeltaSummary {
            new: number_before(tail, "new,")?,
            modified: number_before(tail, "modified,")?,
            deleted: number_before(tail, "deleted")?,
        })
    })
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
    /// bisync 的 "all files were changed" 安全中止：某一侧**没有任何**文件保持不变，
    /// 整轮（双向）在传输前被中止，两个方向的改动都不会落地。
    ///
    /// 该检查是 DST 检测器，分母极小时必然误报（详见 [`should_force`]）。
    /// 携带两侧变更规模，交由 [`should_force`] 判定是否属误报。
    AllFilesChanged {
        path1: DeltaSummary,
        path2: DeltaSummary,
    },
    /// 其它失败：退出码非 0 且不属上述。
    Failed(i32),
}

/// 从退出码 + stderr 文本判定结果。
///
/// rclone bisync 无专用 403 退出码（统一为通用错误码），故 403 从 stderr 文本识别；
/// "resync" 提示同理。判定顺序：成功 → 403 → 全变了 → 需 resync → 泛化失败。
///
/// "全变了" 必须排在 "需 resync" **之前**：`--resilient` 模式下中止信息会附带
/// "retryable without --resync" 字样，先判 resync 会把它错认成基线破损。
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
    if lower.contains("all files were changed") {
        // fail-safe：拿不到变更规模就无从判断是否误报，一律退化成普通失败，
        // 绝不 `--force`（宁可停下让人看，也不敢在不知规模的情况下放行）。
        // 注意零变更的一侧**没有**摘要行，[`side_delta`] 负责把它与「拿不到」区分开。
        return match (side_delta(stderr, "Path1"), side_delta(stderr, "Path2")) {
            (Some(path1), Some(path2)) => BisyncOutcome::AllFilesChanged { path1, path2 },
            _ => BisyncOutcome::Failed(exit_code),
        };
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
/// 跑一次 bisync，按结果最多重跑一次：
///
/// - [`BisyncOutcome::SasExpired`]（中途 403）：调 `refresh` 强制刷新 SAS + 重写
///   rclone config，重跑一次；仍失败则返回该次结果。
/// - [`BisyncOutcome::AllFilesChanged`] 且 [`should_force`] 判定为误报：带 `--force`
///   重跑一次。判定不成立则原样返回，由上层升级成需用户处理——**那正是这道检查
///   该响的时候**（见 `record_sync_outcome`）。
///
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
    match runner(plan.clone()).await? {
        // 403：刷新 SAS（force_refresh 会重写 config 的 sas_url），重跑一次。
        BisyncOutcome::SasExpired => {
            refresh().await?;
            runner(plan.clone()).await
        }
        // 误报：带 --force 重跑一次，绕开 DST 检测器（此时无删除，删除保护不受影响）。
        BisyncOutcome::AllFilesChanged { path1, path2 } if should_force(&path1, &path2) => {
            runner(plan.forced()).await
        }
        other => Ok(other),
    }
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

    /// 真实复现样本：`D:\sync` 内仅 aa.txt.txt 一个文件，本地改其内容（0→12 字节）、
    /// 云端另有新文件 wsl_install_web.txt。两侧改动都被正确识别，却在传输前整轮中止。
    /// 逐字取自 rclone v1.74.4 实跑输出（`--color NEVER` 故无 ANSI）。
    const REAL_ALL_CHANGED_STDERR: &str = concat!(
        "2026/07/15 17:17:15 INFO  : Path1 checking for diffs\n",
        "2026/07/15 17:17:15 INFO  : - Path1    File is new               - wsl_install_web.txt\n",
        "2026/07/15 17:17:15 INFO  : Path1:    1 changes:    1 new,    0 modified,    0 deleted\n",
        "2026/07/15 17:17:15 INFO  : Path2 checking for diffs\n",
        "2026/07/15 17:17:15 INFO  : - Path2    File changed: size (larger), time (newer) - aa.txt.txt\n",
        "2026/07/15 17:17:15 INFO  : Path2:    1 changes:    0 new,    1 modified,    0 deleted\n",
        "2026/07/15 17:17:15 INFO  : (Modified:    1 newer,    0 older,    1 larger,    0 smaller)\n",
        "2026/07/15 17:17:15 ERROR : Safety abort: all files were changed on Path2 \"D:\\sync\\\". Run with --force if desired.\n",
        "2026/07/15 17:17:15 NOTICE: Bisync aborted. Please try again.\n",
    );

    #[test]
    fn classify_all_files_changed_parses_both_sides() {
        assert_eq!(
            classify(1, REAL_ALL_CHANGED_STDERR),
            BisyncOutcome::AllFilesChanged {
                path1: DeltaSummary {
                    new: 1,
                    modified: 0,
                    deleted: 0
                },
                path2: DeltaSummary {
                    new: 0,
                    modified: 1,
                    deleted: 0
                },
            }
        );
    }

    #[test]
    fn real_repro_is_recognised_as_false_positive() {
        // 端到端语义：用户报的两个现象（本地改动不上传 + 云端新文件不下载）同属这一轮
        // 中止；判定为误报后带 --force 重跑，两个方向才都能落地。
        let BisyncOutcome::AllFilesChanged { path1, path2 } = classify(1, REAL_ALL_CHANGED_STDERR)
        else {
            panic!("真实样本应判为 AllFilesChanged");
        };
        assert!(should_force(&path1, &path2), "分母为 1，该判据无意义，应放行");
    }

    /// 真实复现样本 ②：**远端零变更**，本地 3 个文件全改。
    /// rclone 的 `printStats()` 对零变更侧直接 return，故**只有 Path2 摘要行**。
    /// 逐字取自 rclone v1.74.4 实跑（`-v --color NEVER`）——回归钉：早期实现要求两侧
    /// 摘要都解析成功，在此样本上会误 fail-safe 成 Failed 而不 force，同步照旧卡死。
    const REAL_ONE_SIDED_STDERR: &str = concat!(
        "2026/07/16 10:46:12 INFO  : Path1 checking for diffs\n",
        "2026/07/16 10:46:12 INFO  : Path2 checking for diffs\n",
        "2026/07/16 10:46:12 INFO  : Path2:    3 changes:    0 new,    3 modified,    0 deleted\n",
        "2026/07/16 10:46:12 ERROR : Safety abort: all files were changed on Path2 \"D:\\sync\\\". Run with --force if desired.\n",
        "2026/07/16 10:46:12 NOTICE: Failed to bisync: all files were changed\n",
    );

    #[test]
    fn zero_change_side_has_no_summary_line_and_counts_as_zero() {
        assert_eq!(
            classify(1, REAL_ONE_SIDED_STDERR),
            BisyncOutcome::AllFilesChanged {
                // 远端零变更：无摘要行，但 `Path1 checking for diffs` 证明 -v 生效。
                path1: DeltaSummary::default(),
                path2: DeltaSummary {
                    new: 0,
                    modified: 3,
                    deleted: 0
                },
            }
        );
    }

    #[test]
    fn one_sided_real_repro_is_recognised_as_false_positive() {
        let BisyncOutcome::AllFilesChanged { path1, path2 } = classify(1, REAL_ONE_SIDED_STDERR)
        else {
            panic!("单侧样本应判为 AllFilesChanged");
        };
        assert!(
            should_force(&path1, &path2),
            "分母 3（= TRIVIAL_DENOMINATOR），无删除，应判误报并放行"
        );
    }

    #[test]
    fn classify_all_files_changed_without_verbose_falls_back_to_failed() {
        // 少了 `-v`（摘要行是 INFO 级）就拿不到变更规模 → fail-safe 成普通失败，绝不 force。
        let stderr = "ERROR : Safety abort: all files were changed on Path2 \"D:\\sync\\\". \
                      Run with --force if desired.\nNOTICE: Bisync aborted. Please try again.\n";
        assert_eq!(classify(1, stderr), BisyncOutcome::Failed(1));
    }

    #[test]
    fn classify_all_files_changed_takes_priority_over_resync_hint() {
        // --resilient 会附带 "retryable without --resync"；先判 resync 会错认成基线破损。
        let stderr = concat!(
            "INFO  : Path1:    1 changes:    0 new,    1 modified,    0 deleted\n",
            "INFO  : Path2:    1 changes:    0 new,    1 modified,    0 deleted\n",
            "ERROR : Safety abort: all files were changed on Path2 \"D:\\sync\\\".\n",
            "ERROR : Bisync aborted. Error is retryable without --resync due to --resilient mode.\n",
        );
        assert!(matches!(
            classify(1, stderr),
            BisyncOutcome::AllFilesChanged { .. }
        ));
    }

    fn delta(new: u32, modified: u32, deleted: u32) -> DeltaSummary {
        DeltaSummary {
            new,
            modified,
            deleted,
        }
    }

    #[test]
    fn should_force_when_denominator_is_trivial() {
        // 分母 1：「全变了」与「改了仅有的那个文件」无从区分，判据无意义。
        assert!(should_force(&delta(1, 0, 0), &delta(0, 1, 0)));
    }

    #[test]
    fn should_not_force_when_any_side_has_deletes() {
        // 有删除时 --force 会连带关掉 excessDeletes（--max-delete）；不接受该副作用。
        assert!(!should_force(&delta(0, 1, 0), &delta(0, 0, 1)));
        assert!(!should_force(&delta(0, 0, 1), &delta(0, 1, 0)));
    }

    #[test]
    fn should_not_force_when_denominator_is_large() {
        // 大批文件同时变化正是这道检查要抓的 DST 场景：不放行，交给用户确认。
        assert!(!should_force(
            &delta(0, TRIVIAL_DENOMINATOR + 1, 0),
            &delta(0, 0, 0)
        ));
        assert!(!should_force(&delta(0, 500, 0), &delta(0, 500, 0)));
    }

    #[test]
    fn should_force_at_threshold_boundary() {
        assert!(should_force(
            &delta(0, TRIVIAL_DENOMINATOR, 0),
            &delta(0, TRIVIAL_DENOMINATOR, 0)
        ));
    }

    #[test]
    fn args_include_verbose_and_no_color_for_summary_parsing() {
        // classify 的硬依赖：摘要行是 INFO 级且内嵌 ANSI。
        let args = sample_plan().to_args();
        for flag in ["-v", "--color", "NEVER"] {
            assert!(args.iter().any(|a| a == flag), "missing flag {flag}");
        }
    }

    #[test]
    fn plan_is_not_forced_by_default_and_forced_appends_force() {
        let plan = sample_plan();
        assert!(!plan.force, "new() 绝不产出 force");
        assert!(!plan.to_args().contains(&"--force".to_string()));
        assert!(plan.forced().to_args().contains(&"--force".to_string()));
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

    #[tokio::test]
    async fn sync_once_false_positive_reruns_with_force() {
        let runs = Cell::new(0);
        let forced_on_second = Cell::new(false);
        let out = run_sync_once::<(), _, _, _, _>(
            &sample_plan(),
            |plan| {
                runs.set(runs.get() + 1);
                let n = runs.get();
                if n == 2 {
                    forced_on_second.set(plan.force);
                }
                async move {
                    // 首跑撞上误报（分母 1），--force 重跑后成功。
                    Ok(if n == 1 {
                        BisyncOutcome::AllFilesChanged {
                            path1: delta(1, 0, 0),
                            path2: delta(0, 1, 0),
                        }
                    } else {
                        BisyncOutcome::Success
                    })
                }
            },
            || async { Ok(()) },
        )
        .await
        .unwrap();
        assert_eq!(out, BisyncOutcome::Success);
        assert_eq!(runs.get(), 2, "误报应恰好重跑一次");
        assert!(forced_on_second.get(), "重跑必须带 --force");
    }

    #[tokio::test]
    async fn sync_once_suspicious_all_changed_is_surfaced_not_forced() {
        // 大批文件全变（DST 场景）：不 force，原样上报交给用户确认。
        let runs = Cell::new(0);
        let outcome = BisyncOutcome::AllFilesChanged {
            path1: delta(0, 500, 0),
            path2: delta(0, 500, 0),
        };
        let out = run_sync_once::<(), _, _, _, _>(
            &sample_plan(),
            |plan| {
                runs.set(runs.get() + 1);
                assert!(!plan.force, "可疑场景绝不能 --force");
                async move { Ok(outcome) }
            },
            || async { Ok(()) },
        )
        .await
        .unwrap();
        assert_eq!(out, outcome);
        assert_eq!(runs.get(), 1, "不应重跑");
    }

    #[tokio::test]
    async fn sync_once_all_changed_with_deletes_is_not_forced() {
        // 有删除 → --force 会连带关掉删除保护 → 不放行。
        let runs = Cell::new(0);
        let out = run_sync_once::<(), _, _, _, _>(
            &sample_plan(),
            |plan| {
                runs.set(runs.get() + 1);
                assert!(!plan.force);
                async move {
                    Ok(BisyncOutcome::AllFilesChanged {
                        path1: delta(0, 0, 1),
                        path2: delta(0, 1, 0),
                    })
                }
            },
            || async { Ok(()) },
        )
        .await
        .unwrap();
        assert!(matches!(out, BisyncOutcome::AllFilesChanged { .. }));
        assert_eq!(runs.get(), 1);
    }
}
