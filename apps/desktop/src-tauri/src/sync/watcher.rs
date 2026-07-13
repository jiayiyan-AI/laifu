//! 本地 fs 监听（文档 §11.6 触发源①）。
//!
//! `notify` crate 监听同步目录，用户改动即触发一次 bisync。事件去抖 2~5s 合并批量改动
//! （文档 §335）。`app` feature 专属：`notify` 依赖平台 fs 事件 API。
//!
//! 设计：`watch()` 起后台线程，把去抖后的"目录已变更"信号通过 `mpsc` 送给 sync 编排。
//! 去抖窗口内的多次事件塌缩为一次触发。

use std::path::Path;
use std::sync::mpsc::{channel, Receiver};
use std::time::Duration;

use notify::{Event, RecursiveMode, Watcher};

/// 去抖窗口。文档 §335 建议 2~5s，取 3s。
const DEBOUNCE: Duration = Duration::from_secs(3);

#[derive(Debug, thiserror::Error)]
pub enum WatchError {
    #[error("notify error: {0}")]
    Notify(#[from] notify::Error),
}

/// 规则 rs-result-type：错误类型作带默认值的泛型参数暴露。
pub type Result<T, E = WatchError> = std::result::Result<T, E>;

/// 启动对 `dir` 的递归监听。返回：
///   - `watcher`：句柄，drop 即停监听（调用方须持有）。
///   - `Receiver<()>`：每收到一个值代表"去抖窗口内目录有变更，应触发一次 bisync"。
///
/// 去抖在内部线程完成：原始 fs 事件先入内部 channel，收到首个事件后等 `DEBOUNCE`，
/// 期间的后续事件被吸收，窗口结束发一个 `()`。
pub fn watch(dir: &Path) -> Result<(impl Watcher, Receiver<()>)> {
    let (raw_tx, raw_rx) = channel::<()>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            // 只关心增/删/改，忽略纯访问事件，减少无谓触发。
            if event.kind.is_modify() || event.kind.is_create() || event.kind.is_remove() {
                let _ = raw_tx.send(());
            }
        }
    })?;
    watcher.watch(dir, RecursiveMode::Recursive)?;

    let (debounced_tx, debounced_rx) = channel::<()>();
    std::thread::spawn(move || {
        // 阻塞等首个事件；随后吸收 DEBOUNCE 窗口内的所有事件，塌缩为一次触发。
        while raw_rx.recv().is_ok() {
            // 排空窗口期内的后续事件。
            let deadline = std::time::Instant::now() + DEBOUNCE;
            loop {
                let now = std::time::Instant::now();
                if now >= deadline {
                    break;
                }
                match raw_rx.recv_timeout(deadline - now) {
                    Ok(()) => continue,          // 又一个事件，继续吸收（不延长窗口）
                    Err(_) => break,             // 超时：窗口结束
                }
            }
            if debounced_tx.send(()).is_err() {
                break; // 接收端已丢弃，停线程
            }
        }
    });

    Ok((watcher, debounced_rx))
}
