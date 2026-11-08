mod platform;
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
use store::{Clip, ItemPatch, Result, Settings, SettingsPatch, Store};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    capture_state: String,
    capture_error: Option<String>,
    shortcut_registered: bool,
    shortcut_error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    items: Vec<Clip>,
    collections: Vec<String>,
    settings: Settings,
    status: Status,
    data_dir: String,
}
#[derive(Serialize)]
struct PasteOutcome {
    copied: bool,
    status: &'static str,
    reason: Option<String>,
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
    baseline: u32,
    own: Option<OwnWrite>,
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
struct AppState {
    inner: Arc<Mutex<Inner>>,
    data_dir: String,
    quick: Arc<Mutex<QuickSession>>,
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
    if window.label() != "main" {
        Err("This command is restricted to main".into())
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
        settings: s.store.settings.clone(),
        status: s.status(),
        data_dir: state.data_dir.clone(),
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
fn copy_native(state: &AppState, id: i64) -> Result<u32> {
    let mut s = lock(state)?;
    let item = s.store.get(id)?;
    if item.deleted {
        return Err("Restore this item before copying".into());
    }
    let png = if item.kind == "image" {
        Some(s.store.image(id)?.1)
    } else {
        None
    };
    let hash = s.store.hash(id)?;
    // Clipboard writes and capture reads are serialized, including notifications racing with write return.
    s.own = None;
    let sequence = if item.kind == "file" {
        let paths: Vec<String> = item.content.split('\n').map(str::to_string).collect();
        platform::copy_files(&paths)?
    } else {
        platform::copy(&item.content, png.as_deref())?
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
#[tauri::command]
fn copy_item(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<()> {
    allowed(&window)?;
    copy_native(&state, id)?;
    changed(window.app_handle());
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
    Ok(match outcome {
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
    })
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
        .map_err(|e| format!("Cannot hide main window: {e}"))
}

fn reveal(app: &tauri::AppHandle, quick: bool) -> Result<()> {
    let state = app.state::<AppState>();
    if quick {
        let (target, pid) = platform::foreground();
        let mut session = state
            .quick
            .lock()
            .map_err(|_| "Quick session lock is poisoned".to_string())?;
        session.open(target, pid);
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
    let mut dir = app.path().app_local_data_dir()?;
    if cfg!(debug_assertions) {
        if let Some(value) = std::env::var_os("MYPASTE_DATA_DIR") {
            let path = std::path::PathBuf::from(value);
            if !path.is_absolute() {
                return Err("MYPASTE_DATA_DIR must be an absolute path".into());
            }
            dir = path;
        }
    }
    std::fs::create_dir_all(&dir)?;
    let store = Store::open(&dir.join("history.sqlite3"))?;
    let shortcut = store.settings.shortcut.clone();
    app.manage(AppState {
        inner: Arc::new(Mutex::new(Inner {
            store,
            capture_error: None,
            listener_ready: false,
            shortcut_registered: false,
            shortcut_error: None,
            baseline: platform::sequence(),
            own: None,
        })),
        data_dir: dir.to_string_lossy().into_owned(),
        quick: Arc::new(Mutex::new(QuickSession::default())),
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
                        if let Err(error) = reveal(app, true) {
                            report_desktop(app, error);
                        }
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            hide_quick_window
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
