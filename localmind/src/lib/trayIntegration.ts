// ─── Tray/close-to-tray settings bridge (WP5.1) ───────────────────────────────
//
// The system tray, its menu, and the window-close interception all live in
// Rust (src-tauri/src/tray.rs) — the decision to hide-vs-close has to happen
// inside a WindowEvent::CloseRequested handler, which only Rust can register.
// Rust has no access to the persisted `closeToTray` setting (zustand/
// localStorage), so this module pushes it over on startup and whenever it
// changes via the `set_close_to_tray` command.

import { isTauriEnv } from "./fileSystem";
import { useSettingsStore } from "../store/settings";

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__;
  if (!tauri) throw new Error("not in tauri");
  const core = (tauri as Record<string, unknown>).core as {
    invoke?: (cmd: string, args?: unknown) => Promise<T>;
  };
  if (typeof core?.invoke !== "function") throw new Error("no invoke");
  return core.invoke(cmd, args);
}

let initialized = false;

/**
 * Sync the persisted "close to tray" setting into Rust. Idempotent; call
 * once at app startup (see App.tsx). No-ops outside Tauri.
 */
export function initTrayIntegration(): void {
  if (initialized || !isTauriEnv()) return;
  initialized = true;

  const push = (enabled: boolean) => {
    void tauriInvoke("set_close_to_tray", { enabled }).catch(() => {
      // Non-fatal — worst case the window closes normally instead of hiding.
    });
  };

  push(useSettingsStore.getState().closeToTray);
  useSettingsStore.subscribe((state, prevState) => {
    if (state.closeToTray !== prevState.closeToTray) push(state.closeToTray);
  });
}
