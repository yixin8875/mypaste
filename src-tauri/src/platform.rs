use crate::store::{Capture, Result};
use std::sync::mpsc::SyncSender;

#[cfg(windows)]
mod win {
    use super::*;
    use crate::store::{FileEntry, MAX_FILES, MAX_FILE_LIST, MAX_IMAGE, MAX_PIXELS};
    use std::{
        io::Cursor,
        ptr::null_mut,
        sync::{
            atomic::{AtomicIsize, Ordering},
            Mutex,
        },
    };
    use windows_sys::Win32::{
        Foundation::*,
        System::{DataExchange::*, LibraryLoader::GetModuleHandleW, Memory::*, Threading::*},
        UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    };
    static NOTIFY: Mutex<Option<SyncSender<u32>>> = Mutex::new(None);
    static OWNER: AtomicIsize = AtomicIsize::new(0);
    struct NotifyGuard;
    impl Drop for NotifyGuard {
        fn drop(&mut self) {
            if let Ok(mut notify) = NOTIFY.lock() {
                notify.take();
            }
        }
    }
    pub fn owns_clipboard() -> bool {
        unsafe {
            let owner = GetClipboardOwner();
            if owner.is_null() {
                return false;
            }
            let mut pid = 0;
            GetWindowThreadProcessId(owner, &mut pid);
            pid == GetCurrentProcessId()
        }
    }
    pub fn sequence() -> u32 {
        unsafe { GetClipboardSequenceNumber() }
    }
    unsafe extern "system" fn procedure(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        if msg == WM_CLIPBOARDUPDATE {
            if let Ok(notify) = NOTIFY.lock() {
                if let Some(tx) = notify.as_ref() {
                    let _ = tx.try_send(sequence());
                }
            }
            return 0;
        }
        unsafe { DefWindowProcW(hwnd, msg, w, l) }
    }
    pub fn listen(tx: SyncSender<u32>, ready: std::sync::mpsc::Sender<Result<u32>>) {
        // SAFETY: class/window live only on this thread; the callback never retains borrowed pointers.
        unsafe {
            match NOTIFY.lock() {
                Ok(mut notify) => {
                    if notify.is_some() {
                        let _ = ready.send(Err("Clipboard listener already exists".into()));
                        return;
                    }
                    *notify = Some(tx);
                }
                Err(_) => {
                    let _ = ready.send(Err("Clipboard notifier lock poisoned".into()));
                    return;
                }
            }
            let _notify_guard = NotifyGuard;
            let name: Vec<u16> = "MyPaste.Clipboard.Listener\0".encode_utf16().collect();
            let instance = GetModuleHandleW(std::ptr::null());
            let class = WNDCLASSW {
                lpfnWndProc: Some(procedure),
                hInstance: instance,
                lpszClassName: name.as_ptr(),
                ..std::mem::zeroed()
            };
            if RegisterClassW(&class) == 0 {
                let _ = ready.send(Err(format!("RegisterClassW failed: {}", GetLastError())));
                return;
            }
            let hwnd = CreateWindowExW(
                0,
                name.as_ptr(),
                name.as_ptr(),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                null_mut(),
                instance,
                std::ptr::null(),
            );
            if hwnd.is_null() {
                let _ = ready.send(Err(format!("CreateWindowExW failed: {}", GetLastError())));
                UnregisterClassW(name.as_ptr(), instance);
                return;
            }
            if AddClipboardFormatListener(hwnd) == 0 {
                let _ = ready.send(Err(format!(
                    "AddClipboardFormatListener failed: {}",
                    GetLastError()
                )));
                DestroyWindow(hwnd);
                UnregisterClassW(name.as_ptr(), instance);
                return;
            }
            OWNER.store(hwnd as isize, Ordering::SeqCst);
            let _ = ready.send(Ok(GetCurrentThreadId()));
            let mut message: MSG = std::mem::zeroed();
            loop {
                let status = GetMessageW(&mut message, null_mut(), 0, 0);
                if status <= 0 {
                    if status < 0 {
                        eprintln!("Clipboard message loop failed: {}", GetLastError());
                    }
                    break;
                }
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            OWNER.store(0, Ordering::SeqCst);
            RemoveClipboardFormatListener(hwnd);
            DestroyWindow(hwnd);
            UnregisterClassW(name.as_ptr(), instance);
        }
    }
    pub fn stop(thread: u32) -> Result<()> {
        if thread != 0 && unsafe { PostThreadMessageW(thread, WM_QUIT, 0, 0) } == 0 {
            return Err(format!("Stopping clipboard listener failed: {}", unsafe {
                GetLastError()
            }));
        }
        Ok(())
    }
    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }
    fn read_global(format: u32, limit: usize) -> Result<Vec<u8>> {
        // SAFETY: clipboard stays open throughout. Size is validated before copying; GlobalLock is paired with unlock.
        unsafe {
            let handle = GetClipboardData(format);
            if handle.is_null() {
                return Err(format!("GetClipboardData failed: {}", GetLastError()));
            }
            let size = GlobalSize(handle);
            if size == 0 || size > limit {
                return Err("Clipboard data exceeds the allowed input size".into());
            }
            let pointer = GlobalLock(handle);
            if pointer.is_null() {
                return Err(format!("GlobalLock failed: {}", GetLastError()));
            }
            let data = std::slice::from_raw_parts(pointer as *const u8, size).to_vec();
            GlobalUnlock(handle);
            Ok(data)
        }
    }
    fn format(name: &str) -> u32 {
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        unsafe { RegisterClipboardFormatW(wide.as_ptr()) }
    }
    fn open_clipboard(hwnd: HWND) -> Result<ClipboardGuard> {
        for attempt in 0..6 {
            if unsafe { OpenClipboard(hwnd) } != 0 {
                return Ok(ClipboardGuard);
            }
            if attempt < 5 {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
        Err("Clipboard is busy; copy failed".into())
    }
    /// Read only metadata; file contents are never opened.
    fn file_entry(path: String) -> FileEntry {
        match std::fs::metadata(&path) {
            Ok(meta) => FileEntry {
                size: meta
                    .is_file()
                    .then(|| meta.len().min(i64::MAX as u64) as i64),
                modified_at: meta
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|elapsed| elapsed.as_millis().min(i64::MAX as u128) as i64),
                is_dir: meta.is_dir(),
                path,
            },
            Err(_) => FileEntry {
                path,
                size: None,
                modified_at: None,
                is_dir: false,
            },
        }
    }
    /// CF_HDROP holds a DROPFILES header followed by NUL-separated paths.
    pub(super) fn decode_dropfiles(data: &[u8]) -> Result<Vec<String>> {
        if data.len() < 20 {
            return Err("Truncated CF_HDROP header".into());
        }
        let offset = u32::from_le_bytes(data[0..4].try_into().unwrap()) as usize;
        let wide = u32::from_le_bytes(data[16..20].try_into().unwrap()) != 0;
        if offset < 20 || offset > data.len() {
            return Err("Invalid CF_HDROP path offset".into());
        }
        let body = &data[offset..];
        let mut paths = Vec::new();
        if wide {
            if body.len() % 2 != 0 {
                return Err("Invalid CF_HDROP UTF-16 data".into());
            }
            let units: Vec<u16> = body
                .chunks_exact(2)
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .collect();
            let mut start = 0;
            for (i, unit) in units.iter().enumerate() {
                if *unit != 0 {
                    continue;
                }
                if i == start {
                    break;
                }
                if paths.len() >= MAX_FILES {
                    return Err("Clipboard file list exceeds 500 entries".into());
                }
                paths.push(
                    String::from_utf16(&units[start..i])
                        .map_err(|_| "Invalid UTF-16 path in CF_HDROP")?,
                );
                start = i + 1;
            }
        } else {
            let mut start = 0;
            for (i, byte) in body.iter().enumerate() {
                if *byte != 0 {
                    continue;
                }
                if i == start {
                    break;
                }
                if paths.len() >= MAX_FILES {
                    return Err("Clipboard file list exceeds 500 entries".into());
                }
                paths.push(String::from_utf8_lossy(&body[start..i]).into_owned());
                start = i + 1;
            }
        }
        Ok(paths)
    }
    pub fn read() -> Result<Option<Capture>> {
        if unsafe { OpenClipboard(null_mut()) } == 0 {
            return Err("Clipboard is busy; bounded read retry required".into());
        }
        let _guard = ClipboardGuard;
        let exclude = format("ExcludeClipboardContentFromMonitorProcessing");
        if exclude != 0 && unsafe { IsClipboardFormatAvailable(exclude) } != 0 {
            return Ok(None);
        }
        if unsafe { IsClipboardFormatAvailable(15) } != 0 {
            let data = read_global(15, MAX_FILE_LIST + 64 * 1024)?;
            let paths = decode_dropfiles(&data)?;
            if !paths.is_empty() {
                return Capture::files(paths.into_iter().map(file_entry).collect()).map(Some);
            }
        }
        let png_format = format("PNG");
        if png_format != 0 && unsafe { IsClipboardFormatAvailable(png_format) } != 0 {
            let bytes = read_global(png_format, MAX_IMAGE)?;
            let reader =
                image::ImageReader::with_format(Cursor::new(&bytes), image::ImageFormat::Png);
            let (w, h) = reader
                .into_dimensions()
                .map_err(|e| format!("Invalid clipboard PNG header: {e}"))?;
            if w as u64 * h as u64 > MAX_PIXELS as u64 || w == 0 || h == 0 {
                return Err("Clipboard image exceeds 20 million pixels".into());
            }
            let mut reader =
                image::ImageReader::with_format(Cursor::new(bytes), image::ImageFormat::Png);
            let mut limits = image::Limits::default();
            limits.max_alloc = Some(80_000_000);
            limits.max_image_width = Some(w);
            limits.max_image_height = Some(h);
            reader.limits(limits);
            let decoded = reader
                .decode()
                .map_err(|e| format!("Clipboard PNG decode failed: {e}"))?
                .to_rgba8();
            return Capture::rgba(w as usize, h as usize, decoded.as_raw()).map(Some);
        }
        for dib in [17, 8] {
            if unsafe { IsClipboardFormatAvailable(dib) } != 0 {
                return decode_dib(&read_global(dib, 85_000_000)?).map(Some);
            }
        }
        if unsafe { IsClipboardFormatAvailable(13) } != 0 {
            let data = read_global(13, 2 * 1024 * 1024 + 2)?;
            let utf16: Vec<u16> = data
                .chunks_exact(2)
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .take_while(|u| *u != 0)
                .collect();
            let text = String::from_utf16(&utf16).map_err(|_| "Invalid Unicode clipboard text")?;
            if text.is_empty() {
                return Ok(None);
            }
            return Capture::text(text).map(Some);
        }
        Ok(None)
    }
    fn u32_at(data: &[u8], at: usize) -> Result<u32> {
        let bytes = data.get(at..at + 4).ok_or("Truncated DIB header")?;
        Ok(u32::from_le_bytes(bytes.try_into().unwrap()))
    }
    fn component(pixel: u32, mask: u32, default: u8) -> u8 {
        if mask == 0 {
            return default;
        }
        let shifted = (pixel & mask) >> mask.trailing_zeros();
        let max = mask >> mask.trailing_zeros();
        ((shifted as u64 * 255) / max as u64) as u8
    }
    pub(super) fn decode_dib(data: &[u8]) -> Result<Capture> {
        let header = u32_at(data, 0)? as usize;
        if header < 40 || header > data.len() {
            return Err("Unsupported DIB header".into());
        }
        let width = u32_at(data, 4)? as i32;
        let signed_height = u32_at(data, 8)? as i32;
        let height = signed_height.checked_abs().ok_or("Invalid DIB height")? as usize;
        if width <= 0
            || height == 0
            || (width as usize)
                .checked_mul(height)
                .filter(|n| *n <= MAX_PIXELS)
                .is_none()
        {
            return Err("DIB exceeds 20 million pixels".into());
        }
        let planes =
            u16::from_le_bytes(data.get(12..14).ok_or("Truncated DIB")?.try_into().unwrap());
        let bits = u16::from_le_bytes(data.get(14..16).ok_or("Truncated DIB")?.try_into().unwrap())
            as usize;
        let compression = u32_at(data, 16)?;
        if planes != 1
            || ![24, 32].contains(&bits)
            || !(compression == 0 || compression == 3 && bits == 32)
        {
            return Err(
                "Only uncompressed 24/32-bit and 32-bit bitfield DIB images are supported".into(),
            );
        }
        let mut offset = header;
        let mut masks = [0x00ff0000u32, 0x0000ff00, 0x000000ff, 0];
        if compression == 3 {
            let start = if header >= 52 { 40 } else { header };
            for (i, m) in masks[..3].iter_mut().enumerate() {
                *m = u32_at(data, start + i * 4)?;
            }
            if header >= 56 {
                masks[3] = u32_at(data, 52)?;
            }
            if header == 40 {
                offset += 12;
            }
            if masks[..3].contains(&0)
                || masks[0] & masks[1] != 0
                || masks[1] & masks[2] != 0
                || masks[0] & masks[2] != 0
            {
                return Err("Invalid DIB channel masks".into());
            }
        }
        let palette = u32_at(data, 32)? as usize;
        offset = offset
            .checked_add(palette.checked_mul(4).ok_or("DIB palette overflow")?)
            .ok_or("DIB offset overflow")?;
        let width = width as usize;
        let stride = (width * bits).div_ceil(32) * 4;
        let end = offset
            .checked_add(stride.checked_mul(height).ok_or("DIB size overflow")?)
            .ok_or("DIB size overflow")?;
        if end > data.len() {
            return Err("Truncated DIB pixels".into());
        }
        let mut rgba = vec![0; width * height * 4];
        for y in 0..height {
            let row = if signed_height > 0 { height - 1 - y } else { y };
            for x in 0..width {
                let p = offset + row * stride + x * (bits / 8);
                let out = (y * width + x) * 4;
                if bits == 24 {
                    rgba[out..out + 4].copy_from_slice(&[data[p + 2], data[p + 1], data[p], 255]);
                } else {
                    let pixel = u32_at(data, p)?;
                    rgba[out..out + 4].copy_from_slice(&[
                        component(pixel, masks[0], 0),
                        component(pixel, masks[1], 0),
                        component(pixel, masks[2], 0),
                        component(pixel, masks[3], 255),
                    ]);
                }
            }
        }
        Capture::rgba(width, height, &rgba)
    }
    fn set_global(format: u32, bytes: &[u8]) -> Result<()> {
        // SAFETY: allocate a movable block, copy bounded bytes, and transfer ownership only when SetClipboardData succeeds.
        unsafe {
            let allocation = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
            if allocation.is_null() {
                return Err(format!("Clipboard allocation failed: {}", GetLastError()));
            }
            let pointer = GlobalLock(allocation);
            if pointer.is_null() {
                GlobalFree(allocation);
                return Err("Clipboard allocation lock failed".into());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer as *mut u8, bytes.len());
            GlobalUnlock(allocation);
            if SetClipboardData(format, allocation).is_null() {
                GlobalFree(allocation);
                return Err(format!("Clipboard format write failed: {}", GetLastError()));
            }
            Ok(())
        }
    }
    pub fn copy(text: &str, png: Option<&[u8]>) -> Result<u32> {
        let hwnd = OWNER.load(Ordering::SeqCst) as HWND;
        if hwnd.is_null() {
            return Err("Clipboard owner window is unavailable".into());
        }
        // Prepare formats before taking the system clipboard lock.
        let mut formats = Vec::new();
        if let Some(png) = png {
            let image = image::load_from_memory_with_format(png, image::ImageFormat::Png)
                .map_err(|e| format!("Stored PNG decode failed: {e}"))?
                .to_rgba8();
            let (w, h) = image.dimensions();
            if w as u64 * h as u64 > MAX_PIXELS as u64 {
                return Err("Stored image exceeds the pixel limit".into());
            }
            let mut dib = vec![0u8; 124];
            for (at, value) in [
                (0, 124u32),
                (4, w),
                (8, (-(h as i32)) as u32),
                (16, 3),
                (20, w * h * 4),
                (40, 0x00ff0000),
                (44, 0x0000ff00),
                (48, 0x000000ff),
                (52, 0xff000000),
                (56, 0x73524742),
            ] {
                dib[at..at + 4].copy_from_slice(&value.to_le_bytes());
            }
            dib[12..14].copy_from_slice(&1u16.to_le_bytes());
            dib[14..16].copy_from_slice(&32u16.to_le_bytes());
            dib.reserve(image.as_raw().len());
            for pixel in image.as_raw().chunks_exact(4) {
                dib.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
            }
            let png_format = format("PNG");
            if png_format == 0 {
                return Err("Cannot register PNG clipboard format".into());
            }
            formats.push((png_format, png.to_vec()));
            formats.push((17, dib));
        } else {
            let bytes: Vec<u8> = text
                .encode_utf16()
                .chain(Some(0))
                .flat_map(u16::to_le_bytes)
                .collect();
            formats.push((13, bytes));
        }
        let _guard = open_clipboard(hwnd)?;
        if unsafe { EmptyClipboard() } == 0 {
            return Err(format!("EmptyClipboard failed: {}", unsafe {
                GetLastError()
            }));
        }
        for (format, bytes) in formats {
            set_global(format, &bytes)?;
        }
        Ok(sequence())
    }
    pub fn copy_files(paths: &[String]) -> Result<u32> {
        let hwnd = OWNER.load(Ordering::SeqCst) as HWND;
        if hwnd.is_null() {
            return Err("Clipboard owner window is unavailable".into());
        }
        if paths.is_empty() {
            return Err("No files to copy".into());
        }
        let mut body = Vec::new();
        for path in paths {
            if path.is_empty() || path.contains(['\0', '\r', '\n']) {
                return Err("Invalid file path in this record".into());
            }
            for unit in path.encode_utf16().chain(Some(0)) {
                body.extend_from_slice(&unit.to_le_bytes());
            }
        }
        body.extend_from_slice(&[0, 0]);
        let mut drop = vec![0u8; 20];
        drop[0..4].copy_from_slice(&20u32.to_le_bytes());
        drop[16..20].copy_from_slice(&1u32.to_le_bytes());
        drop.extend_from_slice(&body);
        let text: Vec<u8> = paths
            .join("\r\n")
            .encode_utf16()
            .chain(Some(0))
            .flat_map(u16::to_le_bytes)
            .collect();
        let _guard = open_clipboard(hwnd)?;
        if unsafe { EmptyClipboard() } == 0 {
            return Err(format!("EmptyClipboard failed: {}", unsafe {
                GetLastError()
            }));
        }
        set_global(15, &drop)?;
        set_global(13, &text)?;
        Ok(sequence())
    }
    pub fn source_app() -> Option<String> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return None;
            }
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == 0 || pid == GetCurrentProcessId() {
                return None;
            }
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return None;
            }
            let mut buffer = vec![0u16; 1024];
            let mut size = buffer.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size);
            CloseHandle(handle);
            if ok == 0 || size == 0 {
                return None;
            }
            let path = String::from_utf16_lossy(&buffer[..size as usize]);
            let name = path.rsplit(['\\', '/']).next().unwrap_or(&path);
            let name = name
                .strip_suffix(".exe")
                .or_else(|| name.strip_suffix(".EXE"))
                .unwrap_or(name);
            (!name.is_empty()).then(|| name.to_string())
        }
    }
    pub fn foreground() -> (isize, u32) {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return (0, 0);
            }
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == 0 || pid == GetCurrentProcessId() {
                (0, 0)
            } else {
                (hwnd as isize, pid)
            }
        }
    }
    pub fn paste(target: isize, expected_pid: u32, expected_sequence: u32) -> Result<()> {
        let hwnd = target as HWND;
        unsafe {
            if sequence() != expected_sequence {
                return Err("已复制；剪贴板已被其他程序更新，请手动 Ctrl+V".into());
            }
            if hwnd.is_null() || IsWindow(hwnd) == 0 {
                return Err("已复制；原目标窗口不可用，请手动 Ctrl+V".into());
            }
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == 0 || pid != expected_pid || pid == GetCurrentProcessId() {
                return Err("已复制；目标进程已改变或属于 MyPaste，请手动 Ctrl+V".into());
            }
            let current = GetForegroundWindow();
            if !current.is_null() && current != hwnd {
                let mut current_pid = 0;
                GetWindowThreadProcessId(current, &mut current_pid);
                if current_pid != GetCurrentProcessId() {
                    return Err("已复制；前台已切到其他应用，请手动 Ctrl+V".into());
                }
            }
            if IsIconic(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            }
            if SetForegroundWindow(hwnd) == 0 {
                return Err("已复制；Windows 未允许恢复目标焦点，请手动 Ctrl+V".into());
            }
            for _ in 0..25 {
                if GetForegroundWindow() != hwnd {
                    return Err("已复制；目标焦点已改变，请手动 Ctrl+V".into());
                }
                let held = [VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN, 0x56, 0x0D]
                    .iter()
                    .any(|key| GetAsyncKeyState(*key as i32) < 0);
                if !held {
                    if GetForegroundWindow() != hwnd {
                        return Err("已复制；目标焦点已改变，请手动 Ctrl+V".into());
                    }
                    if sequence() != expected_sequence {
                        return Err("已复制；剪贴板已被其他程序更新，请手动 Ctrl+V".into());
                    }
                    let key = |vk: u16, flags: u32| INPUT {
                        r#type: INPUT_KEYBOARD,
                        Anonymous: INPUT_0 {
                            ki: KEYBDINPUT {
                                wVk: vk,
                                wScan: 0,
                                dwFlags: flags,
                                time: 0,
                                dwExtraInfo: 0,
                            },
                        },
                    };
                    let inputs = [
                        key(VK_CONTROL, 0),
                        key(0x56, 0),
                        key(0x56, KEYEVENTF_KEYUP),
                        key(VK_CONTROL, KEYEVENTF_KEYUP),
                    ];
                    let sent = SendInput(
                        inputs.len() as u32,
                        inputs.as_ptr(),
                        std::mem::size_of::<INPUT>() as i32,
                    );
                    if sent == 4 {
                        return Ok(());
                    }
                    let release = [key(0x56, KEYEVENTF_KEYUP), key(VK_CONTROL, KEYEVENTF_KEYUP)];
                    SendInput(2, release.as_ptr(), std::mem::size_of::<INPUT>() as i32);
                    return Err(format!(
                        "已复制；系统仅接受 {sent}/4 个输入事件，请手动 Ctrl+V"
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err("已复制；修饰键未释放，请手动 Ctrl+V".into())
        }
    }
}
#[cfg(windows)]
pub use win::{
    copy, copy_files, foreground, listen, owns_clipboard, paste, read, sequence, source_app, stop,
};
#[cfg(not(windows))]
pub fn owns_clipboard() -> bool {
    false
}
#[cfg(not(windows))]
pub fn sequence() -> u32 {
    0
}
#[cfg(not(windows))]
pub fn foreground() -> (isize, u32) {
    (0, 0)
}
#[cfg(not(windows))]
pub fn source_app() -> Option<String> {
    None
}
#[cfg(not(windows))]
pub fn paste(_: isize, _: u32, _: u32) -> Result<()> {
    Err("已复制；当前平台仅支持手动 Ctrl+V".into())
}
#[cfg(not(windows))]
pub fn copy_files(_: &[String]) -> Result<u32> {
    Err("File clipboard support is implemented only on Windows".into())
}
#[cfg(not(windows))]
pub fn read() -> Result<Option<Capture>> {
    Err("Clipboard monitoring is implemented only on Windows".into())
}
#[cfg(not(windows))]
pub fn listen(_: SyncSender<u32>, ready: std::sync::mpsc::Sender<Result<u32>>) {
    let _ = ready.send(Err(
        "Clipboard monitoring is implemented only on Windows".into()
    ));
}
#[cfg(not(windows))]
pub fn stop(_: u32) -> Result<()> {
    Ok(())
}

#[cfg(not(windows))]
pub fn copy(text: &str, png: Option<&[u8]>) -> Result<u32> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("Clipboard initialization failed: {e}"))?;
    if let Some(png) = png {
        let rgba = image::load_from_memory_with_format(png, image::ImageFormat::Png)
            .map_err(|e| format!("Stored image decode failed: {e}"))?
            .to_rgba8();
        clipboard
            .set_image(arboard::ImageData {
                width: rgba.width() as usize,
                height: rgba.height() as usize,
                bytes: std::borrow::Cow::Owned(rgba.into_raw()),
            })
            .map_err(|e| format!("Clipboard image write failed: {e}"))?;
    } else {
        clipboard
            .set_text(text)
            .map_err(|e| format!("Clipboard text write failed: {e}"))?;
    }
    Ok(sequence())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn dropfiles_decode_wide_ansi_and_bad_headers() {
        let mut wide = vec![0u8; 20];
        wide[0..4].copy_from_slice(&20u32.to_le_bytes());
        wide[16..20].copy_from_slice(&1u32.to_le_bytes());
        for path in ["C:\\Synthetic\\a.txt", "C:\\Synthetic\\b"] {
            for unit in path.encode_utf16().chain(Some(0)) {
                wide.extend_from_slice(&unit.to_le_bytes());
            }
        }
        wide.extend_from_slice(&[0, 0]);
        assert_eq!(
            win::decode_dropfiles(&wide).unwrap(),
            vec![
                "C:\\Synthetic\\a.txt".to_string(),
                "C:\\Synthetic\\b".into()
            ]
        );
        let mut ansi = vec![0u8; 20];
        ansi[0..4].copy_from_slice(&20u32.to_le_bytes());
        ansi.extend_from_slice(b"C:\\Synthetic\\c.txt\0\0");
        assert_eq!(
            win::decode_dropfiles(&ansi).unwrap(),
            vec!["C:\\Synthetic\\c.txt".to_string()]
        );
        let mut bad = vec![0u8; 20];
        bad[0..4].copy_from_slice(&99u32.to_le_bytes());
        assert!(win::decode_dropfiles(&bad).is_err());
        assert!(win::decode_dropfiles(&[0; 4]).is_err());
    }
    #[test]
    fn synthetic_dib_size_and_channels() {
        let mut dib = vec![0u8; 44];
        dib[0..4].copy_from_slice(&40u32.to_le_bytes());
        dib[4..8].copy_from_slice(&1i32.to_le_bytes());
        dib[8..12].copy_from_slice(&1i32.to_le_bytes());
        dib[12..14].copy_from_slice(&1u16.to_le_bytes());
        dib[14..16].copy_from_slice(&24u16.to_le_bytes());
        dib[40..44].copy_from_slice(&[30, 20, 10, 0]);
        let c = win::decode_dib(&dib).unwrap();
        let img = image::load_from_memory(c.png.as_ref().unwrap())
            .unwrap()
            .to_rgba8();
        assert_eq!(img.as_raw(), &[10, 20, 30, 255]);
        dib[4..8].copy_from_slice(&i32::MAX.to_le_bytes());
        assert!(win::decode_dib(&dib).is_err());
        assert!(win::decode_dib(&[0; 4]).is_err());
    }
}
