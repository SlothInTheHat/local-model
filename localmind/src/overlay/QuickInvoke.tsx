import { useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

// NOTE: no `cn()` import, despite it being the house style — every className
// here is a static string, so cn() would merge nothing. Keep this file's
// import graph down to React + @tauri-apps/api; nothing from ../store or
// ../lib may ever appear here (see main.tsx for why). If a conditional class
// is ever needed, inline a ternary rather than reaching back into
// ../components.
//
// Known, non-blocking: the built overlay entry still modulepreloads the main
// app's shared chunks (vendor-math/vendor-radix, ~700KB) because Rollup routes
// React and the @tauri-apps/api helpers through them. It is dead weight, not
// dead behavior — no store/scheduler code executes here. Fixing it means
// restructuring manualChunks in vite.config.ts, which was tried and did not
// work by simply splitting React out.

// ─── Quick-invoke overlay (WP5.3) ──────────────────────────────────────────
//
// A dumb input box: it only collects one line of text and either mode
// ("chat" | "widget"), then hands off to the main window via the
// `quick-invoke` Tauri event. It does NOT run any agent logic itself — see
// the HARD CONSTRAINT note in src/overlay/main.tsx for why.

type Mode = "chat" | "widget";

async function submit(prompt: string, mode: Mode): Promise<void> {
  const trimmed = prompt.trim();
  if (!trimmed) return;
  await emit("quick-invoke", { prompt: trimmed, mode });
}

export function QuickInvoke() {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function hide(): void {
    // Needs core:window:allow-hide in capabilities/overlay.json — core:default
    // does not grant it, and without it Escape/blur silently leave the overlay
    // stuck on screen. Log rather than reject so the failure is diagnosable.
    getCurrentWindow()
      .hide()
      .catch((err) => console.error("[quick-invoke] hide failed:", err));
  }

  // Focus on mount.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Hide on blur; re-focus the input whenever the window becomes visible
  // again. Registered once — the unlisten function is returned for cleanup.
  useEffect(() => {
    const unlistenPromise = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) {
        inputRef.current?.focus();
      } else {
        hide();
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Escape") {
      setText("");
      hide();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // Plain Enter now runs in the background and reports via the result
      // widget (WP5.4) — the whole point of quick-invoke is to not get
      // yanked out of whatever app you're currently in. Ctrl/Cmd+Enter is
      // the escape hatch for when you actually want the full chat window.
      const mode: Mode = e.ctrlKey || e.metaKey ? "chat" : "widget";
      const trimmed = text.trim();
      if (!trimmed) {
        hide();
        return;
      }
      // Hide in `finally`, not `then`: if the emit ever rejects, an overlay
      // that stays on screen with no feedback and an unhandled rejection is
      // strictly worse than one that dismisses. The main window is the only
      // thing that can report the failure, and it isn't listening yet.
      void submit(text, mode)
        .catch((err) => console.error("[quick-invoke] emit failed:", err))
        .finally(() => {
          setText("");
          hide();
        });
    }
  }

  return (
    <div className="w-screen h-screen p-3" style={{ background: "transparent" }}>
      <div
        className="flex flex-col w-full h-full overflow-hidden"
        style={{
          borderRadius: "26px",
          background: "var(--card)",
          border: "1px solid rgba(0,0,0,0.09)",
          boxShadow: "0 8px 60px rgba(0,0,0,0.1), 0 2px 8px rgba(0,0,0,0.05)",
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask LocalMind…"
          autoFocus
          className="flex-1 min-h-0 w-full px-5 pt-4 pb-2 bg-transparent border-0 outline-none text-foreground text-base font-sans placeholder:text-muted-foreground"
        />
        <div className="px-5 pb-3 text-[11px] text-muted-foreground font-sans shrink-0">
          Enter — run in background &nbsp;·&nbsp; Ctrl+Enter — open in chat &nbsp;·&nbsp; Esc — dismiss
        </div>
      </div>
    </div>
  );
}
