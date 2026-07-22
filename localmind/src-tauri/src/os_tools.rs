//! OS-actuation commands: launching applications (WP5.2a), and window
//! control + screenshot/OCR (WP5.2b). Clipboard access is handled entirely on
//! the frontend via tauri-plugin-clipboard-manager's JS API, so this module
//! only needs to cover things with no first-party plugin.
//!
//! Window control and screen capture are Windows-only (`Win32`/WinRT APIs
//! behind `#[cfg(target_os = "windows")]`); other targets compile but return
//! a runtime "unsupported on this platform" `Err` instead of panicking.

use std::process::Command;

/// Launch an application (or open a document/URL) by name via the OS shell,
/// mirroring what typing the same name into Start/Spotlight/`xdg-open` would
/// do. Deliberately does no resolution or validation of `name` — the shell
/// itself resolves PATH entries, registered app names, and file associations,
/// which is both simpler and more capable than reimplementing that lookup.
///
/// Waits for the launcher command (`.output()`, not `.spawn()`) so a nonzero
/// exit status — Windows' `start` reports failed lookups this way — becomes
/// an `Err` instead of a blind "Launched X". This only waits on the shell
/// launcher handing off, not on the launched app's lifetime, so it returns
/// promptly either way. Exit status is not 100% reliable for every failure
/// shape (e.g. a GUI "no association" dialog can appear instead of a clean
/// nonzero exit), so even the success path is worded as a request, not a
/// confirmed launch.
#[tauri::command]
pub fn open_application(name: String) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("Application name is empty".to_string());
    }

    #[cfg(target_os = "windows")]
    let output = {
        // `start` is a cmd builtin, not an exe, so it must run through cmd.exe.
        // The first "" argument is `start`'s window-title parameter — required
        // whenever the target itself might contain spaces/quotes, otherwise
        // `start` misinterprets a quoted target as the title.
        Command::new("cmd")
            .args(["/C", "start", "", &name])
            .output()
            .map_err(|e| format!("Failed to launch '{name}': {e}"))?
    };

    #[cfg(target_os = "macos")]
    let output = Command::new("open")
        .arg(&name)
        .output()
        .map_err(|e| format!("Failed to launch '{name}': {e}"))?;

    #[cfg(target_os = "linux")]
    let output = Command::new("xdg-open")
        .arg(&name)
        .output()
        .map_err(|e| format!("Failed to launch '{name}': {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!(
                "Windows could not launch '{name}' (exit code {:?}). '{name}' may not be a recognized application, file, or URL — retry with the underlying executable name (e.g. 'mspaint' for Paint, 'calc' for Calculator, 'cmd' for Command Prompt) rather than searching the workspace filesystem.",
                output.status.code()
            )
        } else {
            format!("Failed to launch '{name}': {stderr}")
        });
    }

    Ok(format!(
        "Requested launch of '{name}' via the OS shell. If it did not appear, '{name}' may not be the right name — retry with the underlying executable name (e.g. 'mspaint' for Paint, 'calc' for Calculator)."
    ))
}

// ─── Window control + screenshot/OCR (WP5.2b) ──────────────────────────────

/// One visible top-level window, as returned by `list_windows`.
#[derive(serde::Serialize)]
pub struct WindowInfo {
    /// HWND cast to `isize` and stringified — JSON-safe, and round-trips back
    /// to a real HWND in `focus_window`.
    pub id: String,
    pub title: String,
}

/// Result of `take_screenshot`: the saved PNG's absolute path plus whatever
/// OCR text (if any) could be extracted from it.
///
/// `Clone` is needed so `capture_region` (WP7.1) can both return this to its
/// caller AND stash a copy in `PENDING_REGION` for `take_screenshot` to pick
/// up later — the two consumers need independent owned values.
#[derive(serde::Serialize, Clone)]
pub struct ScreenshotResult {
    pub path: String,
    pub ocr_text: String,
    pub ocr_available: bool,
}

// ─── Region capture (WP7.1: "circle what you care about") ─────────────────
//
// The annotate overlay (src/annotate/Annotate.tsx) lets the user draw a
// freehand marker loop around a region of their screen; it computes a
// bounding box in physical pixels and calls `capture_region` directly. But
// the AGENT never calls capture_region itself — its tool schema only knows
// about `take_screenshot` (see QUICK_INVOKE_ALLOWLIST in App.tsx, which is
// deliberately NOT touched by this feature). So capture_region stashes its
// result here, and `take_screenshot` below checks the stash first and
// returns the cropped region in its place if one is fresh enough. This is
// the entire seam that makes "circle a region" work without adding a new
// tool the model has to be taught about.
use std::sync::Mutex;

/// A stashed region capture plus the epoch-ms timestamp it was captured at
/// (for the freshness check in `take_screenshot`).
static PENDING_REGION: Mutex<Option<(ScreenshotResult, u128)>> = Mutex::new(None);

/// How long a stashed region capture stays valid. Generous enough to survive
/// the round-trip from "user finishes circling" through "agent gets invoked
/// and decides to call take_screenshot", but short enough that a stale region
/// from a much earlier session can never silently leak into an unrelated
/// later screenshot request.
const PENDING_REGION_MAX_AGE_MS: u128 = 120_000;

fn now_epoch_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Capture exactly the given rectangle (physical pixels, screen-origin
/// coordinates) of the primary monitor, save it as a PNG using the same
/// filename pattern `take_screenshot` uses, OCR the cropped pixels, and stash
/// the result for `take_screenshot` to hand to the agent next. Called by the
/// annotate overlay right after the user finishes drawing.
#[tauri::command]
pub fn capture_region(x: i32, y: i32, width: u32, height: u32) -> Result<ScreenshotResult, String> {
    #[cfg(target_os = "windows")]
    {
        let result = windows_impl::capture_region(x, y, width, height)?;
        if let Ok(mut slot) = PENDING_REGION.lock() {
            *slot = Some((result.clone(), now_epoch_ms()));
        }
        Ok(result)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (x, y, width, height);
        Err("Screen capture is only supported on Windows".to_string())
    }
}

/// Discard a stashed region capture without consuming it — used when the
/// user cancels the annotate overlay (Escape / right-click) so a screenshot
/// taken later in the session doesn't unexpectedly come back cropped to a
/// region the user explicitly abandoned.
#[tauri::command]
pub fn clear_pending_region() {
    if let Ok(mut slot) = PENDING_REGION.lock() {
        *slot = None;
    }
}

/// Enumerate visible top-level windows (title + stable id).
#[tauri::command]
pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::list_windows()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Window listing is only supported on Windows".to_string())
    }
}

/// Bring a window to the foreground by the id returned from `list_windows`.
#[tauri::command]
pub fn focus_window(id: String) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        windows_impl::focus_window(&id)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = id;
        Err("Window focus is only supported on Windows".to_string())
    }
}

/// Capture the primary monitor, save a PNG to the temp dir, run OCR over it,
/// and return the OCR text plus the saved path. If no OCR language pack is
/// installed (or OCR otherwise fails), the capture still succeeds — the
/// result just carries a note that OCR was unavailable instead of an error.
#[tauri::command]
pub fn take_screenshot() -> Result<ScreenshotResult, String> {
    // WP7.1 seam: if the user recently circled a region via the annotate
    // overlay, hand back THAT cropped capture instead of grabbing the whole
    // screen again — this is what makes "circle what you care about" work
    // through the agent's existing take_screenshot tool call with no schema
    // changes. Consume (take) the stash so a second take_screenshot call in
    // the same run falls through to a normal full-screen capture rather than
    // replaying the same region forever. A stash older than
    // PENDING_REGION_MAX_AGE_MS is treated as stale and dropped, not returned
    // — an ancient region from an abandoned earlier session must never
    // silently answer a fresh, unrelated screenshot request.
    if let Ok(mut slot) = PENDING_REGION.lock() {
        if let Some((result, captured_at)) = slot.take() {
            if now_epoch_ms().saturating_sub(captured_at) < PENDING_REGION_MAX_AGE_MS {
                return Ok(result);
            }
            // else: fall through to the full-screen path below; the stale
            // entry has already been cleared by `.take()` above.
        }
    }

    #[cfg(target_os = "windows")]
    {
        windows_impl::take_screenshot()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Screen capture is only supported on Windows".to_string())
    }
}

/// Read a PNG produced by `take_screenshot`, downscale it if either dimension
/// exceeds `max_dim` (preserving aspect ratio), and return it as standard
/// base64 (no `data:` URI prefix) — the format the frontend's existing
/// image-attachment path (`src/lib/imageUtils.ts` `fileToBase64`) already
/// feeds to Ollama's `images` field. Used by WP6.2b's screenshot vision
/// sub-call so a 4K capture doesn't cross the IPC boundary and then the
/// network as several raw megabytes.
///
/// Platform-independent (pure `image`-crate work, no WinRT/GDI), so unlike
/// the capture/OCR commands above this isn't gated behind
/// `target_os = "windows"`.
///
/// SECURITY: this command hands arbitrary file bytes back to the frontend on
/// request, so it must not become a general-purpose file reader. It is
/// deliberately confined to exactly the files `take_screenshot` itself
/// produces: canonicalize `path`, require its parent directory to be
/// `std::env::temp_dir()` (no escaping via `..` or symlinks), and require the
/// filename to match `localmind-screenshot-<digits>.png` — the exact pattern
/// `windows_impl::take_screenshot` writes above. Any other path is refused.
#[tauri::command]
pub fn read_image_base64(path: String, max_dim: u32) -> Result<String, String> {
    let requested = std::path::Path::new(&path);
    let canonical = dunce::canonicalize(requested)
        .map_err(|e| format!("Cannot access '{path}': {e}"))?;

    let temp_dir = dunce::canonicalize(std::env::temp_dir())
        .map_err(|e| format!("Cannot resolve temp dir: {e}"))?;

    if canonical.parent() != Some(temp_dir.as_path()) {
        return Err(
            "Refusing to read a file outside the screenshot temp directory".to_string(),
        );
    }

    let filename = canonical
        .file_name()
        .and_then(|f| f.to_str())
        .ok_or_else(|| "Invalid file name".to_string())?;

    let matches_screenshot_pattern = filename
        .strip_prefix("localmind-screenshot-")
        .and_then(|rest| rest.strip_suffix(".png"))
        .is_some_and(|stem| !stem.is_empty() && stem.chars().all(|c| c.is_ascii_digit()));

    if !matches_screenshot_pattern {
        return Err(format!(
            "Refusing to read '{filename}' — only this app's own screenshot temp files (localmind-screenshot-<id>.png) are allowed"
        ));
    }

    let img = image::open(&canonical).map_err(|e| format!("Failed to open image: {e}"))?;
    let resized = if img.width() > max_dim || img.height() > max_dim {
        img.resize(max_dim, max_dim, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };

    let mut bytes: Vec<u8> = Vec::new();
    resized
        .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode PNG: {e}"))?;

    Ok(crate::base64_encode(&bytes))
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{ScreenshotResult, WindowInfo};
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC,
        HGDIOBJ, SRCCOPY,
    };
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetSystemMetrics, GetWindowTextLengthW, GetWindowTextW, IsWindowVisible,
        SetForegroundWindow, ShowWindow, SM_CXSCREEN, SM_CYSCREEN, SW_RESTORE,
    };

    // ─── Window enumeration / focus ─────────────────────────────────────────

    unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let windows = &mut *(lparam.0 as *mut Vec<WindowInfo>);
        if IsWindowVisible(hwnd).as_bool() {
            let len = GetWindowTextLengthW(hwnd);
            if len > 0 {
                let mut buf = vec![0u16; (len + 1) as usize];
                let copied = GetWindowTextW(hwnd, &mut buf);
                if copied > 0 {
                    let title = String::from_utf16_lossy(&buf[..copied as usize]);
                    if !title.trim().is_empty() {
                        windows.push(WindowInfo {
                            id: (hwnd.0 as isize).to_string(),
                            title,
                        });
                    }
                }
            }
        }
        BOOL(1) // continue enumeration
    }

    pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
        let mut windows: Vec<WindowInfo> = Vec::new();
        unsafe {
            EnumWindows(
                Some(enum_windows_proc),
                LPARAM(&mut windows as *mut _ as isize),
            )
            .map_err(|e| format!("EnumWindows failed: {e}"))?;
        }
        Ok(windows)
    }

    pub fn focus_window(id: &str) -> Result<String, String> {
        let raw: isize = id
            .trim()
            .parse()
            .map_err(|_| format!("Invalid window id '{id}'"))?;
        let hwnd = HWND(raw as *mut core::ffi::c_void);
        unsafe {
            // Restore first — SetForegroundWindow on a minimized window
            // brings the taskbar entry forward without actually un-minimizing it.
            let _ = ShowWindow(hwnd, SW_RESTORE);
            if !SetForegroundWindow(hwnd).as_bool() {
                return Err(format!("Failed to focus window '{id}' (it may have closed)"));
            }
        }
        Ok(format!("Focused window {id}"))
    }

    // ─── Screen capture ──────────────────────────────────────────────────────

    /// Frees every GDI object it holds on drop, including on early returns via
    /// `?` — leaked device contexts/bitmaps are the classic bug with this API.
    struct CaptureGuard {
        screen_dc: HDC,
        mem_dc: HDC,
        bitmap: HBITMAP,
    }

    impl Drop for CaptureGuard {
        fn drop(&mut self) {
            unsafe {
                if !self.bitmap.0.is_null() {
                    let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
                }
                if !self.mem_dc.0.is_null() {
                    let _ = DeleteDC(self.mem_dc);
                }
                if !self.screen_dc.0.is_null() {
                    ReleaseDC(None, self.screen_dc);
                }
            }
        }
    }

    /// Captures the primary monitor via GDI `BitBlt` and returns the raw
    /// top-down BGRA32 pixel buffer plus its dimensions.
    fn capture_primary_monitor() -> Result<(Vec<u8>, i32, i32), String> {
        unsafe {
            let width = GetSystemMetrics(SM_CXSCREEN);
            let height = GetSystemMetrics(SM_CYSCREEN);
            if width <= 0 || height <= 0 {
                return Err("Failed to read primary monitor dimensions".to_string());
            }

            let screen_dc = GetDC(None);
            if screen_dc.0.is_null() {
                return Err("GetDC failed".to_string());
            }
            let mem_dc = CreateCompatibleDC(Some(screen_dc));
            if mem_dc.0.is_null() {
                ReleaseDC(None, screen_dc);
                return Err("CreateCompatibleDC failed".to_string());
            }
            let bitmap = CreateCompatibleBitmap(screen_dc, width, height);
            if bitmap.0.is_null() {
                let _ = DeleteDC(mem_dc);
                ReleaseDC(None, screen_dc);
                return Err("CreateCompatibleBitmap failed".to_string());
            }

            // From here on, `_guard` frees all three objects on every exit path.
            let _guard = CaptureGuard { screen_dc, mem_dc, bitmap };

            let old_obj = SelectObject(mem_dc, HGDIOBJ(bitmap.0));
            let blt = BitBlt(mem_dc, 0, 0, width, height, Some(screen_dc), 0, 0, SRCCOPY);
            SelectObject(mem_dc, old_obj); // restore before any further use of mem_dc
            blt.map_err(|e| format!("BitBlt failed: {e}"))?;

            let mut bmi = BITMAPINFO::default();
            bmi.bmiHeader.biSize = std::mem::size_of_val(&bmi.bmiHeader) as u32;
            bmi.bmiHeader.biWidth = width;
            bmi.bmiHeader.biHeight = -height; // negative = top-down DIB
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = BI_RGB.0;

            let row_size = width as usize * 4;
            let mut buffer = vec![0u8; row_size * height as usize];

            let copied = GetDIBits(
                mem_dc,
                bitmap,
                0,
                height as u32,
                Some(buffer.as_mut_ptr() as *mut core::ffi::c_void),
                &mut bmi,
                DIB_RGB_COLORS,
            );
            if copied == 0 {
                return Err("GetDIBits failed".to_string());
            }

            Ok((buffer, width, height))
        }
    }

    /// Runs OCR over a raw BGRA32 buffer via `Windows.Media.Ocr`. Any failure
    /// here (including "no language pack installed") is returned as an `Err`
    /// for the caller to fold into a non-fatal note — screenshot capture must
    /// still succeed even when OCR can't run.
    fn try_ocr(bgra: &[u8], width: i32, height: i32) -> Result<String, String> {
        use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
        use windows::Media::Ocr::OcrEngine;
        use windows::Storage::Streams::DataWriter;

        // WinRT calls (Ocr, SoftwareBitmap) require the calling thread to have
        // an initialized COM apartment; Tauri command threads don't guarantee
        // one. Only balance with CoUninitialize if this call is what owns it —
        // RPC_E_CHANGED_MODE (already init'd in a different mode) must not be
        // uninitialized out from under whoever set that mode up.
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        let com_owned = hr.is_ok();

        let result = (|| -> Result<String, String> {
            let engine = OcrEngine::TryCreateFromUserProfileLanguages()
                .map_err(|e| format!("no OCR engine available: {e}"))?;

            let writer = DataWriter::new().map_err(|e| e.to_string())?;
            writer.WriteBytes(bgra).map_err(|e| e.to_string())?;
            let buffer = writer.DetachBuffer().map_err(|e| e.to_string())?;

            let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
                &buffer,
                BitmapPixelFormat::Bgra8,
                width,
                height,
                BitmapAlphaMode::Ignore,
            )
            .map_err(|e| e.to_string())?;

            let op = engine.RecognizeAsync(&bitmap).map_err(|e| e.to_string())?;
            // Blocking .get() is fine here — this runs off the UI thread.
            let ocr_result = op.get().map_err(|e| e.to_string())?;
            ocr_result.Text().map_err(|e| e.to_string()).map(|s| s.to_string())
        })();

        if com_owned {
            unsafe { CoUninitialize() };
        }

        result
    }

    /// Crop the given rectangle out of a full-monitor BGRA32 buffer,
    /// clamping it to the buffer's actual bounds first. Returns the cropped
    /// buffer plus its (clamped) width/height/origin, or an `Err` if the
    /// clamped rect has zero area (e.g. the requested rect was entirely off
    /// the monitor).
    fn crop_bgra(
        bgra: &[u8],
        full_width: i32,
        full_height: i32,
        x: i32,
        y: i32,
        width: u32,
        height: u32,
    ) -> Result<(Vec<u8>, i32, i32, i32, i32), String> {
        // Clamp the requested rect to the captured bounds. `x`/`y` can be
        // negative (multi-monitor setups place secondary monitors at
        // negative coordinates) but this capture is always of the PRIMARY
        // monitor at origin (0, 0), so clamp against [0, full_width) /
        // [0, full_height) directly.
        let clamped_x = x.clamp(0, full_width);
        let clamped_y = y.clamp(0, full_height);
        let requested_right = clamped_x.saturating_add(width as i32);
        let requested_bottom = clamped_y.saturating_add(height as i32);
        let clamped_right = requested_right.clamp(0, full_width);
        let clamped_bottom = requested_bottom.clamp(0, full_height);

        let crop_width = (clamped_right - clamped_x).max(0);
        let crop_height = (clamped_bottom - clamped_y).max(0);

        if crop_width == 0 || crop_height == 0 {
            return Err(format!(
                "Requested region ({x}, {y}, {width}x{height}) has zero area after clamping to the captured {full_width}x{full_height} screen"
            ));
        }

        let src_row_bytes = full_width as usize * 4;
        let crop_row_bytes = crop_width as usize * 4;
        let mut cropped = vec![0u8; crop_row_bytes * crop_height as usize];

        for row in 0..crop_height as usize {
            let src_start = (clamped_y as usize + row) * src_row_bytes + clamped_x as usize * 4;
            let src_end = src_start + crop_row_bytes;
            let dst_start = row * crop_row_bytes;
            let dst_end = dst_start + crop_row_bytes;
            cropped[dst_start..dst_end].copy_from_slice(&bgra[src_start..src_end]);
        }

        Ok((cropped, crop_width, crop_height, clamped_x, clamped_y))
    }

    /// Save a BGRA32 buffer as a PNG at the given path, converting to RGBA
    /// first (the `image` crate's PNG encoder wants RGBA order; GDI/OCR both
    /// produce BGRA). Shared by the full-screen and region capture paths.
    fn save_bgra_as_png(bgra: &[u8], width: u32, height: u32, path: &std::path::Path) -> Result<(), String> {
        let rgba = image::RgbaImage::from_raw_bgra(width, height, bgra.to_vec())
            .ok_or_else(|| "Failed to build image buffer from captured pixels".to_string())?;
        rgba.save(path)
            .map_err(|e| format!("Failed to save screenshot PNG: {e}"))
    }

    /// Capture only the given rectangle of the primary monitor (WP7.1: the
    /// "circle what you care about" annotate flow). Reuses
    /// `capture_primary_monitor` for the underlying GDI grab — there's no
    /// cheaper Win32 path to a sub-rect capture than blitting the whole
    /// screen and cropping in memory — then crops, saves under the exact
    /// same `localmind-screenshot-<epoch_ms>.png` pattern `take_screenshot`
    /// uses (critical: `read_image_base64`'s allowlist only accepts that
    /// pattern), and OCRs the CROPPED pixels so the recognized text matches
    /// what's actually in the saved image rather than the whole screen.
    pub fn capture_region(x: i32, y: i32, width: u32, height: u32) -> Result<ScreenshotResult, String> {
        let (bgra, full_width, full_height) = capture_primary_monitor()?;
        let (cropped, crop_width, crop_height, _clamped_x, _clamped_y) =
            crop_bgra(&bgra, full_width, full_height, x, y, width, height)?;

        let epoch_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("localmind-screenshot-{epoch_ms}.png"));
        save_bgra_as_png(&cropped, crop_width as u32, crop_height as u32, &path)?;

        let path_str = path.to_string_lossy().to_string();

        match try_ocr(&cropped, crop_width, crop_height) {
            Ok(text) => Ok(ScreenshotResult {
                path: path_str,
                ocr_text: text,
                ocr_available: true,
            }),
            Err(e) => Ok(ScreenshotResult {
                path: path_str,
                ocr_text: format!("(OCR unavailable: {e})"),
                ocr_available: false,
            }),
        }
    }

    pub fn take_screenshot() -> Result<ScreenshotResult, String> {
        let (bgra, width, height) = capture_primary_monitor()?;

        let epoch_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("localmind-screenshot-{epoch_ms}.png"));
        save_bgra_as_png(&bgra, width as u32, height as u32, &path)?;

        let path_str = path.to_string_lossy().to_string();

        match try_ocr(&bgra, width, height) {
            Ok(text) => Ok(ScreenshotResult {
                path: path_str,
                ocr_text: text,
                ocr_available: true,
            }),
            Err(e) => Ok(ScreenshotResult {
                path: path_str,
                ocr_text: format!("(OCR unavailable: {e})"),
                ocr_available: false,
            }),
        }
    }
}
