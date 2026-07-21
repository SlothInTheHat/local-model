// ─── OS notification helper (WP5.1) ───────────────────────────────────────────
//
// Thin wrapper around @tauri-apps/plugin-notification: requests permission on
// first use (cached for the session so we don't prompt repeatedly) and no-ops
// gracefully outside Tauri (browser/`npm run dev` in a plain browser tab has
// no OS notification bridge and would otherwise throw).
//
// Wired into scheduler.ts (handleJobDue) and taskRunner.ts
// (processNextPending): background completions notify at the OS level because
// with close-to-tray the window — and its sonner toasts — may be hidden.

import { isTauriEnv } from "./fileSystem";

let permissionChecked = false;
let permissionGranted = false;

async function ensurePermission(): Promise<boolean> {
  if (permissionChecked) return permissionGranted;
  try {
    const { isPermissionGranted, requestPermission } = await import("@tauri-apps/plugin-notification");
    let granted = await isPermissionGranted();
    if (!granted) {
      const result = await requestPermission();
      granted = result === "granted";
    }
    permissionGranted = granted;
  } catch {
    // Plugin unavailable (non-Tauri context, or platform without a
    // notification backend) — treat as not granted rather than throwing.
    permissionGranted = false;
  } finally {
    permissionChecked = true;
  }
  return permissionGranted;
}

/**
 * Send an OS-level notification (toast). Safe to call from anywhere:
 * no-ops in browser/dev-server mode and swallows any plugin error so a
 * notification failure never breaks a calling feature.
 */
export async function notifyOs(title: string, body?: string): Promise<void> {
  if (!isTauriEnv()) return;
  try {
    const granted = await ensurePermission();
    if (!granted) return;
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    sendNotification(body ? { title, body } : { title });
  } catch {
    // Best-effort only — never let a notification failure propagate.
  }
}
