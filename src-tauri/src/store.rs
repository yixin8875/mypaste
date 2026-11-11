use chrono::{Local, TimeZone};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::Path;

pub type Result<T> = std::result::Result<T, String>;
pub const DAY: i64 = 86_400_000;
pub const MAX_IMAGE: usize = 10 * 1024 * 1024;
pub const MAX_TOTAL: i64 = 500 * 1024 * 1024;
pub const MAX_PIXELS: usize = 20_000_000;
pub const MAX_FILES: usize = 500;
pub const MAX_FILE_LIST: usize = 1024 * 1024;
pub const MAX_THUMB: usize = 512 * 1024;
pub const MAX_RICH: usize = 1024 * 1024;
const THUMB_EDGE: u32 = 320;
const MAX_ID: i64 = 9_007_199_254_740_991;
fn db(e: rusqlite::Error) -> String {
    format!("SQLite operation failed: {e}")
}
pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub fn valid_id(id: i64) -> Result<()> {
    if !(1..=MAX_ID).contains(&id) {
        return Err("Invalid item id".into());
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: i64,
    pub title: String,
    pub content: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub source: String,
    pub time: String,
    pub day: String,
    pub favorite: bool,
    pub pinned: bool,
    pub collections: Vec<String>,
    pub note: String,
    pub deleted: bool,
    pub captured_at: i64,
    pub deleted_at: Option<i64>,
    pub file_size: i64,
    pub file_modified_at: Option<i64>,
    pub files: Vec<FileEntry>,
    pub last_used_at: Option<i64>,
    pub use_count: i64,
    pub has_html: bool,
    pub has_rtf: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub size: Option<i64>,
    pub modified_at: Option<i64>,
    pub is_dir: bool,
}
/// Optional per-collection retention override. `None` follows the global setting.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CollectionPolicy {
    pub name: String,
    pub retention_days: Option<i64>,
    pub max_items: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub paused: bool,
    pub retention_days: i64,
    pub max_items: i64,
    pub shortcut: String,
    #[serde(default)]
    pub excluded_apps: Vec<String>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            paused: false,
            retention_days: 30,
            max_items: 500,
            shortcut: "Ctrl+Shift+V".into(),
            excluded_apps: vec![],
        }
    }
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPatch {
    pub paused: Option<bool>,
    pub retention_days: Option<i64>,
    pub max_items: Option<i64>,
    pub shortcut: Option<String>,
    pub excluded_apps: Option<Vec<String>>,
}
impl SettingsPatch {
    pub fn apply(&self, old: &Settings) -> Result<Settings> {
        let mut excluded_apps: Vec<String> = Vec::new();
        for app in self
            .excluded_apps
            .clone()
            .unwrap_or_else(|| old.excluded_apps.clone())
        {
            let app = app.trim();
            if app.is_empty() || app.chars().count() > 120 || app.chars().any(char::is_control) {
                return Err("Invalid excluded application name".into());
            }
            let key = app.to_ascii_lowercase();
            let key = key.strip_suffix(".exe").unwrap_or(&key).to_string();
            let duplicate = excluded_apps.iter().any(|existing| {
                let existing = existing.to_ascii_lowercase();
                existing.strip_suffix(".exe").unwrap_or(existing.as_str()) == key
            });
            if !duplicate {
                excluded_apps.push(app.to_string());
            }
        }
        if excluded_apps.len() > 100 {
            return Err("Too many excluded applications".into());
        }
        let s = Settings {
            paused: self.paused.unwrap_or(old.paused),
            retention_days: self.retention_days.unwrap_or(old.retention_days),
            max_items: self.max_items.unwrap_or(old.max_items),
            shortcut: self
                .shortcut
                .clone()
                .unwrap_or_else(|| old.shortcut.clone()),
            excluded_apps,
        };
        if !(1..=3650).contains(&s.retention_days)
            || !(1..=100_000).contains(&s.max_items)
            || s.shortcut.len() > 100
            || s.shortcut.trim().is_empty()
        {
            return Err("Invalid settings range".into());
        }
        Ok(s)
    }
}
#[derive(Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ItemPatch {
    pub title: Option<String>,
    pub note: Option<String>,
    pub favorite: Option<bool>,
    pub pinned: Option<bool>,
    pub collections: Option<Vec<String>>,
    pub deleted: Option<bool>,
}
#[derive(Clone, Debug)]
pub struct Capture {
    pub kind: String,
    pub content: String,
    pub hash: String,
    pub png: Option<Vec<u8>>,
    pub title: String,
    pub file_size: i64,
    pub file_modified_at: Option<i64>,
    pub meta: String,
    pub source: String,
    pub thumb: Option<Vec<u8>>,
    pub html: Option<Vec<u8>>,
    pub rtf: Option<Vec<u8>>,
}
fn thumbnail(pixels: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    if width <= THUMB_EDGE && height <= THUMB_EDGE {
        return None;
    }
    let scale = THUMB_EDGE as f64 / width.max(height) as f64;
    let thumb_width = ((width as f64 * scale).round() as u32).max(1);
    let thumb_height = ((height as f64 * scale).round() as u32).max(1);
    let source = image::RgbaImage::from_raw(width, height, pixels.to_vec())?;
    let small = image::imageops::resize(
        &source,
        thumb_width,
        thumb_height,
        image::imageops::FilterType::Triangle,
    );
    let mut png = Vec::new();
    use image::ImageEncoder;
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(
            small.as_raw(),
            thumb_width,
            thumb_height,
            image::ExtendedColorType::Rgba8,
        )
        .ok()?;
    (png.len() <= MAX_THUMB).then_some(png)
}
fn encode_rgba_png(pixels: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    use image::ImageEncoder;
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(pixels, width, height, image::ExtendedColorType::Rgba8)
        .ok()?;
    (png.len() <= MAX_THUMB).then_some(png)
}
/// A file record that holds exactly one supported image file can be previewed.
fn image_file_path(content: &str, meta: &str) -> Option<String> {
    let mut entries: Vec<FileEntry> = serde_json::from_str(meta).ok().unwrap_or_default();
    if entries.is_empty() && !content.is_empty() && !content.contains(['\n', '\r']) {
        entries.push(FileEntry {
            path: content.to_string(),
            size: None,
            modified_at: None,
            is_dir: false,
        });
    }
    if entries.len() != 1 || entries[0].is_dir {
        return None;
    }
    let path = entries[0].path.clone();
    let extension = Path::new(&path)
        .extension()
        .and_then(|ext| ext.to_str())?
        .to_ascii_lowercase();
    matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "bmp").then_some(path)
}
fn read_image_file(path: &str) -> Result<(image::ImageFormat, Vec<u8>)> {
    let meta = std::fs::metadata(path).map_err(|_| "Image file is unavailable".to_string())?;
    if !meta.is_file() {
        return Err("Image path is not a file".into());
    }
    if meta.len() > MAX_IMAGE as u64 {
        return Err("Image file exceeds the 10 MiB limit".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "Image file read failed".to_string())?;
    let format = image::guess_format(&bytes).map_err(|_| "Unsupported image file".to_string())?;
    if !matches!(
        format,
        image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::Bmp
    ) {
        return Err("Unsupported image file".into());
    }
    Ok((format, bytes))
}
fn decode_image_file(bytes: &[u8]) -> Result<image::RgbaImage> {
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("Image file decode failed: {e}"))?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(80_000_000);
    limits.max_image_width = Some(MAX_PIXELS as u32);
    limits.max_image_height = Some(MAX_PIXELS as u32);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|e| format!("Image file decode failed: {e}"))?;
    if decoded.width() as u64 * decoded.height() as u64 > MAX_PIXELS as u64 {
        return Err("Image file exceeds 20 million pixels".into());
    }
    Ok(decoded.to_rgba8())
}
fn mime_for(format: image::ImageFormat) -> &'static str {
    match format {
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::Bmp => "image/bmp",
        _ => "image/png",
    }
}
pub fn digest(kind: &str, bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(b"mypaste:v1\0");
    h.update(kind.as_bytes());
    h.update([0]);
    h.update(bytes);
    format!("{:x}", h.finalize())
}
impl Capture {
    pub fn text(content: String) -> Result<Self> {
        if content.is_empty() || content.len() > 1024 * 1024 {
            return Err("Text must contain 1 byte to 1 MiB".into());
        }
        let kind = if http_url(&content).is_ok() {
            "link"
        } else {
            "text"
        };
        let hash = digest(kind, content.as_bytes());
        let title = content
            .lines()
            .next()
            .unwrap_or("")
            .chars()
            .take(80)
            .collect();
        Ok(Self {
            kind: kind.into(),
            content,
            hash,
            png: None,
            title,
            file_size: 0,
            file_modified_at: None,
            meta: String::new(),
            source: String::new(),
            thumb: None,
            html: None,
            rtf: None,
        })
    }
    /// Attach the optional clipboard HTML/RTF payloads to a text capture.
    pub fn with_rich(mut self, html: Option<Vec<u8>>, rtf: Option<Vec<u8>>) -> Self {
        self.html = html;
        self.rtf = rtf;
        self
    }
    /// Store only paths and a metadata snapshot; file contents are never read.
    pub fn files(entries: Vec<FileEntry>) -> Result<Self> {
        let mut clean: Vec<FileEntry> = Vec::new();
        let mut bytes = 0usize;
        for entry in entries {
            if entry.path.is_empty() {
                continue;
            }
            if entry.path.contains(['\0', '\r', '\n']) || entry.path.len() > 32 * 1024 {
                return Err("File paths must not contain control line breaks".into());
            }
            bytes = bytes
                .checked_add(entry.path.len())
                .ok_or("Clipboard file list is too large")?;
            if clean.len() >= MAX_FILES || bytes > MAX_FILE_LIST {
                return Err("Clipboard file list exceeds 500 entries or 1 MiB".into());
            }
            if !clean.iter().any(|existing| existing.path == entry.path) {
                clean.push(entry);
            }
        }
        if clean.is_empty() {
            return Err("Clipboard file list is empty".into());
        }
        let content = clean
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let hash = digest("file", content.as_bytes());
        let file_size = clean
            .iter()
            .filter(|entry| !entry.is_dir)
            .filter_map(|entry| entry.size)
            .fold(0i64, i64::saturating_add);
        let file_modified_at = clean.iter().filter_map(|entry| entry.modified_at).max();
        let meta = serde_json::to_string(&clean).map_err(|e| e.to_string())?;
        let first = Path::new(&clean[0].path)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or(&clean[0].path);
        let title = if clean.len() == 1 {
            first.chars().take(80).collect()
        } else {
            format!(
                "{} 等 {} 项",
                first.chars().take(64).collect::<String>(),
                clean.len()
            )
        };
        Ok(Self {
            kind: "file".into(),
            content,
            hash,
            png: None,
            title,
            file_size,
            file_modified_at,
            meta,
            source: String::new(),
            thumb: None,
            html: None,
            rtf: None,
        })
    }
    pub fn with_source(mut self, source: String) -> Self {
        self.source = source;
        self
    }
    pub fn rgba(width: usize, height: usize, pixels: &[u8]) -> Result<Self> {
        let count = width
            .checked_mul(height)
            .ok_or("Image dimensions overflow")?;
        if count == 0
            || count > MAX_PIXELS
            || count.checked_mul(4) != Some(pixels.len())
            || width > u32::MAX as usize
            || height > u32::MAX as usize
        {
            return Err("Image exceeds 20 million RGBA pixels or is invalid".into());
        }
        let mut hasher = Sha256::new();
        hasher.update(b"mypaste:v1\0image\0");
        hasher.update((width as u64).to_le_bytes());
        hasher.update((height as u64).to_le_bytes());
        hasher.update(pixels);
        let hash = format!("{:x}", hasher.finalize());
        let mut png = Vec::new();
        use image::ImageEncoder;
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(
                pixels,
                width as u32,
                height as u32,
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|e| format!("PNG encoding failed: {e}"))?;
        if png.len() > MAX_IMAGE {
            return Err("PNG exceeds 10 MiB".into());
        }
        Ok(Self {
            kind: "image".into(),
            content: String::new(),
            hash,
            png: Some(png),
            title: format!("图片 {width} × {height}"),
            file_size: 0,
            file_modified_at: None,
            meta: String::new(),
            source: String::new(),
            thumb: thumbnail(pixels, width as u32, height as u32),
            html: None,
            rtf: None,
        })
    }
}
pub fn http_url(text: &str) -> Result<url::Url> {
    let trimmed = text.trim();
    if trimmed.chars().any(char::is_whitespace) {
        return Err("A single HTTP(S) URL is required".into());
    }
    let u = url::Url::parse(trimmed).map_err(|_| "Invalid HTTP(S) URL")?;
    if !matches!(u.scheme(), "http" | "https") || u.host_str().is_none() {
        return Err("Only HTTP(S) links may be opened".into());
    }
    Ok(u)
}
pub struct Store {
    conn: Connection,
    pub settings: Settings,
}
impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        Self::from_conn(Connection::open(path).map_err(db)?)
    }
    fn from_conn(conn: Connection) -> Result<Self> {
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(db)?;
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")
            .map_err(db)?;
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(db)?;
        if version > 8 {
            return Err("Database schema is newer than this application".into());
        }
        if version == 0 {
            conn.execute_batch("BEGIN IMMEDIATE;
              CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(id<=9007199254740991), kind TEXT NOT NULL CHECK(kind IN('text','link','image','file')), hash TEXT NOT NULL, title TEXT NOT NULL CHECK(length(title)<=200), content TEXT NOT NULL, png BLOB, note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=10000), favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN(0,1)), file_size INTEGER NOT NULL DEFAULT 0, file_modified INTEGER, meta TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', thumb BLOB, last_used INTEGER, use_count INTEGER NOT NULL DEFAULT 0, captured_at INTEGER NOT NULL, deleted_at INTEGER, UNIQUE(kind,hash));
              CREATE INDEX items_recent ON items(captured_at DESC,id DESC);
              CREATE INDEX items_trash ON items(deleted_at);
              CREATE TABLE collections(name TEXT PRIMARY KEY COLLATE NOCASE CHECK(length(name) BETWEEN 1 AND 80));
              CREATE TABLE members(item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,name TEXT COLLATE NOCASE REFERENCES collections(name) ON DELETE CASCADE,PRIMARY KEY(item_id,name));
              CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
              PRAGMA user_version=4; COMMIT;").map_err(db)?;
        } else if version == 1 {
            // SQLite cannot widen a CHECK constraint in place: rebuild the table while
            // members keeps referencing the final "items" name.
            conn.execute_batch(
                "PRAGMA foreign_keys=OFF;
                 BEGIN IMMEDIATE;
                 CREATE TABLE items_v4(id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(id<=9007199254740991), kind TEXT NOT NULL CHECK(kind IN('text','link','image','file')), hash TEXT NOT NULL, title TEXT NOT NULL CHECK(length(title)<=200), content TEXT NOT NULL, png BLOB, note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=10000), favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN(0,1)), file_size INTEGER NOT NULL DEFAULT 0, file_modified INTEGER, meta TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', thumb BLOB, last_used INTEGER, use_count INTEGER NOT NULL DEFAULT 0, captured_at INTEGER NOT NULL, deleted_at INTEGER, UNIQUE(kind,hash));
                 INSERT INTO items_v4(id,kind,hash,title,content,png,note,favorite,captured_at,deleted_at)
                   SELECT id,kind,hash,title,content,png,note,favorite,captured_at,deleted_at FROM items;
                 DROP TABLE items;
                 ALTER TABLE items_v4 RENAME TO items;
                 CREATE INDEX items_recent ON items(captured_at DESC,id DESC);
                 CREATE INDEX items_trash ON items(deleted_at);
                 PRAGMA user_version=4;
                 COMMIT;
                 PRAGMA foreign_keys=ON;",
            )
            .map_err(db)?;
            let broken: i64 = conn
                .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
                    r.get(0)
                })
                .map_err(db)?;
            if broken > 0 {
                return Err("Database migration left broken references".into());
            }
        } else if version == 2 {
            conn.execute_batch(
                "BEGIN IMMEDIATE;
                 ALTER TABLE items ADD COLUMN file_size INTEGER NOT NULL DEFAULT 0;
                 ALTER TABLE items ADD COLUMN file_modified INTEGER;
                 ALTER TABLE items ADD COLUMN meta TEXT NOT NULL DEFAULT '';
                 ALTER TABLE items ADD COLUMN source TEXT NOT NULL DEFAULT '';
                 ALTER TABLE items ADD COLUMN thumb BLOB;
                 ALTER TABLE items ADD COLUMN last_used INTEGER;
                 ALTER TABLE items ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
                 PRAGMA user_version=4;
                 COMMIT;",
            )
            .map_err(db)?;
        } else if version == 3 {
            conn.execute_batch(
                "BEGIN IMMEDIATE;
                 ALTER TABLE items ADD COLUMN source TEXT NOT NULL DEFAULT '';
                 ALTER TABLE items ADD COLUMN thumb BLOB;
                 ALTER TABLE items ADD COLUMN last_used INTEGER;
                 ALTER TABLE items ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
                 PRAGMA user_version=4;
                 COMMIT;",
            )
            .map_err(db)?;
        }
        // v5: pinned flag plus a trigram FTS index used for substring search.
        let current: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(db)?;
        if current < 5 {
            conn.execute_batch(
                "BEGIN IMMEDIATE;
                 ALTER TABLE items ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN(0,1));
                 CREATE VIRTUAL TABLE items_fts USING fts5(title,content,note,content='items',content_rowid='id',tokenize='trigram');
                 CREATE TRIGGER items_fts_insert AFTER INSERT ON items BEGIN
                   INSERT INTO items_fts(rowid,title,content,note) VALUES(new.id,new.title,new.content,new.note);
                 END;
                 CREATE TRIGGER items_fts_delete AFTER DELETE ON items BEGIN
                   INSERT INTO items_fts(items_fts,rowid,title,content,note) VALUES('delete',old.id,old.title,old.content,old.note);
                 END;
                 CREATE TRIGGER items_fts_update AFTER UPDATE OF title,content,note ON items BEGIN
                   INSERT INTO items_fts(items_fts,rowid,title,content,note) VALUES('delete',old.id,old.title,old.content,old.note);
                   INSERT INTO items_fts(rowid,title,content,note) VALUES(new.id,new.title,new.content,new.note);
                 END;
                 INSERT INTO items_fts(items_fts) VALUES('rebuild');
                 PRAGMA user_version=5;
                 COMMIT;",
            )
            .map_err(db)?;
        }
        // v6: user-defined collection order, seeded from the previous alphabetical order.
        if current < 6 {
            conn.execute_batch(
                "BEGIN IMMEDIATE;
                 ALTER TABLE collections ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
                 UPDATE collections SET position=(SELECT count(*) FROM collections c2 WHERE c2.name<collections.name);
                 PRAGMA user_version=6;
                 COMMIT;",
            )
            .map_err(db)?;
        }
        // v7: optional HTML and RTF payloads captured next to the plain text.
        if current < 7 {
            conn.execute_batch(
                "BEGIN IMMEDIATE;
                 ALTER TABLE items ADD COLUMN html BLOB;
                 ALTER TABLE items ADD COLUMN rtf BLOB;
                 PRAGMA user_version=7;
                 COMMIT;",
            )
            .map_err(db)?;
        }
        // v8: per-collection retention overrides; NULL keeps following the global setting.
        if current < 8 {
            conn.execute_batch(
                "BEGIN IMMEDIATE;
                 ALTER TABLE collections ADD COLUMN retention_days INTEGER CHECK(retention_days IS NULL OR (retention_days BETWEEN 1 AND 3650));
                 ALTER TABLE collections ADD COLUMN max_items INTEGER CHECK(max_items IS NULL OR (max_items BETWEEN 1 AND 100000));
                 PRAGMA user_version=8;
                 COMMIT;",
            )
            .map_err(db)?;
        }
        let saved: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key='settings'", [], |r| {
                r.get(0)
            })
            .optional()
            .map_err(db)?;
        let settings: Settings = match saved {
            Some(v) => {
                serde_json::from_str(&v).map_err(|e| format!("Invalid persisted settings: {e}"))?
            }
            None => Settings::default(),
        };
        SettingsPatch::default().apply(&settings)?;
        let mut s = Self { conn, settings };
        s.maintain(now())?;
        Ok(s)
    }
    pub fn save_settings(&mut self, settings: Settings) -> Result<()> {
        SettingsPatch::default().apply(&settings)?;
        let value = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
        self.conn.execute("INSERT INTO settings(key,value) VALUES('settings',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[value]).map_err(db)?;
        self.settings = settings;
        Ok(())
    }
    pub fn capture(&mut self, c: &Capture, at: i64) -> Result<i64> {
        if self.settings.paused {
            return Err("Capture is paused".into());
        }
        let tx = self.conn.transaction().map_err(db)?;
        let existing: Option<(
            i64,
            String,
            Option<Vec<u8>>,
            Option<Vec<u8>>,
            Option<Vec<u8>>,
        )> = tx
            .query_row(
                "SELECT id,content,png,html,rtf FROM items WHERE kind=?1 AND hash=?2",
                params![c.kind, c.hash],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()
            .map_err(db)?;
        let id;
        if let Some((found, text, png, old_html, old_rtf)) = existing {
            if text != c.content || png != c.png {
                return Err("Content hash collision detected".into());
            }
            id = found;
            // A later plain-text copy must not erase formats saved by an earlier rich copy.
            let html = c.html.clone().or(old_html);
            let rtf = c.rtf.clone().or(old_rtf);
            tx.execute(
                "UPDATE items SET captured_at=?1,deleted_at=NULL,file_size=?3,file_modified=?4,meta=?5,source=?6,html=?7,rtf=?8 WHERE id=?2",
                params![at, id, c.file_size, c.file_modified_at, c.meta, c.source, html, rtf],
            )
            .map_err(db)?;
        } else {
            if let Some(png) = &c.png {
                if png.len() > MAX_IMAGE {
                    return Err("PNG exceeds 10 MiB".into());
                }
                let used: i64 = tx
                    .query_row("SELECT coalesce(sum(length(png)),0) FROM items", [], |r| {
                        r.get(0)
                    })
                    .map_err(db)?;
                if used + png.len() as i64 > MAX_TOTAL {
                    return Err(
                        "Image quota of 500 MiB reached; empty selected trash items manually"
                            .into(),
                    );
                }
            }
            tx.execute("INSERT INTO items(kind,hash,title,content,png,file_size,file_modified,meta,source,thumb,captured_at,html,rtf) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",params![c.kind,c.hash,c.title,c.content,c.png,c.file_size,c.file_modified_at,c.meta,c.source,c.thumb,at,c.html,c.rtf]).map_err(db)?;
            id = tx.last_insert_rowid();
            valid_id(id)?;
        }
        tx.commit().map_err(db)?;
        self.maintain(at)?;
        Ok(id)
    }
    pub fn collections(&self) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT name FROM collections ORDER BY position,name COLLATE NOCASE")
            .map_err(db)?;
        let rows = stmt.query_map([], |r| r.get(0)).map_err(db)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db)
    }
    pub fn collection_policies(&self) -> Result<Vec<CollectionPolicy>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT name,retention_days,max_items FROM collections ORDER BY position,name COLLATE NOCASE",
            )
            .map_err(db)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(CollectionPolicy {
                    name: r.get(0)?,
                    retention_days: r.get(1)?,
                    max_items: r.get(2)?,
                })
            })
            .map_err(db)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db)
    }
    /// Replace one collection's retention override. `None` clears it back to the global policy.
    pub fn set_collection_policy(
        &mut self,
        name: &str,
        retention_days: Option<i64>,
        max_items: Option<i64>,
    ) -> Result<()> {
        if retention_days.is_some_and(|days| !(1..=3650).contains(&days))
            || max_items.is_some_and(|max| !(1..=100_000).contains(&max))
        {
            return Err("集合保留策略超出允许范围".into());
        }
        let changed = self
            .conn
            .execute(
                "UPDATE collections SET retention_days=?2,max_items=?3 WHERE name=?1",
                params![name, retention_days, max_items],
            )
            .map_err(db)?;
        if changed == 0 {
            return Err("Collection not found".into());
        }
        Ok(())
    }
    fn collection_name(name: &str) -> Result<&str> {
        let name = name.trim();
        if name.is_empty()
            || name.chars().count() > 80
            || [
                "全部记录",
                "收藏",
                "最近删除",
                "text",
                "link",
                "image",
                "file",
            ]
            .iter()
            .any(|s| name.eq_ignore_ascii_case(s))
        {
            return Err("Invalid or reserved collection name".into());
        }
        Ok(name)
    }
    pub fn create_collection(&mut self, name: &str) -> Result<()> {
        let name = Self::collection_name(name)?;
        self.conn
            .execute(
                "INSERT INTO collections(name,position) VALUES(?1,(SELECT coalesce(max(position),-1)+1 FROM collections))",
                [name],
            )
            .map_err(db)?;
        Ok(())
    }
    pub fn rename_collection(&mut self, old: &str, new: &str) -> Result<()> {
        let new = Self::collection_name(new)?;
        let tx = self.conn.transaction().map_err(db)?;
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM collections WHERE name=?1)",
                [old],
                |r| r.get(0),
            )
            .map_err(db)?;
        if !exists {
            return Err("Collection not found".into());
        }
        if !old.eq_ignore_ascii_case(new) {
            let duplicate: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM collections WHERE name=?1)",
                    [new],
                    |r| r.get(0),
                )
                .map_err(db)?;
            if duplicate {
                return Err("Collection already exists".into());
            }
        }
        // The primary key compares names case-insensitively, so only a real rename
        // needs the insert/relink/delete dance to satisfy the members foreign key.
        if old.eq_ignore_ascii_case(new) {
            tx.execute(
                "UPDATE collections SET name=?2 WHERE name=?1",
                rusqlite::params![old, new],
            )
            .map_err(db)?;
        } else {
            tx.execute(
                "INSERT INTO collections(name,position) SELECT ?2,position FROM collections WHERE name=?1",
                rusqlite::params![old, new],
            )
            .map_err(db)?;
            tx.execute(
                "UPDATE members SET name=?2 WHERE name=?1",
                rusqlite::params![old, new],
            )
            .map_err(db)?;
            tx.execute("DELETE FROM collections WHERE name=?1", [old])
                .map_err(db)?;
        }
        tx.commit().map_err(db)?;
        Ok(())
    }
    pub fn delete_collection(&mut self, name: &str) -> Result<()> {
        let removed = self
            .conn
            .execute("DELETE FROM collections WHERE name=?1", [name])
            .map_err(db)?;
        if removed == 0 {
            return Err("Collection not found".into());
        }
        Ok(())
    }
    pub fn move_collection(&mut self, name: &str, direction: &str) -> Result<()> {
        if direction != "up" && direction != "down" {
            return Err("Invalid collection direction".into());
        }
        let mut names = self.collections()?;
        let index = names
            .iter()
            .position(|item| item.eq_ignore_ascii_case(name))
            .ok_or("Collection not found")?;
        let swap = if direction == "up" {
            index.checked_sub(1)
        } else if index + 1 < names.len() {
            Some(index + 1)
        } else {
            None
        };
        let Some(other) = swap else { return Ok(()) };
        names.swap(index, other);
        let tx = self.conn.transaction().map_err(db)?;
        for (position, name) in names.iter().enumerate() {
            tx.execute(
                "UPDATE collections SET position=?1 WHERE name=?2",
                rusqlite::params![position as i64, name],
            )
            .map_err(db)?;
        }
        tx.commit().map_err(db)?;
        Ok(())
    }
    pub fn add_to_collection(&mut self, ids: &[i64], name: &str) -> Result<()> {
        if ids.is_empty() {
            return Err("No items selected".into());
        }
        if ids.len() > 1000 {
            return Err("Too many items selected".into());
        }
        let tx = self.conn.transaction().map_err(db)?;
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM collections WHERE name=?1)",
                [name],
                |r| r.get(0),
            )
            .map_err(db)?;
        if !exists {
            return Err("Collection not found".into());
        }
        for id in ids {
            valid_id(*id)?;
            tx.execute(
                "INSERT OR IGNORE INTO members(item_id,name) VALUES(?1,?2)",
                rusqlite::params![id, name],
            )
            .map_err(db)?;
        }
        tx.commit().map_err(db)?;
        Ok(())
    }
    pub fn update_many(&mut self, ids: &[i64], patch: &ItemPatch) -> Result<()> {
        if ids.is_empty() {
            return Err("No items selected".into());
        }
        if ids.len() > 1000 {
            return Err("Too many items selected".into());
        }
        // Validate every target before the first write so a bad id cannot leave a half-applied batch.
        for id in ids {
            let item = self.get(*id)?;
            if item.deleted
                && (patch.title.is_some()
                    || patch.note.is_some()
                    || patch.favorite.is_some()
                    || patch.pinned.is_some()
                    || patch.collections.is_some())
            {
                return Err("Restore an item before editing it".into());
            }
        }
        for id in ids {
            self.update(*id, patch.clone())?;
        }
        Ok(())
    }
    pub fn counts(&self) -> Result<(i64, i64)> {
        self.conn
            .query_row(
                "SELECT coalesce(sum(deleted_at IS NULL),0), coalesce(sum(deleted_at IS NOT NULL),0) FROM items",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(db)
    }
    pub fn compact(&mut self) -> Result<()> {
        self.conn
            .execute_batch("PRAGMA optimize; VACUUM;")
            .map_err(db)?;
        Ok(())
    }
    fn clip(&self, id: i64, full: bool) -> Result<Clip> {
        valid_id(id)?;
        let sql = if full {
            "SELECT id,title,content,kind,note,favorite,captured_at,deleted_at,file_size,file_modified,meta,source,last_used,use_count,pinned,(html IS NOT NULL),(rtf IS NOT NULL) FROM items WHERE id=?1"
        } else {
            "SELECT id,title,CASE WHEN kind='image' THEN '' ELSE substr(content,1,240) END,kind,note,favorite,captured_at,deleted_at,file_size,file_modified,'',source,last_used,use_count,pinned,(html IS NOT NULL),(rtf IS NOT NULL) FROM items WHERE id=?1"
        };
        let mut stored_meta = String::new();
        let mut c = self
            .conn
            .query_row(sql, [id], |r| {
                let at: i64 = r.get(6)?;
                let deleted_at: Option<i64> = r.get(7)?;
                let date = Local.timestamp_millis_opt(at).single();
                let today = Local::now().date_naive();
                let day = date
                    .map(|d| {
                        if d.date_naive() == today {
                            "今天".into()
                        } else if Some(d.date_naive()) == today.pred_opt() {
                            "昨天".into()
                        } else {
                            d.format("%Y-%m-%d").to_string()
                        }
                    })
                    .unwrap_or_default();
                stored_meta = r.get(10)?;
                let source: String = r.get(11)?;
                Ok(Clip {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    content: r.get(2)?,
                    kind: r.get(3)?,
                    note: r.get(4)?,
                    favorite: r.get(5)?,
                    pinned: r.get(14)?,
                    captured_at: at,
                    deleted_at,
                    deleted: deleted_at.is_some(),
                    source: if source.is_empty() {
                        "未知来源".into()
                    } else {
                        source
                    },
                    time: date
                        .map(|d| d.format("%H:%M").to_string())
                        .unwrap_or_default(),
                    day,
                    collections: vec![],
                    file_size: r.get(8)?,
                    file_modified_at: r.get(9)?,
                    files: vec![],
                    last_used_at: r.get(12)?,
                    use_count: r.get(13)?,
                    has_html: r.get(15)?,
                    has_rtf: r.get(16)?,
                })
            })
            .optional()
            .map_err(db)?
            .ok_or("Item not found")?;
        if full && !stored_meta.is_empty() {
            c.files = serde_json::from_str(&stored_meta)
                .map_err(|e| format!("Stored file metadata is invalid: {e}"))?;
        }
        let mut stmt = self
            .conn
            .prepare("SELECT name FROM members WHERE item_id=?1 ORDER BY name COLLATE NOCASE")
            .map_err(db)?;
        c.collections = stmt
            .query_map([id], |r| r.get(0))
            .map_err(db)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db)?;
        Ok(c)
    }
    pub fn get(&self, id: i64) -> Result<Clip> {
        self.clip(id, true)
    }
    pub fn list(&self) -> Result<Vec<Clip>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM items ORDER BY captured_at DESC,id DESC")
            .map_err(db)?;
        let ids = stmt
            .query_map([], |r| r.get(0))
            .map_err(db)?
            .collect::<rusqlite::Result<Vec<i64>>>()
            .map_err(db)?;
        ids.into_iter().map(|id| self.clip(id, false)).collect()
    }
    pub fn search(&self, query: &str) -> Result<Vec<i64>> {
        if query.len() > 4096 {
            return Err("Search query exceeds 4096 bytes".into());
        }
        if query.trim().is_empty() {
            return Ok(vec![]);
        }
        // The trigram tokenizer only indexes strings of at least three characters;
        // shorter queries keep the literal scan so one- and two-character searches still work.
        let result = if query.chars().count() >= 3 {
            let phrase = format!("\"{}\"", query.replace('"', "\"\""));
            let mut stmt = self.conn.prepare("SELECT i.id FROM items i WHERE i.id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?1) OR i.id IN (SELECT m.item_id FROM members m WHERE instr(lower(m.name),lower(?2))>0) ORDER BY i.captured_at DESC,i.id DESC").map_err(db)?;
            let rows = stmt
                .query_map(params![phrase, query], |r| r.get(0))
                .map_err(db)?
                .collect::<rusqlite::Result<Vec<_>>>();
            rows.map_err(db)
        } else {
            let mut stmt = self.conn.prepare("SELECT i.id FROM items i WHERE instr(lower(i.title),lower(?1))>0 OR instr(lower(i.content),lower(?1))>0 OR instr(lower(i.note),lower(?1))>0 OR EXISTS(SELECT 1 FROM members m WHERE m.item_id=i.id AND instr(lower(m.name),lower(?1))>0) ORDER BY i.captured_at DESC,i.id DESC").map_err(db)?;
            let rows = stmt
                .query_map([query], |r| r.get(0))
                .map_err(db)?
                .collect::<rusqlite::Result<Vec<_>>>();
            rows.map_err(db)
        };
        result
    }
    pub fn export_to(&mut self, path: &Path) -> Result<()> {
        let target = path.to_str().ok_or("Backup path is not valid UTF-8")?;
        self.conn.execute("VACUUM INTO ?1", [target]).map_err(db)?;
        Ok(())
    }
    pub fn import_from(&mut self, path: &Path) -> Result<()> {
        let source = path.to_str().ok_or("Backup path is not valid UTF-8")?;
        self.conn
            .execute("ATTACH DATABASE ?1 AS backup", [source])
            .map_err(db)?;
        let result = (|| -> Result<()> {
            let version: i64 = self
                .conn
                .query_row("PRAGMA backup.user_version", [], |r| r.get(0))
                .map_err(db)?;
            if !(4..=8).contains(&version) {
                return Err("备份文件的数据库版本不受支持".into());
            }
            let integrity: String = self
                .conn
                .query_row("PRAGMA backup.integrity_check", [], |r| r.get(0))
                .map_err(db)?;
            if integrity != "ok" {
                return Err("备份文件校验失败".into());
            }
            let tx = self.conn.transaction().map_err(db)?;
            tx.execute_batch("DELETE FROM members; DELETE FROM collections; DELETE FROM items;")
                .map_err(db)?;
            let pinned = if version >= 5 { "pinned" } else { "0" };
            let rich = if version >= 7 {
                "html,rtf"
            } else {
                "NULL,NULL"
            };
            tx.execute(
                &format!("INSERT INTO items(id,kind,hash,title,content,png,note,favorite,file_size,file_modified,meta,source,thumb,last_used,use_count,captured_at,deleted_at,pinned,html,rtf) SELECT id,kind,hash,title,content,png,note,favorite,file_size,file_modified,meta,source,thumb,last_used,use_count,captured_at,deleted_at,{pinned},{rich} FROM backup.items"),
                [],
            )
            .map_err(db)?;
            let position = if version >= 6 { "position" } else { "0" };
            let policy = if version >= 8 {
                "retention_days,max_items"
            } else {
                "NULL,NULL"
            };
            tx.execute(
                &format!("INSERT INTO collections(name,position,retention_days,max_items) SELECT name,{position},{policy} FROM backup.collections"),
                [],
            )
            .map_err(db)?;
            tx.execute(
                "INSERT INTO members(item_id,name) SELECT item_id,name FROM backup.members",
                [],
            )
            .map_err(db)?;
            tx.commit().map_err(db)?;
            Ok(())
        })();
        let detached = self.conn.execute("DETACH DATABASE backup", []);
        result?;
        detached.map_err(db)?;
        Ok(())
    }
    pub fn update(&mut self, id: i64, p: ItemPatch) -> Result<()> {
        let old = self.get(id)?;
        if p.title.as_ref().is_some_and(|x| x.chars().count() > 200)
            || p.note.as_ref().is_some_and(|x| x.chars().count() > 10000)
        {
            return Err("Title exceeds 200 characters or note exceeds 10000 characters".into());
        }
        if old.deleted
            && (p.title.is_some()
                || p.note.is_some()
                || p.favorite.is_some()
                || p.pinned.is_some()
                || p.collections.is_some())
        {
            return Err("Restore an item before editing it".into());
        }
        let tx = self.conn.transaction().map_err(db)?;
        let names = p.collections.as_ref();
        if let Some(names) = names {
            if names.len() > 1000 {
                return Err("Too many collections".into());
            }
            for name in names {
                let exists: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM collections WHERE name=?1)",
                        [name],
                        |r| r.get(0),
                    )
                    .map_err(db)?;
                if !exists {
                    return Err("Collection not found".into());
                }
            }
        }
        let deleted_at = match p.deleted {
            Some(true) => old.deleted_at.or(Some(now())),
            Some(false) => None,
            None => old.deleted_at,
        };
        if old.deleted && p.deleted == Some(false) && !old.favorite {
            // A collection with its own policy is judged by that policy when the next
            // maintenance runs; only records outside such collections are pre-checked.
            let managed: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM members m JOIN collections c ON c.name=m.name WHERE m.item_id=?1 AND (c.retention_days IS NOT NULL OR c.max_items IS NOT NULL))",
                    [id],
                    |r| r.get(0),
                )
                .map_err(db)?;
            let count: i64 = tx
                .query_row(
                    "SELECT count(*) FROM items WHERE favorite=0 AND pinned=0 AND deleted_at IS NULL",
                    [],
                    |r| r.get(0),
                )
                .map_err(db)?;
            if !managed
                && (old.captured_at <= now() - self.settings.retention_days * DAY
                    || count >= self.settings.max_items)
            {
                return Err("Item exceeds retention limits; it remains in trash".into());
            }
        }
        tx.execute(
            "UPDATE items SET title=?1,note=?2,favorite=?3,deleted_at=?4,pinned=?5 WHERE id=?6",
            params![
                p.title.unwrap_or(old.title),
                p.note.unwrap_or(old.note),
                p.favorite.unwrap_or(old.favorite),
                deleted_at,
                p.pinned.unwrap_or(old.pinned),
                id
            ],
        )
        .map_err(db)?;
        if let Some(names) = names {
            tx.execute("DELETE FROM members WHERE item_id=?1", [id])
                .map_err(db)?;
            for name in names {
                tx.execute("INSERT OR IGNORE INTO members(item_id,name) SELECT ?1,name FROM collections WHERE name=?2",params![id,name]).map_err(db)?;
            }
        }
        tx.commit().map_err(db)?;
        self.maintain(now())?;
        Ok(())
    }
    pub fn purge(&mut self, id: i64) -> Result<()> {
        let item = self.get(id)?;
        if !item.deleted {
            return Err("Only trashed items may be purged".into());
        }
        self.conn
            .execute(
                "DELETE FROM items WHERE id=?1 AND deleted_at IS NOT NULL",
                [id],
            )
            .map_err(db)?;
        Ok(())
    }
    pub fn image(&self, id: i64) -> Result<(String, Vec<u8>)> {
        valid_id(id)?;
        let (kind, png, content, meta): (String, Option<Vec<u8>>, String, String) = self
            .conn
            .query_row(
                "SELECT kind,png,content,meta FROM items WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(db)?
            .ok_or("Image not found")?;
        if kind == "image" {
            return Ok(("image/png".into(), png.ok_or("Image not found")?));
        }
        if kind != "file" {
            return Err("Image not found".into());
        }
        let path = image_file_path(&content, &meta).ok_or("Image file not found")?;
        let (format, bytes) = read_image_file(&path)?;
        let (width, height) = image::ImageReader::new(std::io::Cursor::new(&bytes))
            .with_guessed_format()
            .map_err(|e| format!("Image file decode failed: {e}"))?
            .into_dimensions()
            .map_err(|e| format!("Image file decode failed: {e}"))?;
        if width as u64 * height as u64 > MAX_PIXELS as u64 {
            return Err("Image file exceeds 20 million pixels".into());
        }
        Ok((mime_for(format).to_string(), bytes))
    }
    pub fn hash(&self, id: i64) -> Result<String> {
        valid_id(id)?;
        self.conn
            .query_row("SELECT hash FROM items WHERE id=?1", [id], |r| r.get(0))
            .map_err(db)
    }
    /// Raw clipboard payloads; they are never sent through the snapshot API.
    pub fn rich(&self, id: i64) -> Result<(Option<Vec<u8>>, Option<Vec<u8>>)> {
        valid_id(id)?;
        self.conn
            .query_row("SELECT html,rtf FROM items WHERE id=?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()
            .map_err(db)?
            .ok_or_else(|| "Item not found".into())
    }
    /// Return a small preview for an image record or a single image file, caching it.
    pub fn thumbnail(&mut self, id: i64) -> Result<Vec<u8>> {
        valid_id(id)?;
        let (kind, stored, png, content, meta): (
            String,
            Option<Vec<u8>>,
            Option<Vec<u8>>,
            String,
            String,
        ) = self
            .conn
            .query_row(
                "SELECT kind,thumb,png,content,meta FROM items WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()
            .map_err(db)?
            .ok_or("Item not found")?;
        if let Some(thumb) = stored {
            if !thumb.is_empty() {
                return Ok(thumb);
            }
        }
        let thumb = if kind == "image" {
            let png = png.ok_or("Image not found")?;
            let image = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
                .map_err(|e| format!("Stored image decode failed: {e}"))?
                .to_rgba8();
            let (width, height) = image.dimensions();
            if width as u64 * height as u64 > MAX_PIXELS as u64 {
                return Err("Stored image exceeds the pixel limit".into());
            }
            thumbnail(image.as_raw(), width, height).unwrap_or(png)
        } else if kind == "file" {
            let path = image_file_path(&content, &meta).ok_or("Image file not found")?;
            let (_, bytes) = read_image_file(&path)?;
            let image = decode_image_file(&bytes)?;
            let (width, height) = image.dimensions();
            thumbnail(image.as_raw(), width, height)
                .or_else(|| encode_rgba_png(image.as_raw(), width, height))
                .ok_or("Image file thumbnail failed")?
        } else {
            return Err("Image not found".into());
        };
        self.conn
            .execute("UPDATE items SET thumb=?1 WHERE id=?2", params![&thumb, id])
            .map_err(db)?;
        Ok(thumb)
    }
    pub fn mark_used(&mut self, id: i64, at: i64) -> Result<()> {
        valid_id(id)?;
        self.conn
            .execute(
                "UPDATE items SET last_used=?1,use_count=use_count+1 WHERE id=?2",
                params![at, id],
            )
            .map_err(db)?;
        Ok(())
    }
    /// Soft-delete records past the time or count policy, then purge the 7-day trash.
    ///
    /// A collection with any retention override manages its own members: time uses the
    /// longer of its override and the global value, and count uses its override or the
    /// global value applied within the collection. An item in several managed
    /// collections is kept while any of them keeps it; items in no managed collection
    /// follow the global policies.
    pub fn maintain(&mut self, at: i64) -> Result<bool> {
        let policies = self.collection_policies()?;
        let mut by_name: HashMap<&str, (Option<i64>, Option<i64>)> = HashMap::new();
        for policy in &policies {
            by_name.insert(
                policy.name.as_str(),
                (policy.retention_days, policy.max_items),
            );
        }
        let mut stmt = self
            .conn
            .prepare("SELECT id,captured_at FROM items WHERE favorite=0 AND pinned=0 AND deleted_at IS NULL ORDER BY captured_at DESC,id DESC")
            .map_err(db)?;
        let items = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
            .map_err(db)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db)?;
        drop(stmt);
        let mut members: HashMap<i64, Vec<String>> = HashMap::new();
        let mut stmt = self
            .conn
            .prepare("SELECT item_id,name FROM members")
            .map_err(db)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map_err(db)?;
        for row in rows {
            let (id, name) = row.map_err(db)?;
            members.entry(id).or_default().push(name);
        }
        drop(stmt);
        let names_of =
            |id: i64| -> &[String] { members.get(&id).map(Vec::as_slice).unwrap_or(&[]) };
        let mut expire: HashSet<i64> = HashSet::new();
        for (id, captured) in &items {
            let longest = names_of(*id)
                .iter()
                .filter_map(|name| by_name.get(name.as_str()).and_then(|p| p.0))
                .max();
            let days = longest
                .map(|days| days.max(self.settings.retention_days))
                .unwrap_or(self.settings.retention_days);
            if *captured <= at - days * DAY {
                expire.insert(*id);
            }
        }
        let managed: HashSet<&str> = policies
            .iter()
            .filter(|policy| policy.retention_days.is_some() || policy.max_items.is_some())
            .map(|policy| policy.name.as_str())
            .collect();
        let mut protected: HashSet<i64> = HashSet::new();
        for policy in policies
            .iter()
            .filter(|p| managed.contains(p.name.as_str()))
        {
            let max = policy.max_items.unwrap_or(self.settings.max_items).max(0) as usize;
            let members_of_collection = items
                .iter()
                .filter(|(id, _)| names_of(*id).iter().any(|name| name == &policy.name))
                .take(max);
            for (id, _) in members_of_collection {
                protected.insert(*id);
            }
        }
        let mut ranked = 0i64;
        for (id, _) in &items {
            let overridden = names_of(*id)
                .iter()
                .any(|name| managed.contains(name.as_str()));
            if overridden {
                // Governed by its collections; expire only when no collection keeps it.
                if !protected.contains(id) {
                    expire.insert(*id);
                }
            } else if ranked >= self.settings.max_items {
                expire.insert(*id);
            } else {
                ranked += 1;
            }
        }
        let tx = self.conn.transaction().map_err(db)?;
        for id in &expire {
            tx.execute(
                "UPDATE items SET deleted_at=?1 WHERE id=?2 AND deleted_at IS NULL",
                params![at, id],
            )
            .map_err(db)?;
        }
        let c = tx
            .execute(
                "DELETE FROM items WHERE deleted_at IS NOT NULL AND deleted_at<=?1",
                [at - 7 * DAY],
            )
            .map_err(db)?;
        tx.commit().map_err(db)?;
        Ok(!expire.is_empty() || c > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn memory() -> Store {
        Store::from_conn(Connection::open_in_memory().unwrap()).unwrap()
    }
    fn file(path: &str, size: Option<i64>, modified: Option<i64>, is_dir: bool) -> FileEntry {
        FileEntry {
            path: path.into(),
            size,
            modified_at: modified,
            is_dir,
        }
    }
    fn legacy(version: i64) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        let kinds = if version >= 2 {
            "text','link','image','file"
        } else {
            "text','link','image"
        };
        let file_columns = if version >= 3 {
            ", file_size INTEGER NOT NULL DEFAULT 0, file_modified INTEGER, meta TEXT NOT NULL DEFAULT ''"
        } else {
            ""
        };
        conn.execute_batch(&format!(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT CHECK(id<=9007199254740991), kind TEXT NOT NULL CHECK(kind IN('{kinds}')), hash TEXT NOT NULL, title TEXT NOT NULL CHECK(length(title)<=200), content TEXT NOT NULL, png BLOB{file_columns}, note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=10000), favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN(0,1)), captured_at INTEGER NOT NULL, deleted_at INTEGER, UNIQUE(kind,hash));
             CREATE INDEX items_recent ON items(captured_at DESC,id DESC);
             CREATE INDEX items_trash ON items(deleted_at);
             CREATE TABLE collections(name TEXT PRIMARY KEY COLLATE NOCASE CHECK(length(name) BETWEEN 1 AND 80));
             CREATE TABLE members(item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,name TEXT COLLATE NOCASE REFERENCES collections(name) ON DELETE CASCADE,PRIMARY KEY(item_id,name));
             CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
             PRAGMA user_version={version};
             INSERT INTO items(kind,hash,title,content,captured_at) VALUES('text','old','旧记录','正文',{});
             INSERT INTO collections(name) VALUES('旧集合');
             INSERT INTO members(item_id,name) VALUES(1,'旧集合');",
            now()
        ))
        .unwrap();
        conn
    }
    #[test]
    fn file_capture_stores_paths_and_metadata_only() {
        let c = Capture::files(vec![
            file(
                "C:\\Synthetic\\alpha.txt",
                Some(2048),
                Some(1_700_000_000_000),
                false,
            ),
            file("C:\\Synthetic\\beta", None, None, true),
            file("C:\\Synthetic\\alpha.txt", Some(9999), None, false),
        ])
        .unwrap();
        assert_eq!(c.kind, "file");
        assert_eq!(c.content, "C:\\Synthetic\\alpha.txt\nC:\\Synthetic\\beta");
        assert_eq!(c.file_size, 2048);
        assert_eq!(c.file_modified_at, Some(1_700_000_000_000));
        assert!(c.title.contains("等 2 项"));
        let meta: Vec<FileEntry> = serde_json::from_str(&c.meta).unwrap();
        assert_eq!(meta.len(), 2);
        assert_eq!(meta[0].size, Some(2048));
        assert!(meta[1].is_dir);
        assert!(Capture::files(vec![]).is_err());
        assert!(Capture::files(vec![file("a\nb", None, None, false)]).is_err());
        assert!(Capture::files(vec![file(
            &format!("C:\\Synthetic\\{}", "x".repeat(MAX_FILE_LIST)),
            None,
            None,
            false
        )])
        .is_err());
    }
    #[test]
    fn schema_v1_migrates_to_file_support() {
        let mut store = Store::from_conn(legacy(1)).unwrap();
        let version: i64 = store
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 8);
        let old = store.get(1).unwrap();
        assert_eq!(old.title, "旧记录");
        assert_eq!(old.source, "未知来源");
        assert_eq!(old.use_count, 0);
        assert!(old.last_used_at.is_none());
        assert_eq!(store.collections().unwrap(), vec!["旧集合"]);
        assert_eq!(
            store.collection_policies().unwrap()[0],
            CollectionPolicy {
                name: "旧集合".into(),
                retention_days: None,
                max_items: None,
            }
        );
        let id = store
            .capture(
                &Capture::files(vec![file(
                    "C:\\Synthetic\\new.txt",
                    Some(1234),
                    Some(1_700_000_000_000),
                    false,
                )])
                .unwrap(),
                now(),
            )
            .unwrap();
        let got = store.get(id).unwrap();
        assert_eq!(got.kind, "file");
        assert_eq!(got.file_size, 1234);
        assert_eq!(got.files.len(), 1);
        assert_eq!(got.files[0].modified_at, Some(1_700_000_000_000));
        assert_eq!(got.collections.len(), 0);
    }
    #[test]
    fn schema_v2_adds_file_metadata_columns() {
        let mut store = Store::from_conn(legacy(2)).unwrap();
        let version: i64 = store
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 8);
        let old = store.get(1).unwrap();
        assert_eq!(old.file_size, 0);
        assert!(old.files.is_empty());
        assert_eq!(old.source, "未知来源");
        assert_eq!(old.use_count, 0);
        let id = store
            .capture(
                &Capture::files(vec![file(
                    "C:\\Synthetic\\video.mp4",
                    Some(2 * 1024 * 1024 * 1024),
                    Some(1_700_000_000_000),
                    false,
                )])
                .unwrap(),
                now(),
            )
            .unwrap();
        let got = store.get(id).unwrap();
        assert_eq!(got.file_size, 2 * 1024 * 1024 * 1024);
        assert_eq!(got.files[0].path, "C:\\Synthetic\\video.mp4");
        let listed = store.list().unwrap();
        assert_eq!(listed[0].file_size, 2 * 1024 * 1024 * 1024);
        assert!(listed[0].files.is_empty());
    }
    #[test]
    fn schema_v3_adds_source_usage_and_thumbnails() {
        let mut store = Store::from_conn(legacy(3)).unwrap();
        let version: i64 = store
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 8);
        let old = store.get(1).unwrap();
        assert_eq!(old.source, "未知来源");
        assert_eq!(old.use_count, 0);
        assert!(old.last_used_at.is_none());
        assert!(!old.has_html && !old.has_rtf);
        assert_eq!(store.rich(1).unwrap(), (None, None));

        let c = Capture::text("来自合成应用".into())
            .unwrap()
            .with_source("synthetic.exe".into());
        let base = now();
        let id = store.capture(&c, base).unwrap();
        assert_eq!(store.get(id).unwrap().source, "synthetic.exe");
        store.mark_used(id, base + 5).unwrap();
        store.mark_used(id, base + 9).unwrap();
        let used = store.get(id).unwrap();
        assert_eq!(used.use_count, 2);
        assert_eq!(used.last_used_at, Some(base + 9));
        assert!(store.thumbnail(id).is_err());
    }
    #[test]
    fn rich_formats_are_stored_merged_and_flagged() {
        let mut store = memory();
        let html = b"Version:0.9\r\nStartHTML:0000000105\r\nEndHTML:0000000200\r\n<html><body>synthetic</body></html>".to_vec();
        let rtf = b"{\\rtf1\\ansi synthetic}".to_vec();
        let base = now();
        let first = Capture::text("富文本示例".into())
            .unwrap()
            .with_rich(Some(html.clone()), Some(rtf.clone()));
        let id = store.capture(&first, base).unwrap();
        let got = store.get(id).unwrap();
        assert!(got.has_html && got.has_rtf);
        assert_eq!(
            store.rich(id).unwrap(),
            (Some(html.clone()), Some(rtf.clone()))
        );
        assert!(store.list().unwrap()[0].has_html);

        // Re-copying the same text as plain must not erase formats saved earlier.
        assert_eq!(
            store
                .capture(&Capture::text("富文本示例".into()).unwrap(), base + 1)
                .unwrap(),
            id
        );
        assert_eq!(store.rich(id).unwrap(), (Some(html), Some(rtf)));

        let html2 = b"<html><body>updated</body></html>".to_vec();
        let rtf2 = b"{\\rtf1\\ansi updated}".to_vec();
        store
            .capture(
                &Capture::text("富文本示例".into())
                    .unwrap()
                    .with_rich(Some(html2.clone()), Some(rtf2.clone())),
                base + 2,
            )
            .unwrap();
        assert_eq!(store.rich(id).unwrap(), (Some(html2), Some(rtf2)));
    }
    #[test]
    fn image_thumbnail_is_bounded_and_served_from_cache() {
        let mut store = memory();
        let (width, height) = (900usize, 600usize);
        let rgba = vec![180u8; width * height * 4];
        let mut c = Capture::rgba(width, height, &rgba).unwrap();
        c.source = "screenshot".into();
        let id = store.capture(&c, now()).unwrap();
        let thumb = store.thumbnail(id).unwrap();
        assert!(thumb.starts_with(b"\x89PNG"));
        assert!(thumb.len() <= MAX_THUMB);
        let cached: Option<Vec<u8>> = store
            .conn
            .query_row("SELECT thumb FROM items WHERE id=?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(cached.as_deref(), Some(thumb.as_slice()));
        assert_eq!(store.get(id).unwrap().source, "screenshot");
    }
    #[test]
    fn image_file_records_get_thumbnails_and_previews() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synthetic-preview.png");
        image::RgbaImage::from_pixel(640, 480, image::Rgba([10, 20, 30, 255]))
            .save(&path)
            .unwrap();
        let capture = Capture::files(vec![FileEntry {
            path: path.to_string_lossy().into_owned(),
            size: Some(123),
            modified_at: None,
            is_dir: false,
        }])
        .unwrap();
        let mut store = memory();
        let id = store.capture(&capture, now()).unwrap();
        let (mime, bytes) = store.image(id).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, std::fs::read(&path).unwrap());
        let thumb = store.thumbnail(id).unwrap();
        assert!(thumb.starts_with(b"\x89PNG"));
        assert!(thumb.len() <= MAX_THUMB);
        let cached: Option<Vec<u8>> = store
            .conn
            .query_row("SELECT thumb FROM items WHERE id=?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(cached.as_deref(), Some(thumb.as_slice()));

        let jpg_path = dir.path().join("synthetic-preview.jpg");
        image::RgbImage::from_pixel(64, 48, image::Rgb([200, 100, 50]))
            .save(&jpg_path)
            .unwrap();
        let jpg = Capture::files(vec![FileEntry {
            path: jpg_path.to_string_lossy().into_owned(),
            size: Some(456),
            modified_at: None,
            is_dir: false,
        }])
        .unwrap();
        let jpg_id = store.capture(&jpg, now()).unwrap();
        let (mime, bytes) = store.image(jpg_id).unwrap();
        assert_eq!(mime, "image/jpeg");
        assert_eq!(bytes, std::fs::read(&jpg_path).unwrap());
        assert!(store.thumbnail(jpg_id).unwrap().starts_with(b"\x89PNG"));

        let text_path = dir.path().join("synthetic-note.txt");
        std::fs::write(&text_path, b"synthetic").unwrap();
        let plain = Capture::files(vec![FileEntry {
            path: text_path.to_string_lossy().into_owned(),
            size: Some(9),
            modified_at: None,
            is_dir: false,
        }])
        .unwrap();
        let plain_id = store.capture(&plain, now()).unwrap();
        assert!(store.image(plain_id).is_err());
        assert!(store.thumbnail(plain_id).is_err());
    }
    fn text(s: &str) -> Capture {
        Capture::text(s.into()).unwrap()
    }
    #[test]
    fn persistence_pause_and_safe_ids() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.sqlite3");
        let mut s = Store::open(&path).unwrap();
        let id = s.capture(&text("合成测试"), now()).unwrap();
        let mut config = s.settings.clone();
        config.paused = true;
        s.save_settings(config).unwrap();
        drop(s);
        let mut s = Store::open(&path).unwrap();
        assert!(s.settings.paused);
        assert_eq!(s.get(id).unwrap().content, "合成测试");
        assert!(s.capture(&text("ignored"), now()).is_err());
        assert!(s.get(0).is_err());
        assert!(s.get(MAX_ID + 1).is_err());
    }
    #[test]
    fn dedup_restores_without_losing_metadata() {
        let mut s = memory();
        let at = now();
        let id = s.capture(&text("same"), at).unwrap();
        s.create_collection("__proto__").unwrap();
        s.update(
            id,
            ItemPatch {
                title: Some("custom".into()),
                note: Some("备注".into()),
                favorite: Some(true),
                collections: Some(vec!["__proto__".into()]),
                ..Default::default()
            },
        )
        .unwrap();
        s.update(
            id,
            ItemPatch {
                deleted: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(id, s.capture(&text("same"), at + 1000).unwrap());
        let c = s.get(id).unwrap();
        assert!(c.favorite && !c.deleted);
        assert_eq!(c.title, "custom");
        assert_eq!(c.note, "备注");
        assert_eq!(c.collections, vec!["__proto__"]);
        assert_eq!(s.list().unwrap().len(), 1);
    }
    #[test]
    fn search_full_content_literal_and_trash() {
        let mut s = memory();
        let body = format!("{}中文管理 Needle 100% '_", "前".repeat(300));
        let id = s.capture(&text(&body), now()).unwrap();
        assert_eq!(s.list().unwrap()[0].content.chars().count(), 240);
        assert_eq!(s.get(id).unwrap().content, body);
        s.create_collection("Work_Kit").unwrap();
        s.update(
            id,
            ItemPatch {
                collections: Some(vec!["Work_Kit".into()]),
                note: Some("NoteOnly".into()),
                ..Default::default()
            },
        )
        .unwrap();
        s.update(
            id,
            ItemPatch {
                deleted: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        for q in ["管理", "needle", "100% '_", "work_kit", "noteonly"] {
            assert_eq!(s.search(q).unwrap(), vec![id]);
        }
        assert!(s.search("%DROP TABLE").unwrap().is_empty());
    }
    #[test]
    fn retention_favorites_trash_and_restore() {
        let mut s = memory();
        let at = now();
        s.settings.max_items = 1;
        let a = s.capture(&text("a"), at).unwrap();
        s.update(
            a,
            ItemPatch {
                favorite: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        let b = s.capture(&text("b"), at + 1).unwrap();
        let c = s.capture(&text("c"), at + 2).unwrap();
        assert!(!s.get(a).unwrap().deleted);
        assert!(s.get(b).unwrap().deleted);
        assert!(!s.get(c).unwrap().deleted);
        assert!(s
            .update(
                b,
                ItemPatch {
                    deleted: Some(false),
                    ..Default::default()
                }
            )
            .is_err());
        assert!(s.purge(c).is_err());
        s.maintain(at + 31 * DAY).unwrap();
        assert!(!s.get(a).unwrap().deleted);
        assert!(s.get(c).unwrap().deleted);
        assert!(s.get(b).is_err());
        s.update(
            a,
            ItemPatch {
                deleted: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        s.maintain(now() + 8 * DAY).unwrap();
        assert!(s.get(a).is_err());
    }
    #[test]
    fn collection_policy_extends_time_and_scopes_counts() {
        let mut s = memory();
        let at = now();
        s.settings.retention_days = 30;
        s.settings.max_items = 10;
        s.create_collection("长期").unwrap();
        s.set_collection_policy("长期", Some(90), None).unwrap();
        s.create_collection("短期").unwrap();
        s.set_collection_policy("短期", Some(7), None).unwrap();
        let long = s.capture(&text("synthetic long"), at - 40 * DAY).unwrap();
        s.update(
            long,
            ItemPatch {
                collections: Some(vec!["长期".into(), "短期".into()]),
                ..Default::default()
            },
        )
        .unwrap();
        let plain = s.capture(&text("synthetic plain"), at - 40 * DAY).unwrap();
        s.maintain(at).unwrap();
        assert!(
            !s.get(long).unwrap().deleted,
            "90 天集合保护超过 40 天的记录"
        );
        assert!(
            s.get(plain).unwrap().deleted,
            "未加入集合的记录按全局 30 天清理"
        );

        let mut s = memory();
        s.settings.max_items = 10;
        s.create_collection("保留两条").unwrap();
        s.set_collection_policy("保留两条", None, Some(2)).unwrap();
        let a = s.capture(&text("a synthetic"), at).unwrap();
        let b = s.capture(&text("b synthetic"), at + 1).unwrap();
        let c = s.capture(&text("c synthetic"), at + 2).unwrap();
        let d = s.capture(&text("d synthetic"), at + 3).unwrap();
        for id in [a, b, d] {
            s.update(
                id,
                ItemPatch {
                    collections: Some(vec!["保留两条".into()]),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        s.settings.max_items = 1;
        s.maintain(at + 4).unwrap();
        assert!(s.get(a).unwrap().deleted, "集合只保留最新两条");
        assert!(!s.get(b).unwrap().deleted);
        assert!(!s.get(d).unwrap().deleted);
        assert!(!s.get(c).unwrap().deleted, "集合外记录仍享有全局 1 条名额");
    }
    #[test]
    fn favorites_are_exempt_from_collection_limits() {
        let mut s = memory();
        let at = now();
        s.settings.max_items = 1;
        s.create_collection("合成收藏").unwrap();
        s.set_collection_policy("合成收藏", None, Some(1)).unwrap();
        let older = s.capture(&text("older synthetic"), at).unwrap();
        s.update(
            older,
            ItemPatch {
                favorite: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        let newer = s.capture(&text("newer synthetic"), at + 1).unwrap();
        for id in [older, newer] {
            s.update(
                id,
                ItemPatch {
                    collections: Some(vec!["合成收藏".into()]),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        s.maintain(at + 2).unwrap();
        assert!(!s.get(older).unwrap().deleted, "收藏豁免集合条数上限");
        assert!(!s.get(newer).unwrap().deleted, "集合上限内最新一条保留");
    }
    #[test]
    fn collection_policy_validation_and_defaults() {
        let mut s = memory();
        s.create_collection("合成集合").unwrap();
        assert_eq!(
            s.collection_policies().unwrap(),
            vec![CollectionPolicy {
                name: "合成集合".into(),
                retention_days: None,
                max_items: None,
            }]
        );
        assert!(s.set_collection_policy("missing", Some(7), None).is_err());
        assert!(s.set_collection_policy("合成集合", Some(0), None).is_err());
        assert!(s
            .set_collection_policy("合成集合", Some(3651), None)
            .is_err());
        assert!(s.set_collection_policy("合成集合", None, Some(0)).is_err());
        assert!(s
            .set_collection_policy("合成集合", None, Some(100_001))
            .is_err());
        s.set_collection_policy("合成集合", Some(90), Some(1000))
            .unwrap();
        assert_eq!(s.collection_policies().unwrap()[0].retention_days, Some(90));
        s.set_collection_policy("合成集合", None, None).unwrap();
        assert_eq!(s.collection_policies().unwrap()[0].max_items, None);
    }
    #[test]
    fn validation_and_atomic_collection_patch() {
        let mut s = memory();
        let id = s.capture(&text("valid"), now()).unwrap();
        for name in ["", " text ", "收藏", "全部记录", "IMAGE"] {
            assert!(s.create_collection(name).is_err());
        }
        s.create_collection("Okay").unwrap();
        assert!(s.create_collection("okay").is_err());
        assert!(s
            .update(
                id,
                ItemPatch {
                    title: Some("x".repeat(201)),
                    ..Default::default()
                }
            )
            .is_err());
        assert!(s
            .update(
                id,
                ItemPatch {
                    note: Some("x".repeat(10001)),
                    ..Default::default()
                }
            )
            .is_err());
        assert!(s
            .update(
                id,
                ItemPatch {
                    title: Some("should rollback".into()),
                    collections: Some(vec!["missing".into()]),
                    ..Default::default()
                }
            )
            .is_err());
        assert_eq!(s.get(id).unwrap().title, "valid");
        assert!(SettingsPatch {
            max_items: Some(0),
            ..Default::default()
        }
        .apply(&s.settings)
        .is_err());
        assert!(http_url("file:///C:/secret").is_err());
        assert!(http_url("javascript:alert(1)").is_err());
        assert_eq!(text(" https://example.com/path ").kind, "link");
        assert_eq!(text("https://example.com two").kind, "text");
    }
    #[test]
    fn collection_rename_delete_order_and_batch_updates() {
        let mut s = memory();
        let a = s.capture(&text("alpha synthetic"), now()).unwrap();
        let b = s.capture(&text("beta synthetic"), now() + 1).unwrap();
        assert!(s.add_to_collection(&[a], "missing").is_err());
        s.create_collection("Work").unwrap();
        s.create_collection("Play").unwrap();
        assert_eq!(s.collections().unwrap(), vec!["Work", "Play"]);
        s.move_collection("Play", "up").unwrap();
        assert_eq!(s.collections().unwrap(), vec!["Play", "Work"]);
        s.move_collection("Play", "up").unwrap();
        assert_eq!(s.collections().unwrap(), vec!["Play", "Work"]);
        s.add_to_collection(&[a, b], "Work").unwrap();
        assert_eq!(s.get(a).unwrap().collections, vec!["Work"]);
        s.rename_collection("Work", "Studio").unwrap();
        assert_eq!(s.get(a).unwrap().collections, vec!["Studio"]);
        assert_eq!(s.collections().unwrap(), vec!["Play", "Studio"]);
        assert!(s.rename_collection("Studio", "play").is_err());
        s.delete_collection("Studio").unwrap();
        assert!(s.get(a).unwrap().collections.is_empty());
        assert!(s.get(b).unwrap().collections.is_empty());
        s.update_many(
            &[a, b],
            &ItemPatch {
                favorite: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(s.get(a).unwrap().favorite);
        assert!(s.get(b).unwrap().favorite);
        assert!(s.update_many(&[], &ItemPatch::default()).is_err());
    }
    #[test]
    fn default_501st_item_trashes_oldest_but_snapshot_is_complete() {
        let mut s = memory();
        let at = now();
        let first = s.capture(&text("first synthetic"), at).unwrap();
        for i in 1..=500 {
            s.capture(&text(&format!("synthetic {i}")), at + i).unwrap();
        }
        let all = s.list().unwrap();
        assert_eq!(all.len(), 501);
        assert_eq!(all.iter().filter(|c| !c.deleted).count(), 500);
        assert!(s.get(first).unwrap().deleted);
        let deleted_at = s.get(first).unwrap().deleted_at.unwrap();
        s.maintain(deleted_at + 7 * DAY - 1).unwrap();
        assert!(s.get(first).is_ok());
        s.maintain(deleted_at + 7 * DAY).unwrap();
        assert!(s.get(first).is_err());
    }
    #[test]
    fn image_hash_limits_quota_and_summary() {
        let mut s = memory();
        let a = Capture::rgba(1, 1, &[1, 2, 3, 255]).unwrap();
        let b = Capture::rgba(1, 1, &[1, 2, 3, 255]).unwrap();
        assert_eq!(a.hash, b.hash);
        assert!(Capture::rgba(MAX_PIXELS + 1, 1, &[]).is_err());
        assert!(Capture::rgba(1, 1, &[0]).is_err());
        let id = s.capture(&a, now()).unwrap();
        assert!(s.list().unwrap()[0].content.is_empty());
        assert!(s.image(id).unwrap().1.starts_with(b"\x89PNG"));
        assert_eq!(s.capture(&b, now()).unwrap(), id);
        // Synthetic zero blobs exercise aggregate quota without reading a clipboard.
        s.conn
            .execute(
                "UPDATE items SET png=zeroblob(?1) WHERE id=?2",
                params![MAX_TOTAL, id],
            )
            .unwrap();
        let c = Capture::rgba(1, 1, &[4, 5, 6, 255]).unwrap();
        assert!(s.capture(&c, now()).unwrap_err().contains("500 MiB"));
        assert!(s.capture(&text("text still works"), now()).is_ok());
    }
    #[test]
    fn pin_flag_survives_updates_and_trash_restore() {
        let mut s = memory();
        let at = now();
        let id = s.capture(&text("synthetic pin"), at).unwrap();
        assert!(!s.get(id).unwrap().pinned);
        s.update(
            id,
            ItemPatch {
                pinned: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(s.get(id).unwrap().pinned);
        s.update(
            id,
            ItemPatch {
                deleted: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(s
            .update(
                id,
                ItemPatch {
                    pinned: Some(false),
                    ..Default::default()
                }
            )
            .is_err());
        s.update(
            id,
            ItemPatch {
                deleted: Some(false),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(s.get(id).unwrap().pinned);
        s.settings.max_items = 1;
        let later = now();
        s.capture(&text("newer a"), later).unwrap();
        s.capture(&text("newer b"), later + 1).unwrap();
        assert!(!s.get(id).unwrap().deleted, "pinned items bypass retention");
    }
    #[test]
    fn trigram_search_tracks_updates_and_short_queries() {
        let mut s = memory();
        let at = now();
        let id = s.capture(&text("Synthetic alpha body"), at).unwrap();
        assert_eq!(s.search("alpha body").unwrap(), vec![id]);
        assert_eq!(s.search("ALPHA").unwrap(), vec![id]);
        assert_eq!(s.search("al").unwrap(), vec![id]);
        assert!(s.search("\"alpha").unwrap().is_empty());
        s.update(
            id,
            ItemPatch {
                title: Some("renamed needle".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(s.search("renamed needle").unwrap(), vec![id]);
        s.update(
            id,
            ItemPatch {
                deleted: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        s.purge(id).unwrap();
        assert!(s.search("renamed needle").unwrap().is_empty());
    }
    #[test]
    fn backup_round_trip_restores_items_collections_and_pins() {
        let mut s = memory();
        let at = now();
        let id = s.capture(&text("backup synthetic body"), at).unwrap();
        s.create_collection("BackupKit").unwrap();
        s.set_collection_policy("BackupKit", Some(90), Some(1000))
            .unwrap();
        s.update(
            id,
            ItemPatch {
                favorite: Some(true),
                pinned: Some(true),
                note: Some("keep me".into()),
                collections: Some(vec!["BackupKit".into()]),
                ..Default::default()
            },
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("backup.sqlite3");
        s.export_to(&path).unwrap();
        assert!(path.exists());
        let mut fresh = memory();
        fresh.capture(&text("will be replaced"), at + 1).unwrap();
        fresh.import_from(&path).unwrap();
        assert_eq!(fresh.list().unwrap().len(), 1);
        let got = fresh.get(id).unwrap();
        assert!(got.favorite && got.pinned);
        assert_eq!(got.note, "keep me");
        assert_eq!(got.collections, vec!["BackupKit"]);
        assert_eq!(
            fresh.collection_policies().unwrap()[0],
            CollectionPolicy {
                name: "BackupKit".into(),
                retention_days: Some(90),
                max_items: Some(1000),
            }
        );
        assert_eq!(fresh.search("synthetic body").unwrap(), vec![id]);
    }
    #[test]
    fn schema_v4_backup_import_defaults_pin() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v4.sqlite3");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, hash TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, png BLOB, note TEXT NOT NULL DEFAULT '', favorite INTEGER NOT NULL DEFAULT 0, file_size INTEGER NOT NULL DEFAULT 0, file_modified INTEGER, meta TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', thumb BLOB, last_used INTEGER, use_count INTEGER NOT NULL DEFAULT 0, captured_at INTEGER NOT NULL, deleted_at INTEGER, UNIQUE(kind,hash));
             CREATE TABLE collections(name TEXT PRIMARY KEY COLLATE NOCASE);
             CREATE TABLE members(item_id INTEGER, name TEXT COLLATE NOCASE, PRIMARY KEY(item_id,name));
             CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             PRAGMA user_version=4;
             INSERT INTO items(kind,hash,title,content,captured_at) VALUES('text','old-v4','旧备份','正文',{});
             INSERT INTO collections(name) VALUES('旧集合');
             INSERT INTO members(item_id,name) VALUES(1,'旧集合');",
            now()
        ))
        .unwrap();
        drop(conn);
        let mut s = memory();
        s.import_from(&path).unwrap();
        let got = s.get(1).unwrap();
        assert_eq!(got.title, "旧备份");
        assert!(!got.pinned);
        assert_eq!(got.collections, vec!["旧集合"]);
        assert_eq!(s.search("旧备份").unwrap(), vec![1]);
    }
}
