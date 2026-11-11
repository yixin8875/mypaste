use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub type Result<T> = std::result::Result<T, String>;
const FILE: &str = "storage.json";
const DB: &str = "history.sqlite3";
/// Presence of this file next to the executable selects portable mode.
pub const PORTABLE_MARKER: &str = "portable.txt";
/// Portable builds keep their database beside the executable and ignore storage.json.
pub fn portable_data_dir(exe_dir: &Path) -> Option<PathBuf> {
    exe_dir
        .join(PORTABLE_MARKER)
        .is_file()
        .then(|| exe_dir.join("data"))
}
pub fn current_portable_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    portable_data_dir(exe.parent()?)
}

/// Persisted choice of data directory. `pendingDir` is set before a restart and
/// consumed at the next startup, when the database is not open and can be moved.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageConfig {
    pub data_dir: Option<String>,
    pub pending_dir: Option<String>,
}
fn config_path(config_dir: &Path) -> PathBuf {
    config_dir.join(FILE)
}
pub fn load(config_dir: &Path) -> Result<StorageConfig> {
    let path = config_path(config_dir);
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("存储配置格式无效：{e}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(StorageConfig::default()),
        Err(error) => Err(format!("无法读取存储配置：{error}")),
    }
}
pub fn save(config_dir: &Path, config: &StorageConfig) -> Result<()> {
    fs::create_dir_all(config_dir).map_err(|e| format!("无法创建配置目录：{e}"))?;
    let text = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    let path = config_path(config_dir);
    let temp = config_dir.join(format!("{FILE}.tmp"));
    fs::write(&temp, &text).map_err(|e| format!("无法保存存储配置：{e}"))?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("无法更新存储配置：{e}"))?;
    }
    if let Err(error) = fs::rename(&temp, &path) {
        // Windows cannot rename over an existing file, and losing the config after
        // a successful migration would send the next startup to an empty directory.
        fs::write(&path, &text).map_err(|e| format!("无法更新存储配置：{e}（{error}）"))?;
        let _ = fs::remove_file(&temp);
    }
    Ok(())
}
/// Resolve the directory to open. A pending directory is migrated first; if that
/// fails the previous directory is kept and the reason is returned for display.
pub fn resolve(config_dir: &Path, default_dir: &Path) -> Result<(PathBuf, Option<String>)> {
    let mut error = None;
    let mut config = match load(config_dir) {
        Ok(config) => config,
        Err(reason) => return Ok((default_dir.to_path_buf(), Some(reason))),
    };
    if let Some(pending) = config.pending_dir.clone() {
        let current = config
            .data_dir
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| default_dir.to_path_buf());
        match migrate(&current, Path::new(&pending)) {
            Ok(()) => {
                config.data_dir = Some(pending);
            }
            Err(reason) => error = Some(reason),
        }
        config.pending_dir = None;
        // Keep using the migrated directory even if persisting the choice fails;
        // otherwise a writable-config problem could hide already-moved data.
        if let Err(reason) = save(config_dir, &config) {
            if error.is_none() {
                error = Some(reason);
            }
        }
    }
    let dir = config
        .data_dir
        .map(PathBuf::from)
        .unwrap_or_else(|| default_dir.to_path_buf());
    Ok((dir, error))
}
/// Move the database (and any WAL sidecars) into `target`. Copies complete
/// before the sources are removed, so a failure never loses the original data.
fn migrate(from: &Path, target: &Path) -> Result<()> {
    if !target.is_absolute() {
        return Err("新的存储路径必须是绝对路径".into());
    }
    if from == target {
        return Err("新的存储路径与当前路径相同".into());
    }
    fs::create_dir_all(target).map_err(|e| format!("无法创建目标目录：{e}"))?;
    if target.join(DB).exists() {
        return Err("目标目录已有 MyPaste 数据，请选择空目录".into());
    }
    if !from.join(DB).exists() {
        return Err("当前目录没有可迁移的数据".into());
    }
    let mut copies: Vec<(PathBuf, PathBuf)> = Vec::new();
    for suffix in ["", "-wal", "-shm"] {
        let source = from.join(format!("{DB}{suffix}"));
        if !source.exists() {
            continue;
        }
        let destination = target.join(format!("{DB}{suffix}"));
        if let Err(error) = fs::copy(&source, &destination) {
            let _ = fs::remove_file(&destination);
            for (_, copied) in &copies {
                let _ = fs::remove_file(copied);
            }
            return Err(format!("复制数据失败：{error}"));
        }
        copies.push((source, destination));
    }
    // The new copy is complete; if an old file cannot be removed the migration
    // still succeeds and only leaves a harmless stale copy behind.
    for (source, _) in &copies {
        let _ = fs::remove_file(source);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    #[test]
    fn portable_marker_selects_the_executable_directory() {
        let dir = tempdir().unwrap();
        assert_eq!(portable_data_dir(dir.path()), None);
        std::fs::write(dir.path().join(PORTABLE_MARKER), b"").unwrap();
        assert_eq!(portable_data_dir(dir.path()), Some(dir.path().join("data")));
        std::fs::create_dir(dir.path().join("portable.txt.dir")).unwrap();
        assert_eq!(portable_data_dir(dir.path()), Some(dir.path().join("data")));
    }
    #[test]
    fn config_round_trips_and_defaults() {
        let dir = tempdir().unwrap();
        assert_eq!(load(dir.path()).unwrap(), StorageConfig::default());
        let config = StorageConfig {
            data_dir: Some("G:\\Synthetic\\MyPaste".into()),
            pending_dir: Some("G:\\Synthetic\\Next".into()),
        };
        save(dir.path(), &config).unwrap();
        assert_eq!(load(dir.path()).unwrap(), config);
        save(dir.path(), &StorageConfig::default()).unwrap();
        assert_eq!(load(dir.path()).unwrap(), StorageConfig::default());
    }
    #[test]
    fn pending_directory_migrates_database_and_wal() {
        let base = tempdir().unwrap();
        let config_dir = base.path().join("config");
        let old = base.path().join("old");
        let target = base.path().join("new");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join(DB), b"synthetic database").unwrap();
        fs::write(old.join(format!("{DB}-wal")), b"synthetic wal").unwrap();
        save(
            &config_dir,
            &StorageConfig {
                data_dir: Some(old.to_string_lossy().into_owned()),
                pending_dir: Some(target.to_string_lossy().into_owned()),
            },
        )
        .unwrap();
        let (dir, error) = resolve(&config_dir, &base.path().join("default")).unwrap();
        assert_eq!(dir, target);
        assert!(error.is_none());
        assert_eq!(fs::read(target.join(DB)).unwrap(), b"synthetic database");
        assert_eq!(
            fs::read(target.join(format!("{DB}-wal"))).unwrap(),
            b"synthetic wal"
        );
        assert!(!old.join(DB).exists());
        let saved = load(&config_dir).unwrap();
        assert_eq!(saved.data_dir, Some(target.to_string_lossy().into_owned()));
        assert!(saved.pending_dir.is_none());
    }
    #[test]
    fn migration_keeps_old_data_when_target_is_occupied() {
        let base = tempdir().unwrap();
        let config_dir = base.path().join("config");
        let old = base.path().join("old");
        let target = base.path().join("new");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(old.join(DB), b"synthetic database").unwrap();
        fs::write(target.join(DB), b"unrelated database").unwrap();
        save(
            &config_dir,
            &StorageConfig {
                data_dir: Some(old.to_string_lossy().into_owned()),
                pending_dir: Some(target.to_string_lossy().into_owned()),
            },
        )
        .unwrap();
        let (dir, error) = resolve(&config_dir, &base.path().join("default")).unwrap();
        assert_eq!(dir, old);
        assert!(error.unwrap().contains("已有 MyPaste 数据"));
        assert_eq!(fs::read(old.join(DB)).unwrap(), b"synthetic database");
        assert_eq!(fs::read(target.join(DB)).unwrap(), b"unrelated database");
        assert!(load(&config_dir).unwrap().pending_dir.is_none());
    }
}
