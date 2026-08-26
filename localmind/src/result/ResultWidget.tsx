import { useEffect, useRef, useState } from "react";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
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

// ─── Follow-up handoff (WP7.3) ──────────────────────────────────────────────
//
// This widget stays dumb: it never runs the follow-up itself. It just emits
// `quick-followup` with the original Q&A plus whatever the user typed (empty
// string for the "Open in chat →" case) and hands off to App.tsx (the main
// window), which surfaces itself, seeds a new conversation with `prompt` +
// `answer` as history, and — if `followUp` is non-empty — sends it through
// the normal chat pipeline. Mirrors the read-only-widget/does-the-real-work
// split the module header comment already describes for `quick-invoke`.
function emitQuickFollowup(prompt: string, answer: string, followUp: string): void {
  // Own try/catch (via .catch, since emit() is a Promise) rather than letting
  // a rejection propagate — an unhandled rejection in this isolated webview
  // wipes #root via the global handler in main.tsx (see that file), so a
  // permissions hiccup here must never do more than fail to notify the main
  // window.
  emit("quick-followup", { prompt, answer, followUp }).catch((err) =>
    console.error("[quick-followup] emit failed:", err)
  );
}

export function ResultWidget() {
  const [payload, setPayload] = useState<QuickResultPayload | null>(null);
  // Uncontrolled follow-up input — read via ref rather than component state
  // so typing a follow-up doesn't cause a re-render per keystroke, and so the
  // Escape handler (registered once, below) can check "is there typed text?"
  // without needing to be re-subscribed on every keystroke.
  const followUpInputRef = useRef<HTMLInputElement>(null);

  // Dragging the widget. Store the grab position and the window's position at
  // grab-time so subsequent move events can compute the delta and reposition
  // the window without reading back (which would be async).
  const dragRef = useRef<{
    startX: number;
    startY: number;
    windowX: number;
    windowY: number;
  } | null>(null);

  // Registered once on mount; nothing here depends on component state, so the
  // listener is stable for the lifetime of this webview.
  useEffect(() => {
    const unlistenPromise = listen<QuickResultPayload>("quick-result", (event) => {
      setPayload(event.payload);
      // A fresh result (new `running`, or a new `done`/`error` after the
      // previous one) means any text left over from a prior answer's
      // follow-up box is stale — clear it so the next card starts blank.
      if (followUpInputRef.current) followUpInputRef.current.value = "";
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // Escape: if the user has typed a follow-up, clear just that (a stray
  // Escape while composing shouldn't nuke the whole widget and lose what was
  // typed — that's the annoyance this is guarding against). Only hides the
  // widget once the box is already empty, matching the pre-WP7.3 behavior.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== "Escape") return;
      const input = followUpInputRef.current;
      if (input && input.value.length > 0) {
        input.value = "";
        return;
      }
      hide();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Dragging the widget. Grab on mousedown at the header, track moves, and
  // reposition the window. Clean up on mouseup.
  useEffect(() => {
    function onMouseMove(e: MouseEvent): void {
      if (!dragRef.current) return;
      // `windowX/Y` come from `outerPosition()`, which is PHYSICAL pixels, but
      // mouse `clientX/Y` deltas are CSS (logical) pixels — so the delta must
      // be scaled by devicePixelRatio and the result set as a PhysicalPosition.
      // Mixing the two (the previous `new LogicalPosition(physicalOrigin + logicalDelta)`)
      // made the window jump instead of track the cursor on any display that
      // isn't at 100% scale — which is exactly the "undraggable" symptom on a
      // 125%/150%-scaled Windows monitor.
      const dpr = window.devicePixelRatio || 1;
      const deltaX = (e.clientX - dragRef.current.startX) * dpr;
      const deltaY = (e.clientY - dragRef.current.startY) * dpr;
      const newX = Math.round(dragRef.current.windowX + deltaX);
      const newY = Math.round(dragRef.current.windowY + deltaY);
      // core:window:allow-set-position is required in capabilities/result.json
      // — without it this rejects on every single mousemove during a drag.
      // Caught (not left to propagate) purely for symmetry with the
      // outerPosition() try/catch below; this window has no global
      // unhandledrejection handler (see result/main.tsx's header comment), so
      // an uncaught rejection here wouldn't wipe the widget the way it would
      // in the main window — but a drag that silently no-ops on every move is
      // still worth logging once to make a future permissions regression
      // diagnosable instead of just "dragging doesn't work" again.
      void getCurrentWindow()
        .setPosition(new PhysicalPosition(newX, newY))
        .catch((err) => console.error("[quick-result] setPosition failed:", err));
    }
    function onMouseUp(): void {
      dragRef.current = null;
    }
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
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
          borderRadius: "20px",
          background: "var(--card)",
          border: "1px solid rgba(0,0,0,0.05)",
          boxShadow:
            "0 20px 40px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.1)",
        }}
      >
        <div
          className="flex items-center gap-2 px-4 pt-3 pb-2 shrink-0"
          style={{ cursor: dragRef.current ? "grabbing" : "grab" }}
          onMouseDown={async (e) => {
            const target = e.target as HTMLElement;
            if (target.tagName === "BUTTON") return;
            if (dragRef.current) return;
            const win = getCurrentWindow();
            try {
              const pos = await win.outerPosition();
              dragRef.current = {
                startX: e.clientX,
                startY: e.clientY,
                windowX: pos.x,
                windowY: pos.y,
              };
            } catch {
              // window position API unavailable; dragging silently fails
            }
          }}
        >
          <div className="flex-1 min-w-0 truncate text-[11px] text-muted-foreground font-sans">
            {payload.prompt}
          </div>
          <button
            type="button"
            onClick={() => {
              // "Open in chat" hands the conversation over as-is — followUp
              // is deliberately "" so App.tsx seeds the new conversation and
              // stops there (no follow-up message to send).
              emitQuickFollowup(payload.prompt, payload.text, "");
              hide();
            }}
            className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground font-sans whitespace-nowrap"
          >
            Open in chat →
          </button>
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
        {/* shrink-0: pinned to the bottom of the card regardless of how long
            the answer above is — the body's own flex-1/min-h-0/overflow-y-auto
            is what scrolls, so a long answer can never push this row off the
            bottom of the (fixed-size) window. */}
        <div className="shrink-0 px-4 pb-3 pt-1">
          <input
            ref={followUpInputRef}
            type="text"
            placeholder="Ask a follow-up…"
            autoComplete="off"
            spellCheck={false}
            onPointerDown={() => {
              // The result window is created with focus:false and is
              // always-on-top/skipTaskbar — it never picks up keyboard focus
              // just by being visible or by receiving a click from the OS's
              // point of view. Force it explicitly so the very first
              // keystroke after clicking actually lands in this input rather
              // than at whatever app the user's focus was last in.
              // core:window:allow-set-focus is already granted in
              // capabilities/result.json.
              getCurrentWindow()
                .setFocus()
                .catch((err) => console.error("[quick-followup] setFocus failed:", err));
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const value = e.currentTarget.value.trim();
              if (!value) return;
              emitQuickFollowup(payload.prompt, payload.text, value);
              hide();
            }}
            className="w-full text-[12px] font-sans px-3 py-2 rounded-full outline-none text-foreground placeholder:text-muted-foreground"
            style={{
              background: "var(--muted)",
              border: "1px solid rgba(0,0,0,0.08)",
            }}
          />
        </div>
      </div>
    </div>
  );
}
