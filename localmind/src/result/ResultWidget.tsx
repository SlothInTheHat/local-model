import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Markdown } from "../components/Markdown";

// NOTE: no `cn()` import, despite it being the house style — every className
// here is a static string, so cn() would merge nothing. Keep this file's
// import graph down to React + @tauri-apps/api (+ the shared Markdown
// component, which is itself constrained to the same import graph — see its
// own header comment); nothing from ../store or a side-effectful ../lib
// module may ever appear here (see main.tsx for why). Where a conditional
// class is needed (see the destructive-vs-foreground text color below),
// inline a ternary rather than reaching back into ../components.

// ─── Quick-invoke result widget (WP5.4) ────────────────────────────────────
//
// A read-only, bottom-right-docked, always-on-top window that reports the
// outcome of a quick-invoke "widget" run without ever surfacing the main
// window or stealing focus. It is a THIRD window (not a repurposed overlay)
// specifically because it must survive losing focus — the overlay hides on
// blur, and a widget that vanished the moment you clicked back into your
// editor would defeat the entire point.
//
// It does NOT run any agent logic itself: App.tsx (the main window) does the
// actual headless run via runHeadlessTask and reports progress/results here
// purely by emitting the `quick-result` Tauri event. There is no handshake to
// worry about — Tauri creates every configured window (even visible:false
// ones) at launch and runs their JS immediately, so this listener is already
// registered long before any hotkey press could trigger a run.

type QuickResultPayload =
  | { status: "running"; prompt: string }
  | { status: "done"; prompt: string; text: string }
  | { status: "error"; prompt: string; text: string };

function hide(): void {
  // Needs core:window:allow-hide in capabilities/result.json — core:default
  // does not grant it, and without it Escape/the close button would silently
  // leave the widget stuck on screen. Log rather than reject so the failure
  // is diagnosable.
  getCurrentWindow()
    .hide()
    .catch((err) => console.error("[quick-result] hide failed:", err));
}

export function ResultWidget() {
  const [payload, setPayload] = useState<QuickResultPayload | null>(null);

  // Registered once on mount; nothing here depends on component state, so the
  // listener is stable for the lifetime of this webview.
  useEffect(() => {
    const unlistenPromise = listen<QuickResultPayload>("quick-result", (event) => {
      setPayload(event.payload);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // Escape dismisses. Deliberately no onFocusChanged/hide-on-blur here (unlike
  // the overlay) — the whole reason this is a separate window is that it must
  // keep showing while the user works in another app.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") hide();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Nothing has arrived yet — stay blank. The window itself is only ever made
  // visible by Rust's show_result_widget, so this just covers the instant
  // between window creation and the first event.
  if (!payload) return null;

  // Running: the window has already been shrunk to the compact loading-pill
  // size by Rust (see show_result_widget's `compact` param) before this event
  // arrives, so this only ever needs to fill that small window — no prompt
  // text, no elapsed counter, no close button (per spec: nowhere for any of
  // that to live in a 168x60 pill anyway).
  if (payload.status === "running") {
    return (
      <div className="w-screen h-screen p-3" style={{ background: "transparent" }}>
        <div
          className="flex items-center justify-center w-full h-full"
          style={{
            borderRadius: "9999px",
            background: "#0A0A0A",
            boxShadow: "0 2px 16px rgba(0,0,0,0.18)",
          }}
        >
          <div className="flex gap-[3px] items-center">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="block w-1 h-1 rounded-full bg-white"
                style={{ animation: "ndot 1.4s ease-in-out infinite", animationDelay: `${i * 0.18}s` }}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Done / error: the full result card. Rust has already grown the window
  // back to the full size (see show_result_widget's `compact: false` call in
  // App.tsx) before this event arrives.
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
        <div className="flex items-center gap-2 px-4 pt-3 pb-2 shrink-0">
          <div className="flex-1 min-w-0 truncate text-[11px] text-muted-foreground font-sans">
            {payload.prompt}
          </div>
          <button
            type="button"
            onClick={hide}
            aria-label="Close"
            className="shrink-0 w-5 h-5 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 text-sm font-sans">
          {/* Wide children (long code fences, display-mode KaTeX) must scroll
              horizontally within this fixed 420px-wide widget instead of
              stretching the card or getting clipped — neither element gets
              that for free (KaTeX's own CSS sets .katex-display's inner
              .katex to white-space:nowrap with no overflow rule, and plain
              <pre> has none either), so it's added here via arbitrary
              variants rather than the `prose` typography plugin (which would
              also change fonts/spacing for this compact widget). */}
          <div
            className={
              (payload.status === "error" ? "text-destructive" : "text-foreground") +
              " [&_pre]:overflow-x-auto [&_.katex-display]:overflow-x-auto" +
              // Tailwind's preflight strips list markers and heading sizes, and
              // skipping `prose` (see above) means nothing puts them back. A
              // worked math answer is almost always numbered steps, so without
              // this an ordered list renders as an undifferentiated wall of
              // text. Minimal rules only — deliberately not reintroducing
              // prose's fonts/margins, which are wrong at this width.
              " [&_ol]:list-decimal [&_ul]:list-disc [&_ol]:pl-5 [&_ul]:pl-5 [&_li]:my-0.5" +
              " [&_h1]:font-medium [&_h2]:font-medium [&_h3]:font-medium [&_h1]:mt-2 [&_h2]:mt-2 [&_h3]:mt-2" +
              " [&_p]:my-1.5 [&_code]:font-mono [&_code]:text-[0.9em]"
            }
          >
            <Markdown>{payload.text}</Markdown>
          </div>
        </div>
      </div>
    </div>
  );
}
