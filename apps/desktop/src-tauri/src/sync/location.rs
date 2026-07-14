//! 同步根目录的安全校验与同卷迁移。
//!
//! rclone bisync 在根目录变更后必须重新建基线；因此这里把「改用空目录」和
//! 「物理移动现有目录」严格分开，禁止把已有文件与同步盘直接混在一起。

use std::path::{Path, PathBuf};

/// 目录操作失败的原因。
#[derive(Debug, thiserror::Error)]
pub enum LocationError {
    #[error("目录不存在或无法解析：{path}")]
    CannotCanonicalize { path: String },
    #[error("所选路径不是目录：{path}")]
    NotDirectory { path: String },
    #[error("不能移动符号链接形式的同步目录；请先改用实际目录")]
    SymlinkRoot,
    #[error("不能移动文件系统根目录")]
    CannotMoveRoot,
    #[error("无法读取目录：{path}: {source}")]
    CannotRead {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("新同步目录必须为空：{path}")]
    NotEmpty { path: String },
    #[error("新目录不能与当前同步目录相同、嵌套或重叠")]
    Overlapping,
    #[error("目标位置已存在：{path}")]
    TargetExists { path: String },
    #[error("无法原子移动同步目录；请确认目标与原目录位于同一磁盘且有写入权限：{source}")]
    Rename {
        #[source]
        source: std::io::Error,
    },
}

/// 一个已校验的同卷目录迁移。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Relocation {
    pub source: PathBuf,
    pub target: PathBuf,
}

/// 解析并校验一个可作为新同步根的严格空目录。
///
/// `current` 允许不存在（例如用户手动删掉旧目录）；存在时以 canonical path 判断，
/// 防止符号链接别名或父子目录关系绕过重叠检查。
pub fn empty_sync_dir(candidate: &Path, current: Option<&Path>) -> Result<PathBuf, LocationError> {
    let candidate = canonical_directory(candidate)?;
    if let Some(current) = current.filter(|path| path.exists()) {
        let current = canonical_directory(current)?;
        reject_overlap(&candidate, &current)?;
    }

    let mut entries =
        std::fs::read_dir(&candidate).map_err(|source| LocationError::CannotRead {
            path: candidate.display().to_string(),
            source,
        })?;
    if entries
        .next()
        .transpose()
        .map_err(|source| LocationError::CannotRead {
            path: candidate.display().to_string(),
            source,
        })?
        .is_some()
    {
        return Err(LocationError::NotEmpty {
            path: candidate.display().to_string(),
        });
    }

    Ok(candidate)
}

/// 从用户选定的目标上级目录推导迁移终点。
///
/// 新根目录保持旧目录的名字，且必须尚不存在，才能用单次 `rename` 原子移动。
pub fn relocation(source: &Path, destination_parent: &Path) -> Result<Relocation, LocationError> {
    if std::fs::symlink_metadata(source)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(LocationError::SymlinkRoot);
    }
    let source = canonical_directory(source)?;
    let destination_parent = canonical_directory(destination_parent)?;
    let name = source.file_name().ok_or(LocationError::CannotMoveRoot)?;

    let target = destination_parent.join(name);

    reject_overlap(&source, &target)?;
    if target.exists() {
        return Err(LocationError::TargetExists {
            path: target.display().to_string(),
        });
    }

    Ok(Relocation { source, target })
}

/// 执行同卷原子 rename。跨卷或权限失败都不会留下部分移动结果。
pub fn move_directory(relocation: &Relocation) -> Result<(), LocationError> {
    std::fs::rename(&relocation.source, &relocation.target)
        .map_err(|source| LocationError::Rename { source })
}

fn canonical_directory(path: &Path) -> Result<PathBuf, LocationError> {
    let canonical = std::fs::canonicalize(path).map_err(|_| LocationError::CannotCanonicalize {
        path: path.display().to_string(),
    })?;
    if !canonical.is_dir() {
        return Err(LocationError::NotDirectory {
            path: canonical.display().to_string(),
        });
    }
    Ok(canonical)
}

fn reject_overlap(first: &Path, second: &Path) -> Result<(), LocationError> {
    if first.starts_with(second) || second.starts_with(first) {
        return Err(LocationError::Overlapping);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_directory_is_accepted() {
        let root = tempfile::tempdir().unwrap();
        let candidate = root.path().join("empty");
        std::fs::create_dir(&candidate).unwrap();

        assert_eq!(
            empty_sync_dir(&candidate, None).unwrap(),
            std::fs::canonicalize(candidate).unwrap()
        );
    }

    #[test]
    fn hidden_file_makes_directory_nonempty() {
        let root = tempfile::tempdir().unwrap();
        let candidate = root.path().join("empty-looking");
        std::fs::create_dir(&candidate).unwrap();
        std::fs::write(candidate.join(".DS_Store"), b"").unwrap();

        assert!(matches!(
            empty_sync_dir(&candidate, None),
            Err(LocationError::NotEmpty { .. })
        ));
    }

    #[test]
    fn nested_candidate_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let current = root.path().join("current");
        let candidate = current.join("nested");
        std::fs::create_dir(&current).unwrap();
        std::fs::create_dir(&candidate).unwrap();

        assert!(matches!(
            empty_sync_dir(&candidate, Some(&current)),
            Err(LocationError::Overlapping)
        ));
    }

    #[test]
    fn relocation_uses_parent_and_preserves_directory_name() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("sync");
        let destination_parent = root.path().join("destination");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&destination_parent).unwrap();

        let plan = relocation(&source, &destination_parent).unwrap();
        assert_eq!(
            plan.target,
            std::fs::canonicalize(destination_parent)
                .unwrap()
                .join("sync")
        );
    }

    #[test]
    fn relocation_rejects_existing_target() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("sync");
        let destination_parent = root.path().join("destination");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&destination_parent).unwrap();
        std::fs::create_dir(destination_parent.join("sync")).unwrap();

        assert!(matches!(
            relocation(&source, &destination_parent),
            Err(LocationError::TargetExists { .. })
        ));
    }

    #[test]
    fn move_directory_renames_without_copying() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("sync");
        let destination_parent = root.path().join("destination");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(&destination_parent).unwrap();
        std::fs::write(source.join("file.txt"), "content").unwrap();

        let plan = relocation(&source, &destination_parent).unwrap();
        move_directory(&plan).unwrap();

        assert!(!source.exists());
        assert_eq!(
            std::fs::read_to_string(plan.target.join("file.txt")).unwrap(),
            "content"
        );
    }

    #[cfg(unix)]
    #[test]
    fn relocation_rejects_symbolic_link_root() {
        let root = tempfile::tempdir().unwrap();
        let actual = root.path().join("actual");
        let linked = root.path().join("linked");
        let destination_parent = root.path().join("destination");
        std::fs::create_dir(&actual).unwrap();
        std::fs::create_dir(&destination_parent).unwrap();
        std::os::unix::fs::symlink(&actual, &linked).unwrap();

        assert!(matches!(
            relocation(&linked, &destination_parent),
            Err(LocationError::SymlinkRoot)
        ));
    }
}
