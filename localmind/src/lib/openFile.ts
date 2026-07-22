// ─── "Open source file" helper (KM4) ──────────────────────────────────────
//
// Thin wrapper around @tauri-apps/plugin-opener's `openPath`, used by the
// chat citation popover (ChatMessages.tsx) and the Knowledge Hub
// (KnowledgeHub.tsx) to open a knowledge chunk's original file in the OS's
// default application. Dynamic-imported (mirrors osNotify.ts / the
// clipboard-manager usage in KnowledgeHub.tsx/tools.ts) so the plugin's JS
// bindings never end up in an isolated-webview import graph that can't
// reach `window.__TAURI_INTERNALS__`.
//
// Deliberately does NOT attempt a page-jump (`#page=N` etc.) — that's
// viewer-dependent and unreliable across PDF readers/OSes; the page number
// is already shown in the citation anchor/header, so just opening the file
// is enough.
//
// Requires the `opener:allow-open-path` permission in
// src-tauri/capabilities/default.json — `opener:default` alone only grants
// opening URLs and revealing files in a file explorer, not opening a file's
// contents directly.

/**
 * Open `path` in the OS's default application for its file type. Throws a
 * clear Error on failure (missing file, plugin unavailable outside Tauri,
 * permission not granted, etc.) — callers are expected to catch it and
 * surface a toast rather than let it propagate silently.
 */
export async function openSourceFile(path: string): Promise<void> {
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(path);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not open "${path}": ${message}`);
  }
}
