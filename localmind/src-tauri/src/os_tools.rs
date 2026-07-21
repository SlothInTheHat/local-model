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
#[tauri::command]
pub fn open_application(name: String) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("Application name is empty".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        // `start` is a cmd builtin, not an exe, so it must run through cmd.exe.
        // The first "" argument is `start`'s window-title parameter — required
        // whenever the target itself might contain spaces/quotes, otherwise
        // `start` misinterprets a quoted target as the title.
        Command::new("cmd")
            .args(["/C", "start", "", &name])
            .spawn()
            .map_err(|e| format!("Failed to launch '{name}': {e}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&name)
            .spawn()
            .map_err(|e| format!("Failed to launch '{name}': {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&name)
            .spawn()
            .map_err(|e| format!("Failed to launch '{name}': {e}"))?;
    }

    Ok(format!("Launched {name}"))
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
#[derive(serde::Serialize)]
pub struct ScreenshotResult {
    pub path: String,
    pub ocr_text: String,
    pub ocr_available: bool,
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
    #[cfg(target_os = "windows")]
    {
        windows_impl::take_screenshot()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Screen capture is only supported on Windows".to_string())
    }
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

    pub fn take_screenshot() -> Result<ScreenshotResult, String> {
        let (bgra, width, height) = capture_primary_monitor()?;

        let epoch_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("localmind-screenshot-{epoch_ms}.png"));

        // `image` wants RGBA order; GDI/OCR both use BGRA, so convert on a
        // clone rather than disturbing the buffer OCR still needs.
        let rgba = image::RgbaImage::from_raw_bgra(width as u32, height as u32, bgra.clone())
            .ok_or_else(|| "Failed to build image buffer from captured pixels".to_string())?;
        rgba.save(&path)
            .map_err(|e| format!("Failed to save screenshot PNG: {e}"))?;

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
