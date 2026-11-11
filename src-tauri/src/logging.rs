//! Small append-only diagnostic log. Clipboard content, search queries and window
//! titles are never passed here; messages are single-line, capped and control-free.
use chrono::Local;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub type Result<T> = std::result::Result<T, String>;
pub const MAX_BYTES: u64 = 1024 * 1024;
pub const KEEP: usize = 3;
const MAX_CHARS: usize = 400;
static DIR: Mutex<Option<PathBuf>> = Mutex::new(None);
static WRITE: Mutex<()> = Mutex::new(());

pub fn init(data_dir: &Path) -> Result<PathBuf> {
    let dir = data_dir.join("logs");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建日志目录：{e}"))?;
    let probe = dir.join(".mypaste-log-probe");
    fs::write(&probe, b"1").map_err(|e| format!("日志目录不可写：{e}"))?;
    let _ = fs::remove_file(&probe);
    DIR.lock()
        .map_err(|_| "日志锁已损坏".to_string())?
        .replace(dir.clone());
    Ok(dir)
}
pub fn dir() -> Option<PathBuf> {
    DIR.lock().ok().and_then(|dir| dir.clone())
}
pub fn file() -> Option<PathBuf> {
    dir().map(|dir| dir.join("mypaste.log"))
}
pub fn size() -> u64 {
    file()
        .and_then(|path| fs::metadata(path).ok())
        .map(|meta| meta.len())
        .unwrap_or(0)
}
/// Make one bounded, single-line message. Content is never logged by design; this
/// guard only keeps accidental newlines or oversized OS errors from breaking the log.
pub fn sanitize(message: &str) -> String {
    message
        .chars()
        .take(MAX_CHARS)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}
pub fn event(level: &str, message: &str) {
    let line = format!(
        "{} {:<5} {}\n",
        Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z"),
        level,
        sanitize(message)
    );
    let Some(dir) = dir() else {
        eprintln!("[{level}] {message}");
        return;
    };
    let _guard = WRITE.lock();
    if let Err(error) = write(&dir, line.as_bytes()) {
        eprintln!("日志写入失败：{error}");
    }
}
fn write(dir: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let path = dir.join("mypaste.log");
    let len = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    if len + bytes.len() as u64 > MAX_BYTES {
        rotate(dir)?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?
        .write_all(bytes)
}
/// Keep the current log plus `KEEP` rotated files; the oldest is dropped first.
fn rotate(dir: &Path) -> std::io::Result<()> {
    let _ = fs::remove_file(dir.join(format!("mypaste.{KEEP}.log")));
    for index in (1..KEEP).rev() {
        let from = dir.join(format!("mypaste.{index}.log"));
        if from.exists() {
            let _ = fs::rename(&from, dir.join(format!("mypaste.{}.log", index + 1)));
        }
    }
    let current = dir.join("mypaste.log");
    if current.exists() {
        fs::rename(&current, dir.join("mypaste.1.log"))?;
    }
    Ok(())
}
pub fn tail(limit: usize) -> Vec<String> {
    let text = file()
        .and_then(|path| fs::read_to_string(path).ok())
        .unwrap_or_default();
    let mut lines = text
        .lines()
        .rev()
        .take(limit)
        .map(str::to_string)
        .collect::<Vec<_>>();
    lines.reverse();
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sanitizes_and_caps_single_lines() {
        assert_eq!(sanitize("a\r\nb\tc"), "a  b c");
        assert_eq!(sanitize(&"x".repeat(500)).chars().count(), MAX_CHARS);
        assert_eq!(sanitize("  trimmed  "), "trimmed");
    }
    #[test]
    fn appends_rotates_and_keeps_recent_lines() {
        let dir = tempfile::tempdir().unwrap();
        let logs = init(dir.path()).unwrap();
        event("INFO", "synthetic first line");
        event("ERROR", "synthetic second line");
        assert!(file().unwrap().exists());
        let text = fs::read_to_string(logs.join("mypaste.log")).unwrap();
        assert!(text
            .lines()
            .any(|line| line.ends_with("INFO  synthetic first line")));
        assert!(text
            .lines()
            .any(|line| line.ends_with("ERROR synthetic second line")));
        assert_eq!(tail(1)[0].split(' ').last(), Some("line"));
        // Fill past the limit with one synthetic line at a time (each is capped at 400 chars).
        for index in 0..2600 {
            event(
                "INFO",
                &format!("synthetic line {index} {}", "y".repeat(480)),
            );
        }
        assert!(logs.join("mypaste.1.log").exists());
        assert!(!logs.join("mypaste.4.log").exists());
        assert!(fs::metadata(logs.join("mypaste.log")).unwrap().len() <= MAX_BYTES);
        assert!(tail(1)[0].contains("synthetic line"));
        // Exercise the older buckets without writing several more megabytes.
        rotate(&logs).unwrap();
        rotate(&logs).unwrap();
        assert!(logs.join("mypaste.2.log").exists());
        assert!(logs.join("mypaste.3.log").exists());
        assert!(!logs.join("mypaste.4.log").exists());
    }
}
