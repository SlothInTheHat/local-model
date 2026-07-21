import React from "react";
import ReactDOM from "react-dom/client";
import { QuickInvoke } from "./QuickInvoke";
// Self-hosted fonts, mirroring src/main.tsx, so the overlay's typography
// matches the main window (offline-first — no Google Fonts CDN `@import`).
import "@fontsource-variable/dm-sans";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "../index.css";

// IMPORTANT (WP5.3 hard constraint): this file must NEVER import ../App,
// anything from ../store/, or any ../lib module with startup side effects
// (scheduler, taskRunner, mcpAutoConnect, ollama init). The overlay is a dumb
// input box — all real execution happens in the main window via the
// `quick-invoke` Tauri event. Importing those modules here would boot a
// second scheduler/task runner inside this webview and fire every scheduled
// job twice.

try {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <QuickInvoke />
    </React.StrictMode>,
  );
} catch (e) {
  // No error-boundary machinery needed for this tiny window — just don't let
  // a render error leave a blank, undismissable overlay silently on screen.
  console.error("[quick-invoke] failed to mount:", e);
}
