import React from "react";
import ReactDOM from "react-dom/client";
import { ResultWidget } from "./ResultWidget";
// Self-hosted fonts, mirroring src/main.tsx, so the widget's typography
// matches the main window (offline-first — no Google Fonts CDN `@import`).
import "@fontsource-variable/dm-sans";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "../index.css";

// IMPORTANT (WP5.4 hard constraint, same as src/overlay/main.tsx): this file
// must NEVER import ../App, anything from ../store/, or any ../lib module
// with startup side effects (scheduler, taskRunner, mcpAutoConnect, ollama
// init). The result widget only listens for the `quick-result` Tauri event
// emitted by the main window — all real execution happens there. Importing
// those modules here would boot a second scheduler/task runner inside this
// webview and fire every scheduled job twice.
//
// There is no startup race to worry about here either: Tauri creates every
// configured window at launch (even `visible: false` ones) and runs their JS
// immediately, so this listener is registered long before any hotkey press
// could ever result in a `quick-result` emit.

try {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ResultWidget />
    </React.StrictMode>,
  );
} catch (e) {
  // No error-boundary machinery needed for this tiny window — just don't let
  // a render error leave a blank, undismissable widget silently on screen.
  console.error("[quick-result] failed to mount:", e);
}
