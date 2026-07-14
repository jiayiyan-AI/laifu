//! 远端变更发现轮询（文档 §11.6 触发源②）。
//!
//! 定时 `GET /api/cloud/list` 拿远端快照，与上次快照 diff；有增/删/改则触发一次 bisync。
//! diff 是纯逻辑（可测）；定时与 HTTP 调用在 app 层驱动。

use std::collections::HashMap;

use crate::contracts::CloudListResponse;

/// 远端快照：`virtual_path -> (size, last_modified)`。
/// 用 size + last_modified 组合判"改"，避免只看其一漏判。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Snapshot {
    entries: HashMap<String, (u64, String)>,
}

impl Snapshot {
    /// 从 `/api/cloud/list` 响应构造快照（只取文件；文件夹无内容变更语义）。
    pub fn from_list(list: &CloudListResponse) -> Self {
        let entries = list
            .files
            .iter()
            .map(|f| (f.virtual_path.clone(), (f.size, f.last_modified.clone())))
            .collect();
        Self { entries }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// 两个快照的差异摘要。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SnapshotDiff {
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub modified: Vec<String>,
}

impl SnapshotDiff {
    /// 是否有任何变更（决定是否触发 bisync）。
    pub fn has_changes(&self) -> bool {
        !self.added.is_empty() || !self.removed.is_empty() || !self.modified.is_empty()
    }
}

/// 计算 `prev -> next` 的差异。added/removed/modified 各自按 path 排序，结果确定。
pub fn diff(prev: &Snapshot, next: &Snapshot) -> SnapshotDiff {
    let mut d = SnapshotDiff::default();
    for (path, next_val) in &next.entries {
        match prev.entries.get(path) {
            None => d.added.push(path.clone()),
            Some(prev_val) if prev_val != next_val => d.modified.push(path.clone()),
            Some(_) => {}
        }
    }
    for path in prev.entries.keys() {
        if !next.entries.contains_key(path) {
            d.removed.push(path.clone());
        }
    }
    d.added.sort();
    d.removed.sort();
    d.modified.sort();
    d
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{CloudFileItem, CloudFileMetadata};

    fn file(path: &str, size: u64, lm: &str) -> CloudFileItem {
        CloudFileItem {
            virtual_path: path.into(),
            size,
            last_modified: lm.into(),
            content_type: None,
            metadata: CloudFileMetadata {
                title: path.into(),
                session_id: None,
                published_at: None,
                tool_version: None,
                description: None,
                tags: None,
                source: "agent".into(),
            },
        }
    }

    fn snap(files: Vec<CloudFileItem>) -> Snapshot {
        Snapshot::from_list(&CloudListResponse {
            folders: vec![],
            files,
        })
    }

    #[test]
    fn empty_diff_when_identical() {
        let a = snap(vec![file("a.txt", 1, "2026-07-08T10:00:00Z")]);
        let b = snap(vec![file("a.txt", 1, "2026-07-08T10:00:00Z")]);
        let d = diff(&a, &b);
        assert!(!d.has_changes());
    }

    #[test]
    fn detects_added() {
        let a = snap(vec![]);
        let b = snap(vec![file("new.xlsx", 100, "2026-07-09T00:00:00Z")]);
        let d = diff(&a, &b);
        assert_eq!(d.added, vec!["new.xlsx"]);
        assert!(d.removed.is_empty() && d.modified.is_empty());
        assert!(d.has_changes());
    }

    #[test]
    fn detects_removed() {
        let a = snap(vec![file("gone.doc", 5, "2026-07-08T10:00:00Z")]);
        let b = snap(vec![]);
        let d = diff(&a, &b);
        assert_eq!(d.removed, vec!["gone.doc"]);
    }

    #[test]
    fn detects_modified_by_size() {
        let a = snap(vec![file("f.txt", 1, "2026-07-08T10:00:00Z")]);
        let b = snap(vec![file("f.txt", 2, "2026-07-08T10:00:00Z")]);
        assert_eq!(diff(&a, &b).modified, vec!["f.txt"]);
    }

    #[test]
    fn detects_modified_by_mtime() {
        let a = snap(vec![file("f.txt", 1, "2026-07-08T10:00:00Z")]);
        let b = snap(vec![file("f.txt", 1, "2026-07-09T11:00:00Z")]);
        assert_eq!(diff(&a, &b).modified, vec!["f.txt"]);
    }

    #[test]
    fn mixed_changes_sorted() {
        let a = snap(vec![
            file("keep.txt", 1, "t1"),
            file("del.txt", 1, "t1"),
            file("mod.txt", 1, "t1"),
        ]);
        let b = snap(vec![
            file("keep.txt", 1, "t1"),
            file("mod.txt", 2, "t1"),
            file("zadd.txt", 1, "t1"),
            file("aadd.txt", 1, "t1"),
        ]);
        let d = diff(&a, &b);
        assert_eq!(d.added, vec!["aadd.txt", "zadd.txt"]);
        assert_eq!(d.removed, vec!["del.txt"]);
        assert_eq!(d.modified, vec!["mod.txt"]);
    }
}
