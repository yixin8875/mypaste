mod logging;
mod platform;
mod storage;
mod store;
use base64::Engine;
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc, Arc, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant},
};
use store::{Clip, CollectionPolicy, ItemPatch, Result, Settings, SettingsPatch, Store};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    capture_state: String,
    capture_error: Option<String>,
    shortcut_registered: bool,
    shortcut_error: Option<String>,
    autostart: bool,
    elevated: bool,
    portable: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    items: Vec<Clip>,
    collections: Vec<String>,
    collection_policies: Vec<CollectionPolicy>,
    settings: Settings,
    sequence: SequenceStatus,
    status: Status,
    data_dir: String,
    storage_error: Option<String>,
}
#[derive(Serialize)]
struct PasteOutcome {
    copied: bool,
    status: &'static str,
    reason: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SequenceStatus {
    active: bool,
    total: usize,
    position: usize,
    current_title: Option<String>,
    remaining: usize,
}
#[derive(Clone, Debug)]
struct Sequence {
    entries: Vec<(i64, String)>,
    next: usize,
    started_at: Instant,
}
const SEQUENCE_IDLE: Duration = Duration::from_secs(600);
impl Sequence {
    fn status(&self) -> SequenceStatus {
        SequenceStatus {
            active: !self.entries.is_empty() && self.next < self.entries.len(),
            total: self.entries.len(),
            position: self.next,
            current_title: self
                .next
                .checked_sub(1)
                .and_then(|index| self.entries.get(index))
                .map(|(_, title)| title.clone()),
            remaining: self.entries.len().saturating_sub(self.next),
        }
    }
    fn expired(&self) -> bool {
        self.started_at.elapsed() > SEQUENCE_IDLE
    }
}
struct OwnWrite {
    sequence: u32,
    hash: String,
    until: Instant,
}
impl OwnWrite {
    fn matches(&self, sequence: u32, hash: &str, owned: bool, at: Instant) -> bool {
        owned && self.sequence == sequence && self.hash == hash && self.until >= at
    }
}
struct Inner {
    store: Store,
    capture_error: Option<String>,
    listener_ready: bool,
    shortcut_registered: bool,
    shortcut_error: Option<String>,
    autostart: bool,
    elevated: bool,
    portable: bool,
    baseline: u32,
    own: Option<OwnWrite>,
    sequence: Option<Sequence>,
}
impl Inner {
    fn status(&self) -> Status {
        Status {
            capture_state: if self.store.settings.paused {
                "paused"
            } else if self.capture_error.is_some() {
                "error"
            } else {
                "running"
            }
            .into(),
            capture_error: self.capture_error.clone(),
            shortcut_registered: self.shortcut_registered,
            shortcut_error: self.shortcut_error.clone(),
            autostart: self.autostart,
            elevated: self.elevated,
            portable: self.portable,
        }
    }
}
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
struct QuickSession {
    generation: u64,
    target: isize,
    pid: u32,
    pasting: bool,
}
impl QuickSession {
    fn open(&mut self, target: isize, pid: u32) {
        self.generation = self.generation.wrapping_add(1);
        self.target = target;
        self.pid = pid;
        self.pasting = false;
    }
    fn matches(&self, request: Self) -> bool {
        self.generation == request.generation
            && self.target == request.target
            && self.pid == request.pid
    }
    /// Bind a paste to this exact generation before any asynchronous clipboard work.
    fn claim(&mut self, request: Self) -> bool {
        if !self.matches(request) || self.pasting || request.target == 0 {
            return false;
        }
        self.pasting = true;
        true
    }
    /// Only the same session, still owning the paste, with our exact clipboard write may type Ctrl+V.
    fn permits(&self, request: Self, expected_sequence: u32, current_sequence: u32) -> bool {
        self.matches(request) && self.pasting && expected_sequence == current_sequence
    }
    fn release(&mut self, request: Self) {
        if self.matches(request) {
            self.pasting = false;
        }
    }
    fn invalidate(&mut self) {
        self.open(0, 0);
    }
}
/// Tracks the lazily created quick webview. The window stays hidden until its
/// page has finished loading, so the first shortcut never shows a blank webview.
#[derive(Default)]
struct QuickUi {
    loaded: bool,
    pending: bool,
    shown_at: Option<Instant>,
    target: isize,
}
struct AppState {
    inner: Arc<Mutex<Inner>>,
    data_dir: String,
    portable: bool,
    storage_error: Option<String>,
    quick: Arc<Mutex<QuickSession>>,
    quick_ui: Mutex<QuickUi>,
    stop: Arc<AtomicBool>,
    listener_thread: AtomicU32,
    workers: Mutex<Vec<thread::JoinHandle<()>>>,
}
fn lock(state: &AppState) -> Result<MutexGuard<'_, Inner>> {
    state
        .inner
        .lock()
        .map_err(|_| "Native coordinator lock is poisoned".into())
}
fn allowed(window: &tauri::WebviewWindow) -> Result<()> {
    if !matches!(window.label(), "main" | "quick") {
        Err("This command is restricted to MyPaste windows".into())
    } else {
        Ok(())
    }
}
fn app_key(value: &str) -> String {
    let value = value.trim().to_ascii_lowercase();
    value.strip_suffix(".exe").unwrap_or(&value).to_string()
}
fn excluded_source(settings: &Settings, source: &str) -> bool {
    let source = app_key(source);
    !source.is_empty()
        && settings
            .excluded_apps
            .iter()
            .any(|app| app_key(app) == source)
}
fn notify(app: &tauri::AppHandle, event: &str) {
    if let Err(error) = app.emit_to("main", event, ()) {
        eprintln!("Event delivery failed ({event}): {error}");
    }
}
fn changed(app: &tauri::AppHandle) {
    notify(app, "history://changed");
}
fn status_changed(app: &tauri::AppHandle) {
    notify(app, "capture://status");
}
/// Notify through Windows when the quick window has already hidden itself, so
/// a paste result is not lost with the window.
fn system_notify(app: &tauri::AppHandle, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(error) = app
        .notification()
        .builder()
        .title("MyPaste")
        .body(body)
        .show()
    {
        eprintln!("System notification failed: {error}");
    }
}

#[tauri::command]
fn get_snapshot(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<Snapshot> {
    allowed(&window)?;
    let s = lock(&state)?;
    Ok(Snapshot {
        items: s.store.list()?,
        collections: s.store.collections()?,
        collection_policies: s.store.collection_policies()?,
        settings: s.store.settings.clone(),
        sequence: s
            .sequence
            .as_ref()
            .map(Sequence::status)
            .unwrap_or_default(),
        status: s.status(),
        data_dir: state.data_dir.clone(),
        storage_error: state.storage_error.clone(),
    })
}
#[tauri::command]
fn get_item(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<Clip> {
    allowed(&window)?;
    lock(&state)?.store.get(id)
}
#[tauri::command]
fn search_items(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    query: String,
) -> Result<Vec<i64>> {
    allowed(&window)?;
    lock(&state)?.store.search(&query)
}
#[tauri::command]
fn update_item(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: i64,
    patch: ItemPatch,
) -> Result<()> {
    allowed(&window)?;
    lock(&state)?.store.update(id, patch)?;
    changed(&app);
    Ok(())
}
#[tauri::command]
fn purge_item(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<()> {
    allowed(&window)?;
    lock(&state)?.store.purge(id)?;
    changed(&app);
    Ok(())
}
#[tauri::command]
fn create_collection(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<()> {
    allowed(&window)?;
    lock(&state)?.store.create_collection(&name)?;
    changed(&app);
    Ok(())
}
#[tauri::command]
fn rename_collection(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    old_name: String,
    new_name: String,
) -> Result<()> {
    allowed(&window)?;
    lock(&state)?
        .store
        .rename_collection(&old_name, &new_name)?;
    changed(&app);
    Ok(())
}
#[tauri::command]
fn delete_collection(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<()> {
    allowed(&window)?;
    lock(&state)?.store.delete_collection(&name)?;
    changed(&app);
    Ok(())
}
#[tauri::command]
fn move_collection(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    name: String,
    direction: String,
) -> Result<()> {
    allowed(&window)?;
    lock(&state)?.store.move_collection(&name, &direction)?;
    changed(&app);
    Ok(())
}
#[tauri::command]
fn update_items(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    ids: Vec<i64>,
    patch: ItemPatch,
) -> Result<()> {
    allowed(&window)?;
    lock(&state)?.store.update_many(&ids, &patch)?;
    changed(&app);
    Ok(())
}
#[tauri::command]
fn add_to_collection(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    ids: Vec<i64>,
    name: String,
) -> Result<()> {
    allowed(&window)?;
    lock(&state)?.store.add_to_collection(&ids, &name)?;
    changed(&app);
    Ok(())
}
/// Set or clear one collection's retention override. Missing values follow global settings.
#[tauri::command]
fn set_collection_policy(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    name: String,
    retention_days: Option<i64>,
    max_items: Option<i64>,
) -> Result<()> {
    allowed(&window)?;
    lock(&state)?
        .store
        .set_collection_policy(&name, retention_days, max_items)?;
    changed(&app);
    Ok(())
}

fn set_settings(app: &tauri::AppHandle, state: &AppState, patch: SettingsPatch) -> Result<()> {
    let mut s = lock(state)?;
    let old = s.store.settings.clone();
    let next = patch.apply(&old)?;
    let new_key: Shortcut = next
        .shortcut
        .parse()
        .map_err(|e| format!("Invalid shortcut: {e}"))?;
    let old_key: Shortcut = old
        .shortcut
        .parse()
        .map_err(|e| format!("Invalid saved shortcut: {e}"))?;
    let different = new_key != old_key;
    let retry = patch.shortcut.is_some() && !s.shortcut_registered;
    if different || retry {
        if let Err(error) = app.global_shortcut().register(new_key) {
            s.shortcut_error = Some(format!(
                "Shortcut registration failed; previous shortcut retained: {error}"
            ));
            drop(s);
            status_changed(app);
            return Err(format!("Shortcut registration failed: {error}"));
        }
        if different && s.shortcut_registered {
            if let Err(error) = app.global_shortcut().unregister(old_key) {
                let rollback = app.global_shortcut().unregister(new_key);
                s.shortcut_error=Some(format!("Cannot unregister previous shortcut: {error}; new shortcut rollback: {rollback:?}"));
                drop(s);
                status_changed(app);
                return Err(format!("Cannot replace previous shortcut: {error}"));
            }
        }
    }
    if let Err(error) = s.store.save_settings(next.clone()) {
        if different || retry {
            let remove = app.global_shortcut().unregister(new_key);
            let restore = if different && s.shortcut_registered {
                app.global_shortcut().register(old_key)
            } else {
                Ok(())
            };
            if remove.is_err() || restore.is_err() {
                s.shortcut_registered = false;
                s.shortcut_error = Some(format!(
                    "Shortcut rollback failed: remove={remove:?}; restore={restore:?}"
                ));
            }
        }
        drop(s);
        status_changed(app);
        return Err(error);
    }
    if different || retry {
        s.shortcut_registered = true;
        s.shortcut_error = None;
    }
    // Same lock is the pause barrier: a capture cannot commit after this baseline update.
    if next.paused != old.paused {
        s.baseline = platform::sequence();
        s.own = None;
        if s.listener_ready {
            s.capture_error = None;
        }
    }
    let maintenance = s.store.maintain(store::now());
    drop(s);
    changed(app);
    status_changed(app);
    maintenance.map(|_| ())
}
#[tauri::command]
fn update_settings(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    patch: SettingsPatch,
) -> Result<()> {
    allowed(&window)?;
    set_settings(&app, &state, patch)
}
fn copy_locked(s: &mut Inner, id: i64) -> Result<u32> {
    let item = s.store.get(id)?;
    if item.deleted {
        return Err("Restore this item before copying".into());
    }
    let png = if item.kind == "image" {
        Some(s.store.image(id)?.1)
    } else {
        None
    };
    let (html, rtf) = if item.kind == "text" || item.kind == "link" {
        s.store.rich(id)?
    } else {
        (None, None)
    };
    let hash = s.store.hash(id)?;
    // Clipboard writes and capture reads are serialized, including notifications racing with write return.
    s.own = None;
    let sequence = if item.kind == "file" {
        let paths: Vec<String> = item.content.split('\n').map(str::to_string).collect();
        platform::copy_files(&paths)?
    } else {
        platform::copy_formats(
            &item.content,
            png.as_deref(),
            html.as_deref(),
            rtf.as_deref(),
        )?
    };
    if platform::sequence() == sequence && platform::owns_clipboard() {
        s.own = Some(OwnWrite {
            sequence,
            hash,
            until: Instant::now() + Duration::from_secs(1),
        });
    }
    if let Err(error) = s.store.mark_used(id, store::now()) {
        eprintln!("Usage tracking failed for item {id}: {error}");
    }
    Ok(sequence)
}
fn copy_native(state: &AppState, id: i64) -> Result<u32> {
    let mut inner = lock(state)?;
    copy_locked(&mut inner, id)
}
fn sequence_entries(store: &Store, ids: &[i64]) -> Result<Vec<(i64, String)>> {
    if ids.is_empty() {
        return Err("请至少选择一条记录".into());
    }
    if ids.len() > 200 {
        return Err("一次最多序列粘贴 200 条记录".into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut entries = Vec::new();
    for id in ids {
        if !seen.insert(*id) {
            continue;
        }
        let item = store.get(*id)?;
        if item.deleted {
            return Err("请先恢复最近删除中的记录，再开始序列粘贴".into());
        }
        entries.push((*id, item.title));
    }
    Ok(entries)
}
/// Copy the next queued record inside an existing coordinator lock.
/// `Ok(None)` means no live sequence (never started, finished or expired).
fn sequence_advance_locked(s: &mut Inner) -> Result<Option<(SequenceStatus, u32)>> {
    let Some(sequence) = s.sequence.as_ref() else {
        return Ok(None);
    };
    if sequence.expired() {
        s.sequence = None;
        logging::event("WARN", "Sequence expired after 10 minutes idle");
        return Ok(None);
    }
    let index = sequence.next;
    let id = sequence.entries[index].0;
    let copied = match copy_locked(s, id) {
        Ok(sequence) => sequence,
        Err(error) => {
            s.sequence = None;
            return Err(error);
        }
    };
    let status = {
        let sequence = s.sequence.as_mut().expect("sequence checked above");
        sequence.next = index + 1;
        sequence.started_at = Instant::now();
        sequence.status()
    };
    if status.remaining == 0 {
        s.sequence = None;
    }
    Ok(Some((status, copied)))
}
fn sequence_start_locked(s: &mut Inner, ids: &[i64]) -> Result<SequenceStatus> {
    let entries = sequence_entries(&s.store, ids)?;
    let first = entries[0].0;
    copy_locked(s, first)?;
    let total = entries.len();
    let current_title = entries.first().map(|(_, title)| title.clone());
    if total > 1 {
        s.sequence = Some(Sequence {
            entries,
            next: 1,
            started_at: Instant::now(),
        });
        Ok(s.sequence
            .as_ref()
            .map(Sequence::status)
            .unwrap_or_default())
    } else {
        s.sequence = None;
        Ok(SequenceStatus {
            active: false,
            total,
            position: 1,
            current_title,
            remaining: 0,
        })
    }
}
fn sequence_changed(app: &tauri::AppHandle, status: &SequenceStatus) {
    if let Err(error) = app.emit_to("main", "sequence://changed", status.clone()) {
        eprintln!("Sequence event delivery failed: {error}");
    }
}
/// The global shortcut doubles as "paste the next item" while a sequence is active.
/// It never advances while the quick panel is open, so re-summoning still works.
fn try_sequence_shortcut(app: &tauri::AppHandle) -> bool {
    if app
        .get_webview_window("quick")
        .is_some_and(|window| window.is_visible().unwrap_or(false))
    {
        return false;
    }
    let (target, pid) = platform::foreground();
    let state = app.state::<AppState>();
    let advanced = match state.inner.lock() {
        Ok(mut inner) => match sequence_advance_locked(&mut inner) {
            Ok(value) => value,
            Err(error) => {
                logging::event("ERROR", &format!("Sequence copy failed: {error}"));
                system_notify(app, &format!("序列粘贴已结束：{error}"));
                None
            }
        },
        Err(_) => None,
    };
    let Some((status, clipboard_sequence)) = advanced else {
        return false;
    };
    changed(app);
    sequence_changed(app, &status);
    logging::event(
        "INFO",
        &format!("Sequence advanced to {}/{}", status.position, status.total),
    );
    if target == 0 {
        system_notify(
            app,
            &format!(
                "已复制序列第 {}/{} 项，请到目标应用粘贴",
                status.position, status.total
            ),
        );
        return true;
    }
    let handle = app.clone();
    thread::spawn(move || {
        if let Err(reason) = platform::paste(target, pid, clipboard_sequence) {
            system_notify(&handle, &reason);
        }
    });
    true
}
#[tauri::command]
fn start_sequence(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    ids: Vec<i64>,
) -> Result<SequenceStatus> {
    if window.label() != "main" {
        return Err("只能从主窗口开始序列粘贴".into());
    }
    let mut inner = lock(&state)?;
    let status = sequence_start_locked(&mut inner, &ids)?;
    drop(inner);
    changed(&app);
    sequence_changed(&app, &status);
    logging::event(
        "INFO",
        &format!(
            "Sequence started with {} item(s); first copied",
            status.total
        ),
    );
    Ok(status)
}
#[tauri::command]
fn sequence_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<SequenceStatus> {
    allowed(&window)?;
    Ok(lock(&state)?
        .sequence
        .as_ref()
        .map(Sequence::status)
        .unwrap_or_default())
}
#[tauri::command]
fn sequence_next(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<SequenceStatus> {
    if window.label() != "main" {
        return Err("只能从主窗口推进序列粘贴".into());
    }
    let mut inner = lock(&state)?;
    let status = sequence_advance_locked(&mut inner)?
        .map(|(status, _)| status)
        .unwrap_or_default();
    drop(inner);
    changed(&app);
    sequence_changed(&app, &status);
    Ok(status)
}
#[tauri::command]
fn stop_sequence(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<SequenceStatus> {
    if window.label() != "main" {
        return Err("只能从主窗口结束序列粘贴".into());
    }
    let mut inner = lock(&state)?;
    let status = SequenceStatus::default();
    if inner.sequence.take().is_some() {
        logging::event("INFO", "Sequence stopped by the user");
    }
    drop(inner);
    sequence_changed(&app, &status);
    Ok(status)
}
#[tauri::command]
fn copy_item(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<()> {
    allowed(&window)?;
    copy_native(&state, id).map_err(|error| {
        logging::event("ERROR", &format!("Copy failed for item {id}: {error}"));
        error
    })?;
    changed(&app);
    // The quick window closes right after copying; confirm the result in the system tray area.
    if window.label() == "quick" {
        system_notify(&app, "已复制到剪贴板");
    }
    Ok(())
}
fn transform_text(content: &str, mode: &str) -> Result<String> {
    let text = match mode {
        "plain" => content.to_string(),
        "trim" => content.trim().to_string(),
        "one_line" => content
            .replace("\r\n", " ")
            .replace('\r', " ")
            .replace('\n', " ")
            .trim()
            .to_string(),
        _ => return Err("未知的复制方式".into()),
    };
    if text.is_empty() {
        return Err("转换后的内容为空".into());
    }
    Ok(text)
}
fn copy_variant_native(state: &AppState, id: i64, mode: &str) -> Result<()> {
    let mut s = lock(state)?;
    let item = s.store.get(id)?;
    if item.deleted {
        return Err("Restore this item before copying".into());
    }
    if item.kind != "text" && item.kind != "link" {
        return Err("只有文本与链接可以转换后复制".into());
    }
    let text = transform_text(&item.content, mode)?;
    let kind = if store::http_url(&text).is_ok() {
        "link"
    } else {
        "text"
    };
    s.own = None;
    let sequence = platform::copy(&text, None)?;
    if platform::sequence() == sequence && platform::owns_clipboard() {
        s.own = Some(OwnWrite {
            sequence,
            hash: store::digest(kind, text.as_bytes()),
            until: Instant::now() + Duration::from_secs(1),
        });
    }
    if let Err(error) = s.store.mark_used(id, store::now()) {
        eprintln!("Usage tracking failed for item {id}: {error}");
    }
    Ok(())
}
#[tauri::command]
fn copy_item_variant(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: i64,
    mode: String,
) -> Result<()> {
    allowed(&window)?;
    copy_variant_native(&state, id, &mode).map_err(|error| {
        logging::event(
            "ERROR",
            &format!("Copy variant failed for item {id}: {error}"),
        );
        error
    })?;
    changed(&app);
    if window.label() == "quick" {
        let label = match mode.as_str() {
            "trim" => "已复制，首尾空白已去除",
            "one_line" => "已复制为单行",
            _ => "已复制为纯文本",
        };
        system_notify(&app, label);
    }
    Ok(())
}
/// Select exactly one stored rich format; a missing payload is reported before any clipboard write.
fn select_rich(
    format: &str,
    html: Option<Vec<u8>>,
    rtf: Option<Vec<u8>>,
) -> Result<(Option<Vec<u8>>, Option<Vec<u8>>)> {
    match format {
        "html" if html.is_none() => Err("这条记录没有保存 HTML 格式".into()),
        "rtf" if rtf.is_none() => Err("这条记录没有保存 RTF 格式".into()),
        "html" => Ok((html, None)),
        "rtf" => Ok((None, rtf)),
        _ => Err("未知的复制格式".into()),
    }
}
fn copy_format_native(state: &AppState, id: i64, format: &str) -> Result<()> {
    let mut s = lock(state)?;
    let item = s.store.get(id)?;
    if item.deleted {
        return Err("Restore this item before copying".into());
    }
    if item.kind != "text" && item.kind != "link" {
        return Err("只有文本与链接可以按格式复制".into());
    }
    let (html, rtf) = s.store.rich(id)?;
    let (html, rtf) = select_rich(format, html, rtf)?;
    s.own = None;
    let sequence = platform::copy_formats(&item.content, None, html.as_deref(), rtf.as_deref())?;
    if platform::sequence() == sequence && platform::owns_clipboard() {
        s.own = Some(OwnWrite {
            sequence,
            hash: store::digest(&item.kind, item.content.as_bytes()),
            until: Instant::now() + Duration::from_secs(1),
        });
    }
    if let Err(error) = s.store.mark_used(id, store::now()) {
        eprintln!("Usage tracking failed for item {id}: {error}");
    }
    Ok(())
}
#[tauri::command]
fn copy_item_format(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: i64,
    format: String,
) -> Result<()> {
    allowed(&window)?;
    copy_format_native(&state, id, &format).map_err(|error| {
        logging::event(
            "ERROR",
            &format!("Copy format {format} failed for item {id}: {error}"),
        );
        error
    })?;
    changed(&app);
    if window.label() == "quick" {
        system_notify(
            &app,
            if format == "rtf" {
                "已复制为 RTF 格式"
            } else {
                "已复制为 HTML 格式"
            },
        );
    }
    Ok(())
}
#[tauri::command]
fn get_image(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<String> {
    allowed(&window)?;
    let (mime, bytes) = lock(&state)?.store.image(id)?;
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}
#[tauri::command]
fn get_thumbnail(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<String> {
    allowed(&window)?;
    let png = lock(&state)?.store.thumbnail(id)?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    ))
}
fn release_paste(state: &AppState, request: QuickSession) {
    if let Ok(mut session) = state.quick.lock() {
        session.release(request);
    }
}
#[tauri::command]
async fn paste_item(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    id: i64,
) -> Result<PasteOutcome> {
    allowed(&window)?;
    let state = app.state::<AppState>();
    // Bind the quick-window generation and its external target before any async clipboard work.
    // A later global invocation opens a new generation, so this request can no longer type into it.
    let bound = {
        let mut session = state
            .quick
            .lock()
            .map_err(|_| "Quick session lock is poisoned".to_string())?;
        let request = *session;
        if request.target != 0 && session.claim(request) {
            Some(request)
        } else {
            None
        }
    };
    let app_clone = app.clone();
    let copied = tauri::async_runtime::spawn_blocking(move || {
        copy_native(&app_clone.state::<AppState>(), id)
    })
    .await;
    let sequence = match copied {
        Err(error) => {
            return Ok(PasteOutcome {
                copied: false,
                status: "clipboard_failed",
                reason: Some(format!("Clipboard worker failed: {error}")),
            })
        }
        Ok(Err(reason)) => {
            return Ok(PasteOutcome {
                copied: false,
                status: "clipboard_failed",
                reason: Some(reason),
            })
        }
        Ok(Ok(sequence)) => sequence,
    };
    // Usage counts changed; let the open list refresh without waiting for the next capture.
    changed(&app);
    let Some(request) = bound else {
        return Ok(PasteOutcome {
            copied: true,
            status: "manual_required",
            reason: Some("已复制；没有可靠的快捷键呼出目标，请切回目标应用手动 Ctrl+V".into()),
        });
    };
    let permits = state
        .quick
        .lock()
        .map(|session| session.permits(request, sequence, platform::sequence()))
        .unwrap_or(false);
    if !permits {
        release_paste(&state, request);
        return Ok(PasteOutcome {
            copied: true,
            status: "manual_required",
            reason: Some("已复制；窗口或剪贴板在等待期间已改变，请检查后手动 Ctrl+V".into()),
        });
    }
    let focused = match window.is_focused() {
        Ok(focused) => focused,
        Err(error) => {
            release_paste(&state, request);
            return Ok(PasteOutcome {
                copied: true,
                status: "manual_required",
                reason: Some(format!("已复制；无法验证窗口焦点: {error}，请手动 Ctrl+V")),
            });
        }
    };
    if !focused {
        release_paste(&state, request);
        return Ok(PasteOutcome {
            copied: true,
            status: "manual_required",
            reason: Some("已复制；窗口焦点已改变，请切回目标应用手动 Ctrl+V".into()),
        });
    }
    if let Err(error) = window.hide() {
        release_paste(&state, request);
        return Ok(PasteOutcome {
            copied: true,
            status: "manual_required",
            reason: Some(format!("已复制；无法隐藏窗口: {error}，请手动 Ctrl+V")),
        });
    }
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        platform::paste(request.target, request.pid, sequence)
    })
    .await;
    release_paste(&state, request);
    let outcome = match outcome {
        Ok(Ok(())) => PasteOutcome {
            copied: true,
            status: "input_sent",
            reason: Some("已发送粘贴指令；若未生效请手动 Ctrl+V".into()),
        },
        Ok(Err(reason)) => PasteOutcome {
            copied: true,
            status: "manual_required",
            reason: Some(reason),
        },
        Err(error) => PasteOutcome {
            copied: true,
            status: "manual_required",
            reason: Some(format!("已复制；粘贴线程失败: {error}，请手动 Ctrl+V")),
        },
    };
    if outcome.status == "input_sent" && !window.is_visible().unwrap_or(true) {
        if let Some(reason) = outcome.reason.as_deref() {
            system_notify(&app, reason);
        }
    }
    Ok(outcome)
}
#[tauri::command]
fn open_link(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<()> {
    allowed(&window)?;
    let item = lock(&state)?.store.get(id)?;
    if item.deleted || item.kind != "link" {
        return Err("Only active HTTP(S) links may be opened".into());
    }
    let url = store::http_url(&item.content)?;
    open::that(url.as_str()).map_err(|e| format!("System browser could not be opened: {e}"))
}
#[tauri::command]
fn hide_quick_window(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    allowed(&window)?;
    if let Ok(mut session) = state.quick.lock() {
        session.invalidate();
    }
    window
        .hide()
        .map_err(|e| format!("Cannot hide quick window: {e}"))
}
fn live_database(state: &AppState) -> std::path::PathBuf {
    std::path::Path::new(&state.data_dir).join("history.sqlite3")
}
#[tauri::command]
fn export_backup(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<String> {
    allowed(&window)?;
    if window.label() != "main" {
        return Err("Backups can only be exported from the main window".into());
    }
    let target = std::path::PathBuf::from(&path);
    if !target.is_absolute() {
        return Err("备份路径必须是绝对路径".into());
    }
    if target == live_database(&state) {
        return Err("不能覆盖当前正在使用的数据库".into());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建备份目录：{e}"))?;
    }
    if target.exists() {
        std::fs::remove_file(&target).map_err(|e| format!("无法覆盖已有备份文件：{e}"))?;
    }
    lock(&state)?.store.export_to(&target)?;
    logging::event("INFO", "Backup exported");
    Ok(path)
}
#[tauri::command]
fn import_backup(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<()> {
    allowed(&window)?;
    if window.label() != "main" {
        return Err("Backups can only be restored from the main window".into());
    }
    let source = std::path::PathBuf::from(&path);
    if !source.is_absolute() || !source.is_file() {
        return Err("请选择有效的备份文件".into());
    }
    if source == live_database(&state) {
        return Err("不能从当前正在使用的数据库恢复".into());
    }
    lock(&state)?.store.import_from(&source)?;
    logging::event("INFO", "Backup restored");
    changed(&app);
    Ok(())
}
#[tauri::command]
fn open_data_dir(window: tauri::WebviewWindow, state: tauri::State<'_, AppState>) -> Result<()> {
    allowed(&window)?;
    open::that(&state.data_dir).map_err(|e| format!("无法打开数据目录：{e}"))
}
#[tauri::command]
fn set_data_dir(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<()> {
    if window.label() != "main" {
        return Err("只能从主窗口修改存储路径".into());
    }
    if state.portable {
        return Err("便携模式的数据固定保存在程序目录，无法在此修改".into());
    }
    if cfg!(debug_assertions) && std::env::var_os("MYPASTE_DATA_DIR").is_some() {
        return Err("当前由 MYPASTE_DATA_DIR 指定存储位置，无法在此修改".into());
    }
    let target = std::path::PathBuf::from(&path);
    if !target.is_absolute() {
        return Err("存储路径必须是绝对路径".into());
    }
    std::fs::create_dir_all(&target).map_err(|e| format!("无法创建目标目录：{e}"))?;
    let current =
        std::fs::canonicalize(&state.data_dir).map_err(|e| format!("无法读取当前目录：{e}"))?;
    let target = std::fs::canonicalize(&target).map_err(|e| format!("无法读取目标目录：{e}"))?;
    if current == target {
        return Err("已经是当前存储位置".into());
    }
    if target.join("history.sqlite3").exists() {
        return Err("目标目录已有 MyPaste 数据，请选择空目录".into());
    }
    let probe = target.join(".mypaste-write-probe");
    std::fs::write(&probe, b"1").map_err(|e| format!("目标目录不可写：{e}"))?;
    let _ = std::fs::remove_file(&probe);
    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    storage::save(
        &config_dir,
        &storage::StorageConfig {
            data_dir: Some(state.data_dir.clone()),
            pending_dir: Some(target.to_string_lossy().into_owned()),
        },
    )?;
    app.restart()
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DbUsage {
    bytes: i64,
    items: i64,
    trashed: i64,
}
fn database_usage(state: &AppState) -> Result<DbUsage> {
    let dir = std::path::Path::new(&state.data_dir);
    let bytes = [
        "history.sqlite3",
        "history.sqlite3-wal",
        "history.sqlite3-shm",
    ]
    .iter()
    .filter_map(|name| std::fs::metadata(dir.join(name)).ok())
    .map(|meta| meta.len() as i64)
    .sum();
    let (items, trashed) = lock(state)?.store.counts()?;
    Ok(DbUsage {
        bytes,
        items,
        trashed,
    })
}
#[tauri::command]
fn data_usage(window: tauri::WebviewWindow, state: tauri::State<'_, AppState>) -> Result<DbUsage> {
    allowed(&window)?;
    database_usage(&state)
}
#[tauri::command]
fn compact_database(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<DbUsage> {
    allowed(&window)?;
    if window.label() != "main" {
        return Err("只能从主窗口整理数据库".into());
    }
    lock(&state)?.store.compact()?;
    database_usage(&state)
}
#[tauri::command]
fn set_autostart(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<bool> {
    allowed(&window)?;
    if window.label() != "main" {
        return Err("只能从主窗口修改开机启动".into());
    }
    platform::set_autostart(enabled)?;
    lock(&state)?.autostart = enabled;
    Ok(enabled)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogInfo {
    dir: String,
    file: String,
    bytes: u64,
}
fn log_info() -> LogInfo {
    LogInfo {
        dir: logging::dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
        file: logging::file()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
        bytes: logging::size(),
    }
}
#[tauri::command]
fn get_log_info(window: tauri::WebviewWindow) -> Result<LogInfo> {
    allowed(&window)?;
    Ok(log_info())
}
#[tauri::command]
fn open_log_dir(window: tauri::WebviewWindow, state: tauri::State<'_, AppState>) -> Result<()> {
    if window.label() != "main" {
        return Err("只能从主窗口打开日志目录".into());
    }
    let _ = &state;
    let dir = logging::dir().ok_or("诊断日志目录不可用")?;
    open::that(dir).map_err(|e| format!("无法打开日志目录：{e}"))
}
/// Write a plain-text support snapshot: app/system metadata, counts and recent
/// diagnostics. Clipboard bodies, search terms and window titles are never included.
#[tauri::command]
fn export_diagnostics(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<String> {
    if window.label() != "main" {
        return Err("只能从主窗口导出诊断信息".into());
    }
    let target = std::path::PathBuf::from(&path);
    if !target.is_absolute() {
        return Err("诊断文件路径必须是绝对路径".into());
    }
    if target == live_database(&state) {
        return Err("不能覆盖当前数据库".into());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建诊断目录：{e}"))?;
    }
    let (items, trashed) = lock(&state)?.store.counts()?;
    let inner = lock(&state)?;
    let settings = &inner.store.settings;
    let body = format!(
        "MyPaste diagnostics\nversion: {}\nplatform: {} {}\ngenerated: {}\ndataDir: {}\nlogDir: {}\nportable: {}\nelevated: {}\npaused: {}\nretentionDays: {}\nmaxItems: {}\nshortcut: {}\nexcludedApps: {}\nitems: {items}\ntrashed: {trashed}\n\nrecent log:\n{}\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%:z"),
        state.data_dir,
        logging::dir()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_default(),
        inner.portable,
        inner.elevated,
        settings.paused,
        settings.retention_days,
        settings.max_items,
        settings.shortcut,
        settings.excluded_apps.len(),
        logging::tail(200).join("\n")
    );
    std::fs::write(&target, body).map_err(|e| format!("无法写入诊断文件：{e}"))?;
    logging::event("INFO", "Diagnostics exported");
    Ok(path)
}
/// Relaunch through the UAC prompt. Windows starts the elevated copy; this process
/// exits only after the launch call succeeds, so a cancelled prompt keeps it running.
#[tauri::command]
fn restart_elevated(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    if window.label() != "main" {
        return Err("只能从主窗口请求管理员启动".into());
    }
    if lock(&state)?.elevated {
        return Err("当前已经是管理员权限".into());
    }
    platform::restart_elevated()?;
    logging::event("INFO", "Relaunching with administrator privileges");
    app.exit(0);
    Ok(())
}

fn quick_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow> {
    if let Some(window) = app.get_webview_window("quick") {
        return Ok(window);
    }
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "quick",
        tauri::WebviewUrl::App("index.html#quick".into()),
    )
    .title("MyPaste 快捷窗口")
    .inner_size(640.0, 610.0)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .center()
    .visible(false)
    .on_navigation(trusted_url)
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .on_page_load(|window, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Finished {
            quick_window_ready(&window);
        }
    })
    .build()
    .map_err(|e| format!("Cannot create quick window: {e}"))?;
    let handle = window.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Focused(false) => {
            if !handle.is_visible().unwrap_or(false) {
                return;
            }
            if let Some(state) = handle.try_state::<AppState>() {
                // Creating the webview briefly disturbs activation; never let
                // that spurious blur hide the window right after it opened.
                if quick_focus_grace(&state) {
                    return;
                }
                if let Ok(mut session) = state.quick.lock() {
                    session.invalidate();
                }
            }
            let _ = handle.hide();
        }
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = handle.hide();
        }
        _ => {}
    });
    Ok(window)
}
fn quick_focus_grace(state: &AppState) -> bool {
    state
        .quick_ui
        .lock()
        .ok()
        .and_then(|ui| ui.shown_at)
        .is_some_and(|at| at.elapsed() < Duration::from_millis(600))
}
fn show_quick_window(window: &tauri::WebviewWindow, state: &AppState) -> Result<()> {
    let target = state.quick_ui.lock().map(|ui| ui.target).unwrap_or(0);
    position_quick(window, target)?;
    if let Ok(mut ui) = state.quick_ui.lock() {
        ui.shown_at = Some(Instant::now());
    }
    window.unminimize().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}
/// Center the quick window on the monitor that showed the app at shortcut time,
/// so multi-monitor users do not have to chase it back to the primary display.
fn position_quick(window: &tauri::WebviewWindow, target: isize) -> Result<()> {
    let Some((left, top, right, bottom)) = platform::work_area(target) else {
        return Ok(());
    };
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let (width, height) = (size.width as i32, size.height as i32);
    let (area_width, area_height) = (right - left, bottom - top);
    if width <= 0 || height <= 0 || width > area_width || height > area_height {
        return Ok(());
    }
    window
        .set_position(tauri::PhysicalPosition::new(
            left + (area_width - width) / 2,
            top + (area_height - height) / 2,
        ))
        .map_err(|e| e.to_string())
}
fn quick_window_ready(window: &tauri::WebviewWindow) {
    let Some(state) = window.try_state::<AppState>() else {
        return;
    };
    let pending = state
        .quick_ui
        .lock()
        .map(|mut ui| {
            ui.loaded = true;
            std::mem::take(&mut ui.pending)
        })
        .unwrap_or(false);
    if pending {
        if let Err(error) = show_quick_window(window, &state) {
            eprintln!("Cannot reveal loaded quick window: {error}");
        }
    }
}
fn open_quick(app: &tauri::AppHandle) -> Result<()> {
    let window = quick_window(app)?;
    let state = app.state::<AppState>();
    let already_open = window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false);
    if !already_open {
        let (target, pid) = platform::foreground();
        if let Ok(mut ui) = state.quick_ui.lock() {
            ui.target = target;
        }
        state
            .quick
            .lock()
            .map_err(|_| "Quick session lock is poisoned".to_string())?
            .open(target, pid);
    }
    let loaded = state
        .quick_ui
        .lock()
        .map(|mut ui| {
            if !ui.loaded {
                ui.pending = true;
            }
            ui.loaded
        })
        .map_err(|_| "Quick window state lock is poisoned".to_string())?;
    if !loaded {
        // The initial render already opens the panel; showing now would expose
        // the blank webview, so wait for PageLoadEvent::Finished.
        return Ok(());
    }
    app.emit_to("quick", "desktop://quick-open", ())
        .map_err(|e| format!("Quick-open event failed: {e}"))?;
    show_quick_window(&window, &state)
}
fn reveal(app: &tauri::AppHandle, quick: bool) -> Result<()> {
    let state = app.state::<AppState>();
    if quick {
        match open_quick(app) {
            Ok(()) => return Ok(()),
            Err(error) => eprintln!("Quick window unavailable, falling back to main: {error}"),
        }
        if let Ok(mut session) = state.quick.lock() {
            let (target, pid) = platform::foreground();
            session.open(target, pid);
        }
    } else if let Ok(mut session) = state.quick.lock() {
        // Opening the full window means the old quick target is no longer the foreground app.
        session.invalidate();
    }
    let window = app
        .get_webview_window("main")
        .ok_or("Main window is unavailable")?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    if quick {
        window
            .emit("desktop://quick-open", ())
            .map_err(|e| format!("Quick-open event failed: {e}"))?;
    }
    Ok(())
}
fn report_desktop(app: &tauri::AppHandle, error: String) {
    eprintln!("Desktop operation failed: {error}");
    if let Ok(mut s) = lock(&app.state::<AppState>()) {
        s.capture_error = Some(error);
    }
    status_changed(app);
}
fn trusted_url(url: &url::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
        || (cfg!(debug_assertions)
            && url.scheme() == "http"
            && url.host_str() == Some("localhost")
            && url.port() == Some(1421))
}
fn start_workers(app: &tauri::AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    let (tx, rx) = mpsc::sync_channel(1);
    let (ready_tx, ready_rx) = mpsc::channel();
    let listener = thread::Builder::new()
        .name("clipboard-messages".into())
        .spawn(move || platform::listen(tx, ready_tx))
        .map_err(|e| e.to_string())?;
    let ready = ready_rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|e| format!("Clipboard listener startup failed: {e}"))?;
    match ready {
        Ok(id) => {
            state.listener_thread.store(id, Ordering::SeqCst);
            let mut s = lock(&state)?;
            s.listener_ready = true;
            s.baseline = platform::sequence();
        }
        Err(error) => {
            logging::event("ERROR", &format!("Clipboard listener failed: {error}"));
            let mut s = lock(&state)?;
            s.capture_error = Some(error);
        }
    }
    let inner = state.inner.clone();
    let stop = state.stop.clone();
    let handle = app.clone();
    let capture = thread::Builder::new()
        .name("clipboard-storage".into())
        .spawn(move || {
            let mut maintained = Instant::now();
            while !stop.load(Ordering::SeqCst) {
                match rx.recv_timeout(Duration::from_secs(1)) {
                    Ok(_) => {
                        thread::sleep(Duration::from_millis(60));
                        while rx.try_recv().is_ok() {}
                        for attempt in 0..6 {
                            if stop.load(Ordering::SeqCst) {
                                break;
                            }
                            let mut s = match inner.lock() {
                                Ok(s) => s,
                                Err(_) => {
                                    eprintln!("Capture coordinator lock poisoned");
                                    return;
                                }
                            };
                            let seq = platform::sequence();
                            if s.store.settings.paused || !s.listener_ready {
                                s.baseline = seq;
                                break;
                            }
                            if seq == s.baseline {
                                break;
                            }
                            // Privacy rule: decide before reading any clipboard content.
                            let source = platform::source_app();
                            if let Some(source) = source.as_deref() {
                                if excluded_source(&s.store.settings, source) {
                                    s.baseline = seq;
                                    break;
                                }
                            }
                            let read = platform::read();
                            if platform::sequence() != seq {
                                drop(s);
                                continue;
                            }
                            match read {
                                Ok(capture) => {
                                    s.baseline = seq;
                                    let suppressed = capture.as_ref().is_some_and(|c| {
                                        s.own.as_ref().is_some_and(|w| {
                                            w.matches(
                                                seq,
                                                &c.hash,
                                                platform::owns_clipboard(),
                                                Instant::now(),
                                            )
                                        })
                                    });
                                    s.own = None;
                                    if !suppressed {
                                        if let Some(c) = capture {
                                            let c = match &source {
                                                Some(source) => c.with_source(source.clone()),
                                                None => c,
                                            };
                                            if let Err(error) = s.store.capture(&c, store::now()) {
                                                logging::event(
                                                    "ERROR",
                                                    &format!("Capture storage failed: {error}"),
                                                );
                                                s.capture_error = Some(error);
                                                drop(s);
                                                status_changed(&handle);
                                                break;
                                            }
                                            changed(&handle);
                                        }
                                    }
                                    if s.capture_error.take().is_some() {
                                        drop(s);
                                        status_changed(&handle);
                                    }
                                    break;
                                }
                                Err(error) => {
                                    if attempt == 5 {
                                        s.baseline = seq;
                                        s.capture_error = Some(error);
                                        drop(s);
                                        status_changed(&handle);
                                    } else {
                                        drop(s);
                                        thread::sleep(Duration::from_millis(50));
                                    }
                                }
                            }
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        if !stop.load(Ordering::SeqCst) {
                            if let Ok(mut s) = inner.lock() {
                                if s.listener_ready {
                                    s.listener_ready = false;
                                    s.capture_error =
                                        Some("Clipboard listener exited unexpectedly".into());
                                    status_changed(&handle);
                                }
                            }
                        }
                        break;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                if maintained.elapsed() >= Duration::from_secs(3600) {
                    if let Ok(mut s) = inner.lock() {
                        match s.store.maintain(store::now()) {
                            Ok(true) => changed(&handle),
                            Ok(false) => {}
                            Err(e) => {
                                s.capture_error = Some(e);
                                status_changed(&handle);
                            }
                        }
                    }
                    maintained = Instant::now();
                }
            }
        })
        .map_err(|e| e.to_string())?;
    state
        .workers
        .lock()
        .map_err(|_| "Worker lock poisoned")?
        .extend([listener, capture]);
    Ok(())
}
fn setup(app: &mut tauri::App) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let default_dir = app.path().app_local_data_dir()?;
    let env_dir = if cfg!(debug_assertions) {
        std::env::var_os("MYPASTE_DATA_DIR").map(std::path::PathBuf::from)
    } else {
        None
    };
    let portable_dir = storage::current_portable_dir();
    let (dir, storage_error, portable) = if let Some(dir) = env_dir {
        if !dir.is_absolute() {
            return Err("MYPASTE_DATA_DIR must be an absolute path".into());
        }
        (dir, None, false)
    } else if let Some(dir) = portable_dir {
        // A marker beside the executable wins over storage.json; the data directory
        // travels with the program, so it can live on a USB stick.
        (dir, None, true)
    } else {
        let config_dir = app.path().app_config_dir()?;
        std::fs::create_dir_all(&config_dir)?;
        let (dir, error) = storage::resolve(&config_dir, &default_dir)?;
        (dir, error, false)
    };
    std::fs::create_dir_all(&dir)?;
    if let Err(error) = logging::init(&dir) {
        eprintln!("Diagnostic log unavailable: {error}");
    }
    let store = match Store::open(&dir.join("history.sqlite3")) {
        Ok(store) => store,
        Err(error) => {
            logging::event("ERROR", &format!("Database open failed: {error}"));
            return Err(error.into());
        }
    };
    let elevated = platform::elevated();
    logging::event(
        "INFO",
        &format!(
            "MyPaste {} starting; data={}; portable={portable}; elevated={elevated}",
            env!("CARGO_PKG_VERSION"),
            dir.display()
        ),
    );
    let shortcut = store.settings.shortcut.clone();
    app.manage(AppState {
        inner: Arc::new(Mutex::new(Inner {
            store,
            capture_error: None,
            listener_ready: false,
            shortcut_registered: false,
            shortcut_error: None,
            autostart: platform::autostart_enabled(),
            elevated,
            portable,
            baseline: platform::sequence(),
            own: None,
            sequence: None,
        })),
        data_dir: dir.to_string_lossy().into_owned(),
        portable,
        storage_error,
        quick: Arc::new(Mutex::new(QuickSession::default())),
        quick_ui: Mutex::new(QuickUi::default()),
        stop: Arc::new(AtomicBool::new(false)),
        listener_thread: AtomicU32::new(0),
        workers: Mutex::new(vec![]),
    });
    let config = app
        .config()
        .app
        .windows
        .first()
        .ok_or("Main window configuration is missing")?
        .clone();
    tauri::WebviewWindowBuilder::from_config(app, &config)?
        .on_navigation(trusted_url)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()?;
    match app.global_shortcut().register(shortcut.as_str()) {
        Ok(()) => lock(&app.state::<AppState>())?.shortcut_registered = true,
        Err(error) => {
            logging::event(
                "WARN",
                &format!("Global shortcut registration failed: {error}"),
            );
            lock(&app.state::<AppState>())?.shortcut_error =
                Some(format!("Global shortcut registration failed: {error}"))
        }
    }
    use tauri::{
        menu::{Menu, MenuItem},
        tray::TrayIconBuilder,
    };
    let open = MenuItem::with_id(app, "open", "打开 MyPaste", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "暂停 / 恢复采集", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置（打开主窗口）", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &pause, &settings, &quit])?;
    let mut rgba = vec![0u8; 32 * 32 * 4];
    for p in rgba.chunks_exact_mut(4) {
        p.copy_from_slice(&[47, 99, 221, 255]);
    }
    for y in 6..26 {
        for x in 8..24 {
            let i = (y * 32 + x) * 4;
            rgba[i..i + 4].copy_from_slice(&[255, 255, 255, 255]);
        }
    }
    TrayIconBuilder::with_id("mypaste-tray")
        .icon(tauri::image::Image::new_owned(rgba, 32, 32))
        .tooltip("MyPaste · 关闭窗口后继续记录")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let result = match event.id.as_ref() {
                "open" | "settings" => reveal(app, false),
                "pause" => {
                    let paused = lock(&app.state::<AppState>()).map(|s| s.store.settings.paused);
                    paused.and_then(|paused| {
                        set_settings(
                            app,
                            &app.state::<AppState>(),
                            SettingsPatch {
                                paused: Some(!paused),
                                ..Default::default()
                            },
                        )
                    })
                }
                "quit" => {
                    app.exit(0);
                    Ok(())
                }
                _ => Ok(()),
            };
            if let Err(error) = result {
                report_desktop(app, error);
            }
        })
        .build(app)?;
    start_workers(app.handle())?;
    Ok(())
}

pub fn run() {
    // Portable mode keeps WebView2's profile beside the executable as well, so the
    // whole folder can move without writing to %LOCALAPPDATA%.
    if let Some(dir) = storage::current_portable_dir() {
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", dir.join("webview2"));
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Err(error) = reveal(app, false) {
                report_desktop(app, error);
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _, event| {
                    if event.state() == ShortcutState::Pressed {
                        if try_sequence_shortcut(app) {
                            return;
                        }
                        if let Err(error) = reveal(app, true) {
                            report_desktop(app, error);
                        }
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(setup)
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.hide() {
                    report_desktop(
                        window.app_handle(),
                        format!("Cannot hide main window: {error}"),
                    );
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            get_item,
            search_items,
            update_item,
            purge_item,
            create_collection,
            update_settings,
            copy_item,
            get_image,
            get_thumbnail,
            paste_item,
            open_link,
            hide_quick_window,
            export_backup,
            import_backup,
            open_data_dir,
            set_data_dir,
            rename_collection,
            delete_collection,
            move_collection,
            update_items,
            add_to_collection,
            copy_item_variant,
            copy_item_format,
            data_usage,
            compact_database,
            set_autostart,
            set_collection_policy,
            start_sequence,
            sequence_status,
            sequence_next,
            stop_sequence,
            get_log_info,
            open_log_dir,
            export_diagnostics,
            restart_elevated
        ])
        .build(tauri::generate_context!())
        .expect("MyPaste native initialization failed");
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = app.try_state::<AppState>() {
                state.stop.store(true, Ordering::SeqCst);
                if let Err(e) = platform::stop(state.listener_thread.load(Ordering::SeqCst)) {
                    eprintln!("{e}");
                }
                if let Err(e) = app.global_shortcut().unregister_all() {
                    eprintln!("Shortcut cleanup failed: {e}");
                }
                if let Ok(mut workers) = state.workers.lock() {
                    for worker in workers.drain(..) {
                        if worker.join().is_err() {
                            eprintln!("Native worker panicked during shutdown");
                        }
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn own_writes_require_sequence_owner_hash_and_deadline() {
        let at = Instant::now();
        let own = OwnWrite {
            sequence: 10,
            hash: "synthetic".into(),
            until: at + Duration::from_secs(1),
        };
        assert!(own.matches(10, "synthetic", true, at));
        assert!(!own.matches(11, "synthetic", true, at));
        assert!(!own.matches(10, "external", true, at));
        assert!(!own.matches(10, "synthetic", false, at));
        assert!(!own.matches(10, "synthetic", true, at + Duration::from_secs(2)));
    }
    #[test]
    fn quick_session_binds_generation_and_sequence() {
        let mut session = QuickSession::default();
        let idle = QuickSession::default();
        assert!(!session.claim(idle), "a hidden quick window cannot paste");

        session.open(100, 7);
        let request = session;
        assert!(session.claim(request));
        assert!(!session.claim(request), "one paste per session at a time");
        assert!(session.permits(request, 42, 42));
        assert!(
            !session.permits(request, 42, 43),
            "clipboard changed mid-paste"
        );
        session.release(request);
        assert!(
            !session.permits(request, 42, 42),
            "released sessions stop typing"
        );
        assert!(session.claim(request), "released session may paste again");

        let stale = request;
        session.open(200, 9);
        assert!(
            !session.claim(stale),
            "an older window cannot reuse the session"
        );
        assert!(!session.permits(stale, 42, 42));

        session.invalidate();
        assert_eq!(session.target, 0);
        assert!(!session.claim(session));
    }
    #[test]
    fn origins_reject_remote_and_unexpected_dev_ports() {
        assert!(trusted_url(
            &url::Url::parse("tauri://localhost/index.html").unwrap()
        ));
        assert!(!trusted_url(
            &url::Url::parse("https://example.com").unwrap()
        ));
        assert!(!trusted_url(
            &url::Url::parse("http://localhost:1422").unwrap()
        ));
        assert!(!trusted_url(
            &url::Url::parse("http://localhost.evil:1421").unwrap()
        ));
    }
    #[test]
    fn copy_variants_trim_and_flatten_without_inventing_content() {
        assert_eq!(transform_text("  a\r\nb  ", "plain").unwrap(), "  a\r\nb  ");
        assert_eq!(transform_text("  a\n b \n", "trim").unwrap(), "a\n b");
        assert_eq!(
            transform_text("a\r\nb\rc\nd", "one_line").unwrap(),
            "a b c d"
        );
        assert_eq!(
            transform_text("  \n\t ", "one_line").unwrap_err(),
            "转换后的内容为空"
        );
        assert!(transform_text("a", "unknown").is_err());
    }
    #[test]
    fn rich_format_selection_rejects_missing_and_unknown_formats() {
        let html = b"<html><body>synthetic</body></html>".to_vec();
        let rtf = b"{\\rtf1\\ansi synthetic}".to_vec();
        assert_eq!(
            select_rich("html", Some(html.clone()), Some(rtf.clone())).unwrap(),
            (Some(html.clone()), None)
        );
        assert_eq!(
            select_rich("rtf", Some(html), Some(rtf.clone())).unwrap(),
            (None, Some(rtf))
        );
        assert_eq!(
            select_rich("html", None, None).unwrap_err(),
            "这条记录没有保存 HTML 格式"
        );
        assert_eq!(
            select_rich("rtf", None, None).unwrap_err(),
            "这条记录没有保存 RTF 格式"
        );
        assert_eq!(
            select_rich("bogus", None, None).unwrap_err(),
            "未知的复制格式"
        );
    }
    #[test]
    fn sequence_status_reports_progress_and_completion() {
        let mut sequence = Sequence {
            entries: vec![
                (1, "第一条".into()),
                (2, "第二条".into()),
                (3, "第三条".into()),
            ],
            next: 1,
            started_at: Instant::now(),
        };
        let status = sequence.status();
        assert!(status.active);
        assert_eq!((status.total, status.position, status.remaining), (3, 1, 2));
        assert_eq!(status.current_title.as_deref(), Some("第一条"));
        sequence.next = 3;
        let status = sequence.status();
        assert!(!status.active);
        assert_eq!((status.position, status.remaining), (3, 0));
        assert_eq!(status.current_title.as_deref(), Some("第三条"));
    }
    #[test]
    fn sequence_entries_reject_invalid_selection_and_dedupe() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("history.sqlite3")).unwrap();
        let a = store
            .capture(
                &store::Capture::text("序列甲".into()).unwrap(),
                store::now(),
            )
            .unwrap();
        let b = store
            .capture(
                &store::Capture::text("序列乙".into()).unwrap(),
                store::now() + 1,
            )
            .unwrap();
        let entries = sequence_entries(&store, &[a, b, a]).unwrap();
        assert_eq!(
            entries,
            vec![(a, "序列甲".to_string()), (b, "序列乙".to_string())]
        );
        assert!(sequence_entries(&store, &[]).is_err());
        assert!(sequence_entries(&store, &vec![a; 201]).is_err());
        store
            .update(
                b,
                ItemPatch {
                    deleted: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(sequence_entries(&store, &[a, b]).is_err());
    }
    #[test]
    fn dto_and_patch_contract() {
        let s = Settings::default();
        let json = serde_json::to_value(s).unwrap();
        assert_eq!(json["retentionDays"], 30);
        assert_eq!(json["maxItems"], 500);
        assert!(serde_json::from_str::<ItemPatch>(r#"{"content":"not mutable"}"#).is_err());
        assert!(
            serde_json::from_str::<SettingsPatch>(r#"{"paused":true,"unexpected":1}"#).is_err()
        );
        let p = PasteOutcome {
            copied: true,
            status: "manual_required",
            reason: None,
        };
        assert_eq!(
            serde_json::to_value(p).unwrap()["status"],
            "manual_required"
        );
        assert_eq!(json["excludedApps"], serde_json::json!([]));
    }
    #[test]
    fn source_exclusion_normalizes_application_names() {
        let mut s = Settings::default();
        s.excluded_apps = vec!["KeePassXC.EXE".into(), " vault ".into()];
        assert!(excluded_source(&s, "keepassxc"));
        assert!(excluded_source(&s, "VAULT.exe"));
        assert!(!excluded_source(&s, "notepad"));
        assert!(!excluded_source(&s, ""));
        assert_eq!(app_key(" Notepad.EXE "), "notepad");
    }
    #[test]
    fn excluded_apps_patch_is_trimmed_deduped_and_bounded() {
        let patch = SettingsPatch {
            excluded_apps: Some(vec![" a ".into(), "A.EXE".into(), "b.exe".into()]),
            ..Default::default()
        };
        let out = patch.apply(&Settings::default()).unwrap();
        assert_eq!(out.excluded_apps, vec!["a", "b.exe"]);
        let bad = SettingsPatch {
            excluded_apps: Some(vec!["bad\nname".into()]),
            ..Default::default()
        };
        assert!(bad.apply(&Settings::default()).is_err());
        let too_many = SettingsPatch {
            excluded_apps: Some((0..101).map(|i| format!("app{i}")).collect()),
            ..Default::default()
        };
        assert!(too_many.apply(&Settings::default()).is_err());
        let keep = SettingsPatch::default();
        let mut existing = Settings::default();
        existing.excluded_apps = vec!["vault".into()];
        assert_eq!(keep.apply(&existing).unwrap().excluded_apps, vec!["vault"]);
    }
}
