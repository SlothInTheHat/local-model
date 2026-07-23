import { useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Mic, Loader2, Pencil } from "lucide-react";
// src/lib/dictation.ts is the ONE exception to the "nothing from ../lib" rule
// below (WP7.2). It was audited before importing: no module-level state, no
// side effects, no imports of its own beyond browser globals (MediaRecorder,
// navigator.mediaDevices) — it just wraps mic-capture mechanics and a single
// window.__TAURI__.core.invoke call. Nothing here boots a second
// scheduler/taskRunner the way ../store or a stateful ../lib module would.
import { isDictationSupported, startDictation, cancelDictation, type DictationSession } from "../lib/dictation";

// NOTE: no `cn()` import, despite it being the house style — every className
// here is a static string, so cn() would merge nothing. Keep this file's
// import graph down to React + @tauri-apps/api (+ the audited dictation.ts
// exception above); nothing from ../store or any side-effectful ../lib
// module may ever appear here (see main.tsx for why). If a conditional class
// is ever needed, inline a ternary rather than reaching back into
// ../components.
//
// Known, non-blocking: the built overlay entry still modulepreloads the main
// app's shared chunks (vendor-math/vendor-radix, ~700KB) because Rollup routes
// React and the @tauri-apps/api helpers through them. It is dead weight, not
// dead behavior — no store/scheduler code executes here. Fixing it means
// restructuring manualChunks in vite.config.ts, which was tried and did not
// work by simply splitting React out.

// ─── Quick-invoke overlay (WP5.3; WP7.1 reworked into a fullscreen HUD) ────
//
// A dumb input box PLUS a fullscreen drawing canvas: it collects one line of
// text, a mode ("chat" | "widget"), and whatever ink the user has drawn on
// the screen, then hands off to the main window via the `quick-invoke` Tauri
// event. It does NOT run any agent logic itself — see the HARD CONSTRAINT
// note in src/overlay/main.tsx for why.
//
// WP7.1 REWORK: this used to hand drawing off to a SEPARATE fullscreen
// `annotate` window (Ctrl+R to enter, ~450ms idle auto-capture). That design
// had two fatal problems: (1) the annotate canvas's backing store was sized
// exactly once, on mount — but Tauri creates every configured window at
// launch, hidden at a small placeholder size, only resized to the full
// monitor right before being shown. A mount-time measurement read the
// placeholder's dimensions, so every stroke landed outside the real buffer
// and the ink literally never rendered. (2) Two windows means one OS focus
// at a time, so you could never dictate into this window's mic while
// drawing in the other — exactly backwards from the actual use case (circle
// something on screen WHILE still talking about it). The fix: draw directly
// on THIS window. It's now a fullscreen, transparent, always-on-top HUD —
// the prompt card floats over a full-screen canvas, both sharing the same
// focus, so voice and drawing work at once. Capture happens once, at submit
// time, instead of on an idle timer — see submitWithRegion below.

type Mode = "chat" | "widget";

type Point = { x: number; y: number; t: number };
type Stroke = Point[];

/** Ink is drawn fully opaque and never fades. Earlier revisions faded it —
 *  first to zero (which, combined with the old annotate window's sizing bug,
 *  made the feature look completely dead), then to a 0.45 floor. Both were
 *  wrong: the mark is a precise selection the user is still looking at while
 *  they finish speaking, so it must stay exactly as drawn until they submit
 *  or clear it. `Point.t` is kept only because the bounding-box math and
 *  stroke bookkeeping already carry it; nothing reads it for rendering. */
const STROKE_RGB = "255, 106, 61";
/** Thin, crisp pen. A thick stroke with a glow reads as decoration and makes
 *  it genuinely hard to tell exactly what you enclosed — and since the mark
 *  defines a crop rectangle, "exactly what you enclosed" is the whole point.
 *  No shadow for the same reason: a blur would fringe the line and blunt it. */
const LINE_WIDTH_CSS_PX = 4;

/** The circular pen/mic buttons' resting fill. Matches the near-black used by
 *  the result widget's loading pill (src/result/ResultWidget.tsx) rather than
 *  `var(--foreground)`, which inverts to near-white under a dark theme and
 *  would turn these into white discs on a light card. */
const BUTTON_DARK = "#0A0A0A";

/** Minimum region buffer, in CSS px, added around the drawn bounding box —
 *  the freehand loop is a hint, not a precise crop, so the actual capture
 *  is padded outward by max(28px, 8% of the box's larger dimension). */
const MIN_BUFFER_PX = 28;
const BUFFER_FRACTION = 0.08;

/** WP7.2 dictation: `useSettingsStore` is a Zustand persist store and cannot
 *  be imported here (see the HARD CONSTRAINT above). Zustand's `persist`
 *  middleware serializes the whole store under `{ state: {...}, version }`
 *  at the key given to `persist(..., { name })` in src/store/settings.ts —
 *  that name is "localmind-settings" and the field is `whisperModel`
 *  ("tiny" | "base" | "small" | "medium"). Read it directly out of
 *  localStorage instead, parsing defensively: any failure (key missing,
 *  corrupt JSON, unexpected shape, running outside a browser context) falls
 *  back to `undefined`, which `dictation.ts`'s `stop()` already treats as
 *  "use the default model" — same contract ChatInput relies on when the
 *  store hasn't hydrated yet. */
function readWhisperModelSetting(): string | undefined {
  try {
    const raw = localStorage.getItem("localmind-settings");
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { state?: { whisperModel?: unknown } };
    const model = parsed?.state?.whisperModel;
    return typeof model === "string" ? model : undefined;
  } catch (e) {
    console.error("[quick-invoke] failed to read whisper model setting:", e);
    return undefined;
  }
}

/** Same defensive localStorage read as readWhisperModelSetting, for the
 *  "Dictation engine" setting — "browser" routes the mic through the Web
 *  Speech API (real-time), anything else (or any read failure) uses the local
 *  whisper pipeline. */
function readDictationEngineSetting(): "whisper" | "browser" {
  try {
    const raw = localStorage.getItem("localmind-settings");
    if (!raw) return "whisper";
    const parsed = JSON.parse(raw) as { state?: { dictationEngine?: unknown } };
    return parsed?.state?.dictationEngine === "browser" ? "browser" : "whisper";
  } catch {
    return "whisper";
  }
}

export function QuickInvoke() {
  const [text, setText] = useState("");
  // True once the current session has at least one drawn point — drives the
  // status row (chip vs. muted hint) below. The stroke DATA itself lives in
  // strokesRef, not state: re-rendering on every pointermove would be both
  // pointless (the canvas repaints itself via the RAF loop, not React) and
  // slow.
  const [hasInk, setHasInk] = useState(false);
  const [regionError, setRegionError] = useState<string | null>(null);
  // Dictation (WP7.2) state machine — mirrors ChatInput.tsx's
  // idle/recording/transcribing exactly, minus the Web Speech browser-dev
  // fallback (the overlay only ever runs inside Tauri).
  const [micState, setMicState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [micError, setMicError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dictationSessionRef = useRef<DictationSession | null>(null);
  // Web Speech recognizer, when the "Browser speech" dictation engine is on.
  const recognitionRef = useRef<{ stop: () => void } | null>(null);

  // Every point of every stroke drawn this session. Padded/clamped/DPR-scaled
  // into a capture rect at SUBMIT time (see submitWithRegion below) — there
  // is no idle-commit timer anymore (WP7.1 rework): capture only ever
  // happens once, right before the prompt is handed off.
  const strokesRef = useRef<Stroke[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  // Drawing is armed by the Draw button and off by default, so the overlay
  // opens ready to type (its actual primary use) rather than ready to draw.
  const [drawMode, setDrawMode] = useState(false);
  /** Last backing-store size the render loop REQUESTED — see the resize
   *  reconciliation in the render loop for why this tracks the request rather
   *  than reading canvas.width back. */
  const appliedCanvasSizeRef = useRef<{ w: number; h: number } | null>(null);

  // Pause/resume flag for the render loop. Set to false when the window is
  // hidden to save battery (no point rendering 60 FPS offscreen). The loop
  // checks this at the start of each frame.
  const renderActiveRef = useRef(true);

  // Dragging the input bar itself. This window is a FULLSCREEN transparent HUD
  // covering the whole monitor, so moving the *window* would just shift the
  // whole overlay partly off-screen — pointless, and why the bar felt
  // "undraggable". Instead we move the BAR within the window via a CSS offset
  // (barOffset), applied on top of its centered resting position. dragRef holds
  // the grab point plus the offset at grab-time so each move computes a delta.
  const [barOffset, setBarOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  // Guards against a second Enter (key repeat, or a stray keydown while the
  // first submit's awaits are still in flight) re-running the whole
  // hide/capture/emit sequence a second time.
  const submittingRef = useRef(false);

  // Same guard pattern used throughout this file, for the same reason: a mic
  // permission prompt (or simply clicking the mic button) can move OS focus
  // away from this window, which would otherwise trip onFocusChanged(false)
  // and hide() the overlay mid-recording — leaving the session's mic tracks
  // open with no UI left to stop them. Tracks the whole recording +
  // transcribing lifetime via the effect below, since either phase can
  // outlive a single blur/focus pair.
  const dictationActiveRef = useRef(false);
  useEffect(() => {
    dictationActiveRef.current = micState !== "idle";
  }, [micState]);

  // If this window is ever destroyed (not just hidden) while a session is
  // open, release the mic rather than leaving it hot with nothing left to
  // stop it — mirrors the same cleanup in ChatInput.tsx.
  useEffect(() => {
    return () => {
      cancelDictation(dictationSessionRef.current);
      dictationSessionRef.current = null;
      recognitionRef.current?.stop();
      recognitionRef.current = null;
    };
  }, []);

  function hide(): void {
    // Needs core:window:allow-hide in capabilities/overlay.json — core:default
    // does not grant it, and without it Escape/blur silently leave the overlay
    // stuck on screen. Log rather than reject so the failure is diagnosable.
    getCurrentWindow()
      .hide()
      .catch((err) => console.error("[quick-invoke] hide failed:", err));
  }

  /** Wipe every drawn stroke and reset the status-row state. Called on
   *  right-click, on submit/dismiss, and whenever the window regains focus
   *  (see the onFocusChanged effect below) — a fresh invocation must never
   *  inherit the previous session's ink. */
  function clearStrokes(): void {
    strokesRef.current = [];
    setHasInk(false);
  }

  /** Same as clearStrokes, plus telling Rust to drop any PENDING_REGION
   *  stash. Used by the two paths that are a deliberate "no, I don't want
   *  this region after all" (the ✕ chip and Escape while ink exists) — as
   *  opposed to right-click/focus-regain, which are just resetting stale UI
   *  state rather than actively cancelling something the user asked for.
   *  clear_pending_region is a no-op if nothing is stashed. */
  function clearStrokesAndPendingRegion(): void {
    clearStrokes();
    invoke("clear_pending_region").catch((err) =>
      console.error("[quick-invoke] clear_pending_region failed:", err)
    );
  }

  /** A prompt round has ended (submitted or dismissed) — clear the typed
   *  text AND any drawn ink, since both belong to the prompt that just
   *  ended, not whatever the user does next time the overlay opens. */
  function resetForNextPrompt(): void {
    setText("");
    clearStrokes();
    setRegionError(null);
    // Belt-and-suspenders (WP7.2): if a dictation session is somehow still
    // open when a prompt round ends (e.g. plain Enter submitted while the
    // recording state hadn't caught up with a fresh keystroke), release the
    // mic immediately instead of leaving it hot until the session object is
    // garbage-collected. cancelDictation is a no-op safe to call on null/
    // already-stopped sessions.
    cancelDictation(dictationSessionRef.current);
    dictationSessionRef.current = null;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setMicState("idle");
    setMicError(null);
    setDrawMode(false);
  }

  // Dragging the bar. Grab on mousedown at the top of the input bar, track
  // moves, and reposition the window. Clean up on mouseup or if the window
  // loses focus.
  useEffect(() => {
    function onMouseMove(e: MouseEvent): void {
      if (!dragRef.current) return;
      // Move the bar within the fullscreen window (client-px delta added to the
      // grab-time offset), not the window itself — see dragRef's doc comment.
      const deltaX = e.clientX - dragRef.current.startX;
      const deltaY = e.clientY - dragRef.current.startY;
      setBarOffset({ x: dragRef.current.offsetX + deltaX, y: dragRef.current.offsetY + deltaY });
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

  // Escape always dismisses, from anywhere.
  //
  // This is a WINDOW-level listener rather than the input's onKeyDown because
  // the input is not reliably what has focus: arming Draw, clicking the mic,
  // or drawing on the canvas all move focus off it, and Escape silently doing
  // nothing in those states is worse than useless for a fullscreen
  // always-on-top window covering the user's whole screen — it is the only way
  // out.
  //
  // Deliberately NOT a ladder (an earlier revision made the first Escape
  // cancel dictation, the second clear ink, and only the third dismiss).
  // Escape means "get this off my screen"; the ✕ affordances cover the
  // narrower "just drop the ink" case. resetForNextPrompt() releases the mic
  // on the way out, so dismissing mid-recording can't leave it hot.
  useEffect(() => {
    function onWindowKeyDown(e: KeyboardEvent): void {
      if (e.key !== "Escape") return;
      e.preventDefault();
      resetForNextPrompt();
      invoke("clear_pending_region").catch((err) =>
        console.error("[quick-invoke] clear_pending_region failed:", err)
      );
      hide();
    }
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** idle -> recording -> transcribing -> idle, mirroring ChatInput's
   *  toggleTauriDictation exactly (this overlay only ever runs inside Tauri,
   *  so there's no Web Speech fallback branch to carry over). Every await is
   *  inside its own try/catch — an unhandled rejection here must never
   *  escape, since this window has no error-boundary machinery worth
   *  disturbing over a failed mic click. */
  async function toggleDictation(): Promise<void> {
    if (micState === "transcribing") return; // ignore clicks/Ctrl+M mid-transcription

    // "Browser speech" engine: stream words in real time via the Web Speech
    // API instead of the record-then-transcribe whisper path.
    if (readDictationEngineSetting() === "browser") {
      toggleWebSpeechDictation();
      return;
    }

    if (micState === "recording") {
      await stopDictationAndInsert();
      return;
    }

    // idle -> start recording
    setMicError(null);
    if (!isDictationSupported()) {
      setMicError("Microphone capture isn't supported in this build.");
      return;
    }
    try {
      const session = await startDictation();
      dictationSessionRef.current = session;
      setMicState("recording");
    } catch (e) {
      // The single biggest unknown in this WP: it is not known whether
      // WebView2 even shows a permission prompt in this transparent,
      // decorationless, always-on-top window, or silently denies. Either way
      // this catch is what keeps that unknown from becoming an unhandled
      // rejection that wipes the overlay.
      console.error("[quick-invoke] startDictation failed:", e);
      setMicError(
        "Microphone unavailable — try the mic button in the main LocalMind window once to grant access."
      );
      setMicState("idle");
    }
  }

  async function stopDictationAndInsert(): Promise<void> {
    const session = dictationSessionRef.current;
    dictationSessionRef.current = null;
    if (!session) {
      setMicState("idle");
      return;
    }
    setMicState("transcribing");
    try {
      const whisperModel = readWhisperModelSetting();
      const transcript = await session.stop(whisperModel);
      if (transcript) {
        // Append to whatever's already typed, space-separated — never
        // clobber text the user already entered before starting dictation.
        setText((prev) => (prev.trim() ? `${prev.trim()} ${transcript}` : transcript));
        requestAnimationFrame(() => {
          const el = inputRef.current;
          if (el) {
            el.focus();
            el.selectionStart = el.selectionEnd = el.value.length;
          }
        });
      } else {
        setMicError("No speech detected — try again and speak closer to the mic.");
      }
    } catch (e) {
      console.error("[quick-invoke] dictation stop/transcribe failed:", e);
      setMicError(`Transcription failed: ${(e as Error)?.message ?? "unknown error"}`);
    } finally {
      setMicState("idle");
    }
  }

  /** "Browser speech" engine (see readDictationEngineSetting): streams interim
   *  results into the input as the user speaks, appended to whatever's already
   *  typed. Click/Ctrl+M again to stop; text stays in the box. No SpeechRecognition
   *  on this platform → a one-line error and no-op (Whisper stays the default). */
  function toggleWebSpeechDictation(): void {
    if (micState === "recording") {
      recognitionRef.current?.stop();
      return; // state cleared in onend
    }
    setMicError(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SR) {
      setMicError("Real-time dictation isn't available here — set Dictation engine to Whisper in Settings.");
      return;
    }
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    const baseText = text.trim();
    let finalChunk = "";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalChunk += r[0].transcript;
        else interim += r[0].transcript;
      }
      const spoken = (finalChunk + interim).trim();
      setText([baseText, spoken].filter(Boolean).join(" "));
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onerror = (e: any) => {
      setMicState("idle");
      if (e?.error === "not-allowed" || e?.error === "service-not-allowed") {
        setMicError("Microphone access was denied for browser dictation.");
      } else if (e?.error && e.error !== "aborted" && e.error !== "no-speech") {
        setMicError(`Browser dictation error: ${e.error}`);
      }
    };
    rec.onend = () => setMicState("idle");
    try {
      rec.start();
    } catch {
      setMicState("idle");
      return;
    }
    recognitionRef.current = rec;
    setMicState("recording");
  }

  // (An earlier `cancelDictationOnEscape` lived here, for an Escape ladder
  // whose first press only cancelled the mic. Escape now always dismisses —
  // see the window-level listener above — and resetForNextPrompt releases the
  // mic on that path, so the separate helper had no callers left.)

  // Focus on mount.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // ─── Canvas sizing (THE bug fix this rework exists for) ───────────────────
  //
  // Tauri creates every configured window at launch, including this one —
  // and it's created hidden at a small placeholder size (see the `overlay`
  // window config in tauri.conf.json), only resized to the full monitor by
  // Rust's toggle_overlay right before it's shown (src-tauri/src/tray.rs). A
  // canvas-sizing effect that runs ONCE on mount would read THAT
  // placeholder's dimensions — window.innerWidth/innerHeight at mount time,
  // before Rust's resize has happened — and every stroke afterward would
  // land outside the real backing store and silently never render. This is
  // exactly what made the old two-window `annotate` design's ink invisible
  // (see the file-level comment above). Calling sizeCanvas() again on every
  // show (via onFocusChanged below) is what actually fixes it — the
  // mount-time call and the resize listener just keep it correct across
  // whatever else can change the viewport afterward.
  function sizeCanvas(): void {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    // Measure the CANVAS's own box, not window.innerWidth/innerHeight. Those
    // two are usually equal here (the canvas is inset-0 on a full-viewport
    // root) — but "usually" is what made the ink land down and to the right of
    // the cursor: any discrepancy between the assumed viewport size and the
    // element's real CSS size scales the bitmap when the browser fits it to
    // the element, so the error grows the further you draw from the origin.
    // Sizing the backing store from the same rect the pointer coordinates are
    // translated by (see the render loop) makes the mapping self-consistent by
    // construction, whatever the element's size or position turns out to be.
    const rect = canvas.getBoundingClientRect();
    // Setting .width/.height (not just CSS size) reallocates the backing
    // store AND resets its transform to identity — that reset is exactly why
    // the line below must be an absolute setTransform, not a cumulative
    // ctx.scale() (a second show would otherwise double-apply the dpr scale).
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  useEffect(() => {
    sizeCanvas();
    window.addEventListener("resize", sizeCanvas);
    return () => window.removeEventListener("resize", sizeCanvas);
  }, []);

  // Hide on blur; re-focus the input and re-size/clear the canvas whenever
  // the window becomes visible again. Registered once — the unlisten
  // function is returned for cleanup.
  useEffect(() => {
    const unlistenPromise = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) {
        // Rust just resized this window to the current monitor's full bounds
        // (toggle_overlay in tray.rs) before showing it — re-measure now, not
        // just on mount, or a second invocation on a different monitor (or
        // after a resolution change) silently breaks drawing again. See
        // sizeCanvas's doc comment above.
        sizeCanvas();
        // ...and again after a frame. The focus event can arrive before the
        // webview has laid out at the new window size, in which case the
        // measurement above is of the OLD box — which is precisely how ink
        // ends up offset from the cursor. Re-measuring once layout has
        // settled costs nothing and makes the common case self-correcting.
        requestAnimationFrame(sizeCanvas);
        // A fresh invocation must never inherit the previous session's ink,
        // and always opens ready to TYPE rather than ready to draw.
        clearStrokes();
        setDrawMode(false);
        // Re-center the bar each time the overlay opens, so a spot the user
        // dragged it to last time doesn't carry over to the next invocation.
        setBarOffset({ x: 0, y: 0 });
        inputRef.current?.focus();
        // Resume the render loop (see below for pause logic).
        renderActiveRef.current = true;
      } else if (!dictationActiveRef.current) {
        // Pause the render loop to save battery when the window is hidden.
        // The canvas is offscreen, so there's no point rendering 60 FPS to
        // nothing. The loop keeps scheduling itself but skips all drawing, so
        // resume is instant when the window is shown again.
        renderActiveRef.current = false;
        hide();
      }
      // else: losing focus because a mic session is live (see
      // dictationActiveRef's doc comment above) — a WebView2 permission
      // prompt or the mic button click itself can move focus without the
      // user meaning to dismiss the overlay.
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // ─── Render loop: fading ink ────────────────────────────────────────────
  //
  // Redraws every frame (not just on pointer events) so the fade animates
  // continuously even while the pointer is idle — the user is meant to keep
  // talking/looking at what they circled while this runs.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    function draw(): void {
      // If the window is hidden, skip rendering to save battery. The loop
      // continues scheduling itself, but does no work, so resume is instant
      // when the window becomes visible again.
      if (!renderActiveRef.current) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      // Points are stored in VIEWPORT (client) coordinates — that's the space
      // the capture rectangle is ultimately computed in — so drawing
      // translates by the canvas's own rect. Measured fresh every frame: it is
      // the single source of truth for where the drawing surface actually is.
      const rect = canvas!.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      // RECONCILE THE BACKING STORE WITH THE CSS BOX, EVERY FRAME.
      //
      // This is the fix for "the ink is offset from the cursor, and the error
      // shrinks toward the top-left" — the signature of a bitmap being
      // stretched to fit its element. If canvas.width doesn't match
      // rect.width * dpr, the browser scales the bitmap into the element and
      // every drawn point lands at the wrong place by a factor, not an offset.
      //
      // Earlier revisions sized the canvas from events — mount, `resize`,
      // window-focus, plus a requestAnimationFrame chaser. All of them still
      // lost the race: this window is created as a small hidden placeholder
      // and Rust resizes it to full-monitor bounds at show time, and no
      // combination of those events reliably fired AFTER the webview had laid
      // out at the new size. Checking here removes the timing question
      // entirely — whatever size the element turns out to be, the very next
      // frame matches it. A cheap integer compare per frame buys a class of
      // bug that took three attempts to not fix.
      // Clamped to the viewport as defence in depth. The canvas is pinned to
      // 100% of a full-viewport parent (see its inline style below), so
      // rect.* can't exceed the viewport by construction — but this loop
      // WRITES the size it derives from a measurement, and a measure→write
      // cycle that can ever feed itself is one CSS rule away from running
      // away. Ceiling it at the viewport means the worst case is slightly
      // wrong ink, never a 33-million-pixel bitmap.
      const maxW = Math.round(window.innerWidth * dpr);
      const maxH = Math.round(window.innerHeight * dpr);
      const wantW = Math.min(Math.round(rect.width * dpr), maxW);
      const wantH = Math.min(Math.round(rect.height * dpr), maxH);
      // Bail on a degenerate box (window mid-resize, or hidden) rather than
      // assigning a 0-size backing store and drawing into nothing.
      if (wantW <= 0 || wantH <= 0) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }
      // Compare against the last size we ASKED for, not against canvas.width.
      // If the browser ever clamps the assignment (over a max dimension/area
      // limit), canvas.width comes back different from what we set — and
      // comparing against it would then mismatch on every single frame,
      // reallocating a full-screen bitmap 60x/second. That thrash is the most
      // likely cause of the compositor dropping this window's transparency and
      // flashing the page white. Tracking the requested size means we try each
      // target exactly once.
      const applied = appliedCanvasSizeRef.current;
      if (!applied || applied.w !== wantW || applied.h !== wantH) {
        appliedCanvasSizeRef.current = { w: wantW, h: wantH };
        canvas!.width = wantW;
        canvas!.height = wantH;
      }

      // Set the transform explicitly every frame rather than relying on it
      // surviving from wherever it was last set. Assigning canvas.width above
      // resets it to identity, so it has to be re-established here anyway, and
      // an absolute setTransform can never compound the way a cumulative
      // ctx.scale() would.
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      // clearRect is in the CSS-pixel space the transform just established, so
      // it covers the element's box — not the device-pixel backing store.
      ctx!.clearRect(0, 0, rect.width, rect.height);

      ctx!.lineCap = "round";
      ctx!.lineJoin = "round";
      ctx!.lineWidth = LINE_WIDTH_CSS_PX;
      ctx!.strokeStyle = `rgb(${STROKE_RGB})`;

      for (const stroke of strokesRef.current) {
        if (stroke.length === 1) {
          // A click with no drag still deserves a visible dot — a zero-length
          // path draws nothing at all, so render the single point explicitly.
          ctx!.beginPath();
          ctx!.arc(
            stroke[0].x - rect.left,
            stroke[0].y - rect.top,
            LINE_WIDTH_CSS_PX / 2,
            0,
            Math.PI * 2,
          );
          ctx!.fillStyle = `rgb(${STROKE_RGB})`;
          ctx!.fill();
          continue;
        }
        ctx!.beginPath();
        ctx!.moveTo(stroke[0].x - rect.left, stroke[0].y - rect.top);
        for (let i = 1; i < stroke.length; i++) {
          ctx!.lineTo(stroke[i].x - rect.left, stroke[i].y - rect.top);
        }
        // One path per stroke rather than one per segment: segment-by-segment
        // stroking double-draws every joint, which at full opacity shows up as
        // visible blobs along the line.
        ctx!.stroke();
      }

      rafRef.current = requestAnimationFrame(draw);
    }

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);


  // ─── Drawing input ─────────────────────────────────────────────────────
  //
  // Handlers live on the ROOT div, not the canvas — the canvas is purely a
  // rendering surface. This is why the prompt card needs its own
  // onPointerDown={stopPropagation}: a pointerdown that lands on the card
  // (which sits visually on top of the canvas) still bubbles up to these
  // root handlers unless the card stops it, which would otherwise start a
  // new stroke "under" the card. Once a stroke IS in progress from the
  // canvas area, setPointerCapture below keeps subsequent move/up events
  // targeted at the root regardless of the pointer wandering over the card,
  // so only pointerdown needs the guard.
  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    // Drawing is explicitly armed via the Draw button, never ambient. With an
    // always-live canvas, every stray click anywhere on the screen left a mark
    // — and since the marks define the crop, a stray click silently widened
    // the captured region.
    if (!drawMode) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    strokesRef.current.push([{ x: e.clientX, y: e.clientY, t: performance.now() }]);
    setHasInk(true);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    if (!drawMode) return;
    if (e.buttons === 0) return; // not actively drawing
    const strokes = strokesRef.current;
    const current = strokes[strokes.length - 1];
    if (!current) return;
    current.push({ x: e.clientX, y: e.clientY, t: performance.now() });
  }

  /** Right-click abandons the current ink without touching any stashed
   *  region — there is nothing stashed yet at this point in the flow
   *  (capture only happens at submit time), so unlike the ✕ chip / Escape
   *  branch this only needs to clear local drawing state. */
  function handleContextMenu(e: React.MouseEvent<HTMLDivElement>): void {
    e.preventDefault();
    // Drops the stashed region too, not just the local ink. Right-click is now
    // the ONLY "undo my selection" affordance — the ✕ chip that used to do
    // this went away with the status row when the UI collapsed to a single
    // bar — so it has to clear both halves of the state or a discarded region
    // could still answer the next question.
    clearStrokesAndPendingRegion();
  }

  /** Compute the bbox of everything drawn this session, pad/clamp/DPR-scale
   *  it, hide the window, capture the region, and only THEN emit
   *  `quick-invoke` — see the ordering comment inline below. */
  async function submitWithRegion(prompt: string, mode: Mode): Promise<void> {
    const allPoints = strokesRef.current.flat();

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of allPoints) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }

    const boxWidth = maxX - minX;
    const boxHeight = maxY - minY;
    const buffer = Math.max(MIN_BUFFER_PX, BUFFER_FRACTION * Math.max(boxWidth, boxHeight));

    // Clamp to the viewport (this window covers the full monitor, so
    // window.innerWidth/Height IS the screen size) before converting to
    // physical px.
    const clampedX = Math.max(0, minX - buffer);
    const clampedY = Math.max(0, minY - buffer);
    const clampedRight = Math.min(window.innerWidth, maxX + buffer);
    const clampedBottom = Math.min(window.innerHeight, maxY + buffer);
    const clampedWidth = Math.max(0, clampedRight - clampedX);
    const clampedHeight = Math.max(0, clampedBottom - clampedY);

    const dpr = window.devicePixelRatio || 1;
    const physX = Math.round(clampedX * dpr);
    const physY = Math.round(clampedY * dpr);
    const physWidth = Math.round(clampedWidth * dpr);
    const physHeight = Math.round(clampedHeight * dpr);

    // Hide BEFORE capturing — the scrim and any not-yet-faded ink must never
    // be baked into the captured pixels.
    try {
      await getCurrentWindow().hide();
    } catch (err) {
      console.error("[quick-invoke] hide before capture failed:", err);
    }

    // The window-hide request is handed to the OS compositor asynchronously;
    // grabbing the screen immediately after can still catch a frame with
    // this window's pixels still on it. A short wait lets it actually settle.
    await new Promise((resolve) => setTimeout(resolve, 140));

    let hasRegion = true;
    if (physWidth > 0 && physHeight > 0) {
      try {
        await invoke("capture_region", { x: physX, y: physY, width: physWidth, height: physHeight });
      } catch (err) {
        console.error("[quick-invoke] capture_region failed:", err);
        hasRegion = false;
        setRegionError((err as Error)?.message ?? String(err));
      }
    } else {
      hasRegion = false;
      setRegionError("The circled region was empty after clamping to the screen");
    }

    // Emit ONLY after the capture attempt above has resolved (success or
    // fail) — never before. The main window starts its agent run as soon as
    // it receives this event, and if that run's take_screenshot call landed
    // before capture_region had stashed PENDING_REGION (see the comment on
    // PENDING_REGION in src-tauri/src/os_tools.rs), it would win the race and
    // get a full-screen grab instead of the circled crop. Awaiting the
    // capture above before this emit is what guarantees the stash always
    // wins.
    try {
      await emit("quick-invoke", { prompt, mode, hasRegion });
    } catch (err) {
      console.error("[quick-invoke] emit failed:", err);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Escape") {
      // Handled by the window-level listener (dismissEverything) so that
      // Escape works no matter what has focus. Swallow it here only so the
      // input doesn't also act on it.
      e.preventDefault();
      return;
    }
    // Ctrl/Cmd+M toggles dictation (WP7.2) — mirrors ChatInput's click-to-
    // start/click-to-stop mic button, just from the keyboard since this
    // overlay is meant to be driven without reaching for the mouse.
    if (e.key.toLowerCase() === "m" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void toggleDictation();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (submittingRef.current) return; // already handling a previous Enter
      // Plain Enter now runs in the background and reports via the result
      // widget (WP5.4) — the whole point of quick-invoke is to not get
      // yanked out of whatever app you're currently in. Ctrl/Cmd+Enter is
      // the escape hatch for when you actually want the full chat window.
      const mode: Mode = e.ctrlKey || e.metaKey ? "chat" : "widget";
      const trimmed = text.trim();
      if (!trimmed) {
        resetForNextPrompt();
        hide();
        return;
      }
      submittingRef.current = true;
      if (hasInk) {
        // submitWithRegion hides the window itself, BEFORE capturing — see
        // its doc comment. No extra hide() call is needed here.
        void submitWithRegion(trimmed, mode)
          .catch((err) => console.error("[quick-invoke] submitWithRegion failed:", err))
          .finally(() => {
            resetForNextPrompt();
            submittingRef.current = false;
          });
      } else {
        // No ink drawn this session — emit exactly as before WP7.1, with no
        // capture step at all (spec item 7).
        //
        // But first drop any stashed region: PENDING_REGION lives for 120s in
        // Rust, so a crop from a question asked a minute ago is still fresh
        // enough that this ink-free question's take_screenshot call would
        // silently receive it instead of the full screen. Asking without
        // drawing must always mean "look at my whole screen".
        invoke("clear_pending_region").catch((err) =>
          console.error("[quick-invoke] clear_pending_region failed:", err)
        );
        //
        // Hide in `finally`, not `then`: if the emit ever rejects, an overlay
        // that stays on screen with no feedback and an unhandled rejection is
        // strictly worse than one that dismisses. The main window is the only
        // thing that can report the failure, and it isn't listening yet.
        void emit("quick-invoke", { prompt: trimmed, mode, hasRegion: false })
          .catch((err) => console.error("[quick-invoke] emit failed:", err))
          .finally(() => {
            resetForNextPrompt();
            hide();
            submittingRef.current = false;
          });
      }
    }
  }

  return (
    <div
      className="w-screen h-screen relative"
      // The scrim is deliberate and load-bearing twice over: it visually
      // signals "you're in ask mode", and — just as importantly — it
      // guarantees this transparent, click-through-if-empty window actually
      // has painted pixels everywhere, so the OS routes pointer events to it
      // instead of whatever's behind it on the desktop.
      style={{ background: "rgba(0,0,0,0.06)" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onContextMenu={handleContextMenu}
    >
      {/* Fullscreen drawing surface, below the card in z-order. Pure
          rendering — no handlers of its own; see the "Drawing input" comment
          above for why the root div owns pointer events instead. */}
      {/* Cursor is left at the OS default in BOTH modes. A crosshair here read
          as the app having taken over the pointer, which is exactly the wrong
          impression for a window the user is looking THROUGH at their own
          screen. The Draw button's own pressed state is the mode indicator. */}
      {/* The CSS size here is EXPLICIT, and inline rather than via utility
          classes, on purpose.
          Tailwind's preflight includes `canvas { height: auto }`. On an
          absolutely positioned replaced element, `height: auto` means "use
          your intrinsic size" — so `inset-0` alone never stretched this
          canvas: its layout size came from its width/height ATTRIBUTES. The
          render loop then measured that layout size and wrote it back into
          those same attributes, so each frame doubled the element until Blink
          clamped it at 2^24 px. That runaway was simultaneously the offset
          ink (a bitmap scaled to a nonsense box), the white screen (a
          33-million-pixel backing store), and the error that shrank toward the
          top-left. Pinning width/height to 100% breaks the attribute→layout
          feedback path: layout size is now fixed by the parent, and the
          attributes only ever follow it, never drive it. */}
      <canvas
        ref={canvasRef}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", touchAction: "none" }}
      />

      {/* Prompt bar — floats centered near the bottom so it never sits on
          top of whatever the user is circling higher up the screen. */}
      <div
        className="absolute left-1/2 bottom-[14%] w-[620px] max-w-[90vw] z-10"
        // The horizontal -50% centering that used to be Tailwind's
        // `-translate-x-1/2` is folded into this transform so the drag offset
        // (barOffset) can be added to it — dragging the bar moves it within the
        // fullscreen window rather than moving the window (see dragRef above).
        style={{ transform: `translate(calc(-50% + ${barOffset.x}px), ${barOffset.y}px)` }}
        // See the "Drawing input" comment above: without this, a pointerdown
        // on the card itself would bubble up to the root's handler and start
        // an ink stroke underneath it.
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* A single thin bar: draw on the left, input in the middle, mic on
            the right. The two circular buttons are deliberately identical in
            size and shape — they're the two ways to add something to the
            question (a region, your voice), so making one look weightier than
            the other would misrepresent them.

            The status lines this replaced (region chip, mic state, shortcut
            hints) are gone. Each control now says its own state through
            colour: the pen fills with the ink colour while armed, the mic
            turns destructive-red while recording. */}
        <div
          className="flex items-center gap-2 w-full pl-2 pr-2 py-2"
          style={{
            borderRadius: "9999px",
            background: "var(--card)",
            border: "1px solid rgba(0,0,0,0.09)",
            boxShadow: "0 8px 60px rgba(0,0,0,0.1), 0 2px 8px rgba(0,0,0,0.05)",
            cursor: dragRef.current ? "grabbing" : "grab",
          }}
          onMouseDown={(e) => {
            // Only start a drag from the bar itself, not from buttons or the input.
            const target = e.target as HTMLElement;
            if (target.tagName === "BUTTON" || target.tagName === "INPUT") return;
            if (dragRef.current) return; // already dragging
            dragRef.current = {
              startX: e.clientX,
              startY: e.clientY,
              offsetX: barOffset.x,
              offsetY: barOffset.y,
            };
          }}
        >
          {/* Draw. onMouseDown preventDefault keeps the caret in the text
              input: the whole point of this design is that you can be
              mid-sentence (typed OR dictated) and reach over to arm drawing
              without losing your place. A button that stole focus breaks that.

              Armed state uses the ink colour rather than a generic accent so
              the button and the strokes it produces are visibly the same
              thing. hasInk (region captured but drawing since disarmed) shows
              as a ring, so "I already circled something" survives disarming. */}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setDrawMode((on) => !on)}
            title={
              drawMode
                ? "Drawing — click to stop"
                : hasInk
                ? "Region marked — click to draw again (right-click the screen to clear)"
                : "Draw a region"
            }
            className="size-9 shrink-0 flex items-center justify-center rounded-full transition-colors"
            style={
              drawMode
                ? { background: `rgb(${STROKE_RGB})`, color: "#fff" }
                : {
                    background: BUTTON_DARK,
                    color: "#fff",
                    boxShadow: hasInk ? `0 0 0 2px rgb(${STROKE_RGB})` : undefined,
                  }
            }
          >
            <Pencil className="size-4" />
          </button>

          <input
            ref={inputRef}
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              micError ?? regionError ?? (micState === "recording" ? "Listening…" : "Ask LocalMind…")
            }
            autoFocus
            disabled={micState === "transcribing"}
            className={
              "flex-1 min-w-0 w-full bg-transparent border-0 outline-none text-base font-sans disabled:opacity-60 text-foreground " +
              // Errors have nowhere else to live now that the hint row is
              // gone, so they borrow the placeholder — visible without adding
              // a row, and cleared the moment the user types or retries.
              (micError || regionError ? "placeholder:text-destructive" : "placeholder:text-muted-foreground")
            }
          />

          {/* Mic — same size and shape as the pen, by design (see above).
              Local offline dictation only (src/lib/dictation.ts); this overlay
              only ever runs inside Tauri so there's no Web Speech fallback. */}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void toggleDictation()}
            disabled={micState === "transcribing"}
            title={
              micState === "recording"
                ? "Listening… click to stop"
                : micState === "transcribing"
                ? "Transcribing…"
                : "Dictate (Ctrl+M)"
            }
            className={
              "size-9 shrink-0 flex items-center justify-center rounded-full transition-colors " +
              (micState === "recording" ? "animate-pulse" : "")
            }
            style={
              micState === "recording"
                ? { background: "var(--destructive)", color: "#fff" }
                : { background: BUTTON_DARK, color: "#fff" }
            }
          >
            {micState === "transcribing" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Mic className="size-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
