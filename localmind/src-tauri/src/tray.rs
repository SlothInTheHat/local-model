// ─── System tray + close-to-tray + global hotkey glue (WP5.1) ────────────────
//
// LocalMind lives in the system tray so background jobs (scheduler, task
// queue) keep running after the window is closed — closing the window via
// the X button hides it instead of exiting (see the on_window_event handler
// below). Only the tray's "Quit" item, or the OS killing the process,
// actually terminates the app.
//
// Everything here runs on the Rust side; the only bridge to the frontend is
// `set_close_to_tray`, which the JS settings store calls whenever the
// persisted "close to tray" preference changes (see
// src/lib/trayIntegration.ts) so the window-close handler knows what to do
// without needing to read localStorage from Rust.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Position};
use tauri_plugin_autostart::ManagerExt;

// WP7.1 rework: the quick-invoke overlay used to hand off drawing to a
// separate fullscreen `annotate` window (show_annotate_overlay /
// finish_annotate, which lived here). That window is gone — drawing now
// happens directly on the `overlay` window itself (see
// src/overlay/QuickInvoke.tsx's file-level comment for why: two windows
// meant one focus, so you could never dictate into one while drawing in the
// other). toggle_overlay below absorbs show_annotate_overlay's full-monitor
// sizing logic since the overlay itself now needs to cover the whole screen
// whenever it's shown.

const SHOW_ID: &str = "show";
const AUTOSTART_ID: &str = "autostart_toggle";
const QUIT_ID: &str = "quit";

/// Whether the window's X button hides to tray (true) or closes/exits like a
/// normal app (false). Defaults to true (tray-first) until the frontend
/// reports the persisted setting on startup.
static CLOSE_TO_TRAY: OnceLock<AtomicBool> = OnceLock::new();

fn close_to_tray_flag() -> &'static AtomicBool {
    CLOSE_TO_TRAY.get_or_init(|| AtomicBool::new(true))
}

/// Tauri command the frontend calls whenever the "close to tray" setting
/// changes (including once on startup with the persisted value).
#[tauri::command]
pub fn set_close_to_tray(enabled: bool) {
    close_to_tray_flag().store(enabled, Ordering::Relaxed);
}

/// Show, un-minimize, and focus the main window. Used by the tray's "Show
/// LocalMind" item, left-clicking the tray icon, and the global hotkey.
fn show_and_focus(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Toggle the main window's visibility — bound to the global hotkey
/// (Ctrl+Shift+Space) so it works as a show/hide flip from anywhere in the OS.
pub fn toggle_main_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("main") else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
    } else {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Toggle the quick-invoke overlay's visibility — bound to the global hotkey
/// (Ctrl+Shift+K), mirroring `toggle_main_window` above. The overlay has no
/// minimize state (it's a small always-on-top, non-taskbar window), so unlike
/// the main window there's no `unminimize()` call needed.
///
/// WP7.1 rework: the overlay is now a FULLSCREEN HUD (prompt card + a
/// full-screen drawing canvas behind it), not the small 620x200 box it used
/// to be — drawing was moved into this window instead of a separate
/// `annotate` window (see QuickInvoke.tsx's file-level comment). So the SHOW
/// branch here now does what `show_annotate_overlay` used to do: size and
/// position the window to the FULL monitor bounds (`monitor.size()` /
/// `monitor.position()`, NOT `work_area()` — the user may want to circle
/// something that's partially under the taskbar, and a gap between the
/// canvas and the screen edge would be a dead zone they can't draw into)
/// before showing it. This must happen every time, not just once at window
/// creation: the window is configured with a small placeholder size (see
/// tauri.conf.json) so it exists cheaply at launch, and the user could also
/// invoke it on a different monitor (with different bounds) than last time.
pub fn toggle_overlay(app: &AppHandle) {
    let Some(win) = app.get_webview_window("overlay") else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
    } else {
        let monitor = win
            .current_monitor()
            .ok()
            .flatten()
            .or_else(|| win.primary_monitor().ok().flatten());

        if let Some(monitor) = monitor {
            // Full monitor bounds, not work_area() — see doc comment above.
            let _ = win.set_size(monitor.size().to_owned());
            let _ = win.set_position(Position::Physical(*monitor.position()));
        }

        let _ = win.show();
        let _ = win.set_focus();

        // Tells QuickInvoke.tsx "this is a genuinely fresh invocation" —
        // distinct from onFocusChanged(true), which now also fires for
        // reasons that are NOT a fresh hotkey press (e.g. the merged
        // overlay/result window regaining focus while a run is in flight or
        // a result/walkthrough is already showing, both of which must
        // survive blur — see QuickInvoke.tsx's phase state machine). Only
        // the SHOW branch above should ever reset ink/position/dictation for
        // a new session; the HIDE branch and a plain refocus must not.
        let _ = app.emit("quick-invoke-open", ());
    }
}

/// Returns the OS cursor position in physical pixels — the same
/// virtual-desktop coordinate space monitor.position()/size() already use.
/// JS only ever sees pointer coordinates relative to its own window, never
/// the global OS cursor position, so this is the frontend's only way to know
/// where the cursor actually is. Used by the quick-invoke overlay to spawn
/// its prompt bar near the cursor (QuickInvoke.tsx's onFocusChanged) instead
/// of always centered — the window itself stays fullscreen (still needed for
/// freehand circling elsewhere on screen); only the bar's position within it
/// moves. `None` on any failure (no overlay window, cursor query failed) —
/// the caller falls back to the existing centered position, so this is
/// never fatal to opening the overlay.
#[tauri::command]
pub fn get_cursor_position(app: AppHandle) -> Option<(f64, f64)> {
    let win = app.get_webview_window("overlay")?;
    let pos = win.cursor_position().ok()?;
    Some((pos.x, pos.y))
}

/// Payload for the `highlight-element` event — already converted into the
/// overlay window's own CSS-pixel viewport space (physical rect minus the
/// target monitor's physical position, divided by its scale factor), so
/// QuickInvoke.tsx's render loop can draw it with the exact same math it
/// already uses for stroke coordinates, no further conversion needed.
#[derive(Clone, serde::Serialize)]
struct HighlightElementPayload {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    /// Whether the overlay was already visible before this call. `false`
    /// means this call is the only reason the window is showing, so the
    /// frontend owns auto-hiding it once the ring's lifetime ends; `true`
    /// means the user already had it open and only the ring layers on top —
    /// visibility stays whatever the user's own session was already doing.
    was_visible: bool,
}

/// Draw a highlighting ring around a UI element's bounding rect — `x`/`y`/
/// `width`/`height` are physical screen pixels in the same virtual-desktop
/// space `uia_list_elements`'s `bounding_rect` and `monitor.position()`/
/// `size()` already use. Resolves which monitor the rect's center falls on,
/// positions/shows the overlay there ONLY if it wasn't already visible
/// (mirroring `toggle_overlay`'s full-bounds sizing — never `work_area()`,
/// same reasoning as there), then emits `highlight-element` with the rect
/// converted into that monitor's CSS-pixel space.
///
/// Deliberately never calls `set_focus()` — this is a passive visual
/// pointer, not a window the user is meant to be yanked into.
#[tauri::command]
pub fn highlight_screen_rect(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let win = app
        .get_webview_window("overlay")
        .ok_or_else(|| "overlay window not found".to_string())?;

    let was_visible = win.is_visible().unwrap_or(false);

    let center_x = x + width / 2.0;
    let center_y = y + height / 2.0;

    let monitors = win.available_monitors().map_err(|e| e.to_string())?;
    let target_monitor = monitors
        .into_iter()
        .find(|m| {
            let pos = m.position();
            let size = m.size();
            center_x >= pos.x as f64
                && center_x < pos.x as f64 + size.width as f64
                && center_y >= pos.y as f64
                && center_y < pos.y as f64 + size.height as f64
        })
        .or_else(|| win.primary_monitor().ok().flatten());

    let Some(monitor) = target_monitor else {
        return Err("could not resolve a monitor for the target rect".to_string());
    };

    if !was_visible {
        let _ = win.set_size(monitor.size().to_owned());
        let _ = win.set_position(Position::Physical(*monitor.position()));
        let _ = win.show();
    }

    let scale = monitor.scale_factor();
    let mpos = monitor.position();
    let payload = HighlightElementPayload {
        x: (x - mpos.x as f64) / scale,
        y: (y - mpos.y as f64) / scale,
        width: width / scale,
        height: height / scale,
        was_visible,
    };

    app.emit("highlight-element", payload).map_err(|e| e.to_string())
}

/// Build the tray icon + right-click menu and wire up close-to-tray window
/// interception. Called once from `setup()`.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);

    let show_item = MenuItem::with_id(app, SHOW_ID, "Show LocalMind", true, None::<&str>)?;
    let autostart_item = CheckMenuItem::with_id(
        app,
        AUTOSTART_ID,
        "Start hidden on login",
        true,
        autostart_enabled,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, QUIT_ID, "Quit", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&show_item, &autostart_item, &separator, &quit_item])?;

    // Reuse the app's configured window icon (src-tauri/icons/) rather than
    // bundling a second image just for the tray.
    let icon = app
        .default_window_icon()
        .cloned()
        .expect("default window icon missing — check tauri.conf.json bundle.icon");

    // Cloned handle for the checkbox item so on_menu_event can flip its
    // `checked` state after toggling autostart (CheckMenuItem is Arc-backed,
    // so this clone is cheap and refers to the same underlying menu item).
    let autostart_item_for_menu = autostart_item.clone();
    let app_for_menu = app.clone();
    let app_for_tray = app.clone();

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("LocalMind")
        .on_menu_event(move |_tray_app, event| match event.id().as_ref() {
            SHOW_ID => show_and_focus(&app_for_menu),
            AUTOSTART_ID => {
                let mgr = app_for_menu.autolaunch();
                let currently_enabled = mgr.is_enabled().unwrap_or(false);
                let result = if currently_enabled { mgr.disable() } else { mgr.enable() };
                if let Err(e) = result {
                    eprintln!("[tray] autostart toggle failed: {e}");
                }
                // Re-read rather than assume success — reflects whatever the
                // OS actually did.
                if let Ok(checked) = mgr.is_enabled() {
                    let _ = autostart_item_for_menu.set_checked(checked);
                }
            }
            QUIT_ID => {
                // Bypasses CloseRequested entirely, so close-to-tray never
                // blocks a real quit.
                app_for_menu.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(move |_tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_and_focus(&app_for_tray);
            }
        })
        .build(app)?;

    // Close-to-tray: intercept the window's X button and hide instead of
    // closing, unless the user has turned the setting off. Quit (above) exits
    // via AppHandle::exit, which does not raise CloseRequested, so it is
    // never caught by this handler.
    if let Some(win) = app.get_webview_window("main") {
        let win_for_handler = win.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if close_to_tray_flag().load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = win_for_handler.hide();
                }
            }
        });
    }

    Ok(())
}
