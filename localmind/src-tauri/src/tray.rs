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
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, Position};
use tauri_plugin_autostart::ManagerExt;

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
pub fn toggle_overlay(app: &AppHandle) {
    let Some(win) = app.get_webview_window("overlay") else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
    } else {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Inset, in logical pixels, between the result widget and the right/bottom
/// edges of the monitor's work area. Scaled by the monitor's scale_factor
/// before use since window positions/sizes are all in physical pixels.
const RESULT_WIDGET_INSET_LOGICAL_PX: f64 = 24.0;

/// Logical size of the compact loading pill shown while a quick-invoke run is
/// in flight — small and content-free on purpose (see ResultWidget.tsx).
const RESULT_WIDGET_COMPACT_SIZE: LogicalSize<f64> = LogicalSize::new(168.0, 60.0);

/// Logical size of the full result card (prompt header, body, close button).
const RESULT_WIDGET_FULL_SIZE: LogicalSize<f64> = LogicalSize::new(420.0, 320.0);

/// Show the quick-invoke result widget (WP5.4), resizing it to the compact
/// loading pill or the full result card and re-anchoring it to the
/// bottom-right corner of whichever monitor it would currently appear on,
/// without ever stealing focus — the entire point of the widget is that the
/// user stays in whatever app they were using.
///
/// Exposed as a Tauri command (`invoke("show_result_widget", { compact })`)
/// so App.tsx can call it right before emitting the matching `quick-result`
/// event — `compact: true` for the "running" pill, `compact: false` for the
/// "done"/"error" card. Tauri's `#[tauri::command]` extractor only implements
/// `CommandArg` for an owned `AppHandle`, not `&AppHandle` (see
/// `tauri::app::CommandArg` impl for `AppHandle<R>`), so the command itself
/// takes `AppHandle` by value; all the positioning logic below only ever
/// borrows it.
///
/// The window is positioned by its top-left corner, so growing/shrinking it
/// without re-anchoring would push it off its bottom-right dock — hence
/// set_size is called FIRST, then outer_size() is re-read (never trust the
/// pre-resize size for the position math), then set_position.
///
/// Positioning failure (no monitor resolvable) is not fatal: per-spec, we fall
/// back to just showing the window wherever it last was rather than erroring
/// out and leaving it hidden.
#[tauri::command]
pub fn show_result_widget(app: AppHandle, compact: bool) {
    let Some(win) = app.get_webview_window("result") else { return };

    let target_size = if compact { RESULT_WIDGET_COMPACT_SIZE } else { RESULT_WIDGET_FULL_SIZE };
    let _ = win.set_size(target_size);

    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten());

    if let (Some(monitor), Ok(size)) = (monitor, win.outer_size()) {
        // work_area() already excludes the taskbar and is expressed in the
        // same physical-pixel coordinate space as monitor.position() (i.e. it
        // accounts for multi-monitor origins that aren't (0, 0)).
        let work_area = monitor.work_area();
        let inset = (RESULT_WIDGET_INSET_LOGICAL_PX * monitor.scale_factor()).round() as i32;

        let x = work_area.position.x + work_area.size.width as i32 - size.width as i32 - inset;
        let y = work_area.position.y + work_area.size.height as i32 - size.height as i32 - inset;

        let _ = win.set_position(Position::Physical(PhysicalPosition { x, y }));
    }

    // Never call set_focus() here — stealing focus is exactly what this
    // widget exists to avoid.
    let _ = win.show();
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
