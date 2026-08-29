import { useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Loader2 } from "lucide-react";
// src/lib/dictation.ts is the ONE exception to the "nothing from ../lib" rule
// below (WP7.2). It was audited before importing: no module-level state, no
// side effects, no imports of its own beyond browser globals (MediaRecorder,
// navigator.mediaDevices) — it just wraps mic-capture mechanics and a single
// window.__TAURI__.core.invoke call. Nothing here boots a second
// scheduler/taskRunner the way ../store or a stateful ../lib module would.
import { isDictationSupported, startDictation, cancelDictation, type DictationSession } from "../lib/dictation";
// ../lib/speech.ts is a second audited exception (WP7.4, merged in from the
// now-deleted src/result/ResultWidget.tsx): no module-level state, and
// speakText/resolveSelectedVoice take the voice selection as a PARAMETER
// specifically so this module never needs to import useVoiceStore itself
// (see speech.ts's own doc comments).
import { speakText } from "../lib/speech";
// ../components/Markdown is the same shared renderer the main chat window
// uses. It was already safely used inside the old ResultWidget.tsx under this
// exact "no ../store" constraint — carried over unchanged, not re-audited.
import { Markdown } from "../components/Markdown";

// NOTE: no `cn()` import, despite it being the house style — every className
// here is a static string, so cn() would merge nothing. Keep this file's
// import graph down to React + @tauri-apps/api (+ the audited dictation.ts/
// speech.ts exceptions above, plus Markdown); nothing from ../store or any
// OTHER side-effectful ../lib module may ever appear here (see main.tsx for
// why). If a conditional class is ever needed, inline a ternary rather than
// reaching back into ../components.
//
// Known, non-blocking: the built overlay entry still modulepreloads the main
// app's shared chunks (vendor-math/vendor-radix, ~700KB) because Rollup routes
// React and the @tauri-apps/api helpers through them. It is dead weight, not
// dead behavior — no store/scheduler code executes here. Fixing it means
// restructuring manualChunks in vite.config.ts, which was tried and did not
// work by simply splitting React out.

// ─── Quick-invoke overlay (WP5.3; WP7.1 fullscreen HUD; WP7.4 cursor puck) ──
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
// the puck/card float over a full-screen canvas, both sharing the same
// focus, so voice and drawing work at once. Capture happens once, at submit
// time, instead of on an idle timer — see submitWithRegion below.
//
// WP7.4 REWORK: this used to show a centered-bottom pill SEARCH BAR, with a
// SEPARATE `result` window (src/result/ResultWidget.tsx, since deleted) that
// showed the answer docked to a monitor's bottom-right corner. That second
// window existed for exactly one reason: it had to survive this window
// hiding on blur. This file now absorbs that whole responsibility instead —
// see the `phase` state machine below — so there is only ever one window,
// and its on-screen content (not the window itself) tracks the cursor: a
// small puck appears at the cursor on the hotkey and follows it live —
// through both composing AND thinking (WP7.10 removed the separate
// stationary "loading pill" this used to freeze into; the pet just keeps
// chasing the cursor the whole time a request is in flight) — only freezing
// once an answer/walkthrough actually arrives, at which point it grows in
// place into the answer card, anchored at wherever it was in that instant
// rather than a fixed corner dock.

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

/** The puck/waveform's resting fill. Near-black rather than
 *  `var(--foreground)`, which inverts to near-white under a dark theme and
 *  would turn it into a white disc on a light card. */
const BUTTON_DARK = "#0A0A0A";

/** Minimum region buffer, in CSS px, added around the drawn bounding box —
 *  the freehand loop is a hint, not a precise crop, so the actual capture
 *  is padded outward by max(28px, 8% of the box's larger dimension). */
const MIN_BUFFER_PX = 28;
const BUFFER_FRACTION = 0.08;

/** How long a `highlight-element` ring stays on screen before auto-clearing
 *  — long enough to register as "look here" without turning into a stuck
 *  decoration if nothing else ever dismisses it. If this event is also what
 *  opened the overlay (see `highlightOnly` below), this is also how long the
 *  window stays up before hiding itself again. */
const HIGHLIGHT_DURATION_MS = 4000;

/** How long the ring takes to travel from its starting point to the target
 *  rect before settling into the steady breathing pulse — this is the
 *  "glide" the feature is built around: in response to "where do I find
 *  settings", the ring visibly TRAVELS to the thing being pointed at rather
 *  than just popping into place there. Used only as the FALLBACK glide
 *  (highlightOnly mode, or a phase with no visible pet to send instead —
 *  see HIGHLIGHT_TRAVEL_MS below for the primary case). */
const HIGHLIGHT_GLIDE_MS = 380;

/**
 * WP7.13: when the pet is already on screen (phase "listening"/"running"),
 * highlighting something sends the PET itself to the target instead of
 * animating a separate ring shape across the screen — "the assistant walks
 * over and points," not "a ring flies there." This is how long that travel
 * is assumed to take before the ring actually drops into place: not
 * measured per-frame against the pet's real position (which would need a
 * distance/epsilon check), just a fixed duration approximating the spring's
 * own settle time (see PUCK_SPRING_STIFFNESS/DAMPING's doc comment — a
 * system with those constants converges within roughly this window
 * regardless of how far it had to travel, since a linear spring's settle
 * time is dominated by its own stiffness/damping, not distance).
 */
const HIGHLIGHT_TRAVEL_MS = 550;

type HighlightTarget = {
  x: number; y: number; width: number; height: number;
  fromX: number; fromY: number; fromWidth: number; fromHeight: number;
  startedAt: number;
};

/** Puck diameter, in CSS px — idle vs. recording (the waveform needs a hair
 *  more room than the bare dot). WP7.8: deliberately tiny — "a little
 *  cursor," not a button — replacing the old 56px button-styled orb and its
 *  420px expanded capsule entirely. Typed/transcribed text now floats as
 *  bare text next to the dot instead of living inside any container. */
const PUCK_IDLE_SIZE_PX = 20;
const PUCK_RECORDING_SIZE_PX = 28;
/** Max width of the plain-text (no background) input that floats next to
 *  the puck once there's something typed/transcribed to show. */
const PUCK_TEXT_MAX_WIDTH_PX = 360;
/** How often the puck's TARGET (the raw, unlagged cursor position) is
 *  re-read while listening. get_cursor_position is an async Tauri IPC
 *  round-trip, not a free local read — chaining it to a 60Hz rAF risks
 *  stacking overlapping invoke() calls if any single round-trip runs long
 *  (see cursorFollowBusyRef below). ~30Hz is smooth enough for a target the
 *  spring below only chases, not renders directly. */
const CURSOR_FOLLOW_INTERVAL_MS = 33;
/**
 * Spring-physics constants for "glides with the cursor and sways a bit to
 * feel alive" — the puck's RENDERED position is never the raw cursor
 * target directly; it's a damped-spring simulation chasing that target
 * every animation frame (see the render loop below), which is what
 * produces the lag/overshoot/settle motion of something being pulled along
 * rather than teleporting. Standard critically-damped-ish oscillator:
 * acceleration = stiffness*(target-pos) - damping*velocity. Higher
 * stiffness = catches up faster; higher damping = less overshoot/wobble.
 * These values are a first pass, not a measured ideal — tune by feel.
 */
const PUCK_SPRING_STIFFNESS = 180;
const PUCK_SPRING_DAMPING = 16;
/** Idle "breathing" sway layered on top of the spring position, always on
 *  (not just when stationary) — subtle enough not to read as jitter, but
 *  enough that the puck never looks perfectly rigid even at rest. */
const PUCK_SWAY_AMPLITUDE_PX = 2.5;
const PUCK_SWAY_SPEED = 1.6;
/**
 * Squash-and-stretch, driven by the spring's own velocity — classic
 * animation-principle treatment for something that's supposed to feel alive
 * and physically propelled, not just glued to a moving point. Elongates
 * along the direction of travel and thins on the perpendicular axis
 * (area-preserving: stretch * squash == 1), and rotates that stretch axis to
 * face the velocity direction — so the puck reads as leaning INTO its own
 * motion, the same way a thrown ball or a running character does.
 *
 * A saturating curve (not a linear ramp + hard clamp) so there's no visible
 * kink where the effect maxes out: stretch = 1 + (MAX-1) * speed/(speed +
 * HALF_SPEED) asymptotically approaches MAX as speed grows, and is exactly 1
 * at rest with no discontinuity.
 */
const PUCK_MAX_STRETCH = 1.35;
/** Speed (px/s) at which the stretch curve is halfway to its max. */
const PUCK_STRETCH_HALF_SPEED = 500;
/** Below this speed, keep the last stable rotation angle rather than
 *  recomputing atan2 on a near-zero vector — a resting/barely-moving puck
 *  has no meaningful "direction" and would otherwise visibly snap/jitter. */
const PUCK_MIN_ROTATE_SPEED_PX_S = 30;
/**
 * WP7.17: the puck's resting point is offset from the literal cursor tip —
 * up and to the right, like a badge/companion floating near your hand
 * rather than glued under it. Chosen after "I want the dot to be floating
 * near my cursor not under it" — this also resolves the tension a
 * cursor-coincident dot has with click precision (your OS clicks always
 * land at the cursor's real position, never wherever a decorative dot
 * happens to be drawn), which is part of why Draw mode also got a
 * dedicated keyboard shortcut instead of relying solely on right-clicking
 * the dot itself (see the Ctrl+D handler below).
 */
const PUCK_CURSOR_OFFSET_X = 26;
const PUCK_CURSOR_OFFSET_Y = -26;
/** Number of bars in the recording-state waveform, fed by a short rolling
 *  history of live mic RMS samples (dictation.ts's onLevel) rather than a
 *  single shared value, so adjacent bars read as a real (if small) waveform
 *  instead of one dot pulsing uniformly. */
const WAVEFORM_BAR_COUNT = 4;
/** How often the hover-watch loop re-checks the cursor against the current
 *  frozen box (showing-result's card, walkthrough's step box) to decide
 *  click-through. Less time-critical than cursor-follow's own poll — this
 *  only needs to feel responsive when the user is ABOUT to click something,
 *  not smooth every frame. */
const HOVER_WATCH_INTERVAL_MS = 80;
/** Result-card size — matches the old ResultWidget's "full" window size. */
const CARD_WIDTH_PX = 420;
const CARD_HEIGHT_PX = 380;
/** Walkthrough step-indicator card size. */
const WALKTHROUGH_WIDTH_PX = 320;
/**
 * WP7.18: a bounded MAX, not a fixed height like CARD_HEIGHT_PX — most
 * walkthrough steps ("click the Extensions icon") are one short line and the
 * box should stay small for those, but a step whose instruction is a real
 * paragraph (asked "show me how to solve this problem" — a problem-solving
 * answer wearing the walkthrough tool's clothes, not a literal UI
 * click-through) used to just grow past this box's old fixed 120px height
 * with no overflow/scroll at all, clipped by the window's own edge with no
 * way to see the rest. Passed to clampedTopLeft() too so the position clamp
 * always reserves room for the WORST case, not the common one — otherwise a
 * long step could still render positioned as if it were only 120px tall and
 * hang off the bottom of the screen even with scrolling now available.
 */
const WALKTHROUGH_MAX_HEIGHT_PX = 320;
/** Clamp margin so a frozen card never renders flush against a monitor
 *  edge. */
const EDGE_MARGIN_PX = 12;

/** Phase state machine (WP7.4; WP7.10). `micState` below stays nested
 *  inside `"listening"` unchanged — it's a finer-grained detail of that one
 *  phase, not a sibling of it.
 *
 *   listening         — puck visible, tracking the cursor, taking input.
 *   running           — submitted; puck keeps tracking the cursor, no
 *                        separate stationary loading UI at all.
 *   showing-result    — the answer card, frozen wherever the puck was the
 *                        instant the answer arrived.
 *   walkthrough-active — a step-by-step guided walkthrough is in progress.
 *
 *  There is no explicit "idle/hidden" phase: hiding the window is an OS
 *  visibility change, not a phase — `phase` itself just carries over to
 *  whatever it last was until the next `quick-invoke-open` event (a real,
 *  fresh hotkey invocation) resets it to "listening". See that listener's
 *  doc comment below for why focus-gain alone can no longer be trusted to
 *  mean "the user just opened this". */
type Phase = "listening" | "running" | "showing-result" | "walkthrough-active";

type QuickResultPayload =
  | { status: "running"; prompt: string }
  | { status: "done"; prompt: string; text: string; durationMs?: number }
  | { status: "error"; prompt: string; text: string; durationMs?: number };

type WalkthroughStep = { index: number; total: number; instruction: string };

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

/** Ported from the deleted src/result/ResultWidget.tsx, unchanged: reads the
 *  persisted voice settings straight out of localStorage rather than
 *  importing useVoiceStore (../store, forbidden here). Zustand's `persist`
 *  middleware serializes under `{state: {...}, version}` at "localmind-voice". */
function readVoiceSettings(): { selectedVoiceName: string | null; autoSpeak: boolean } {
  try {
    const raw = localStorage.getItem("localmind-voice");
    if (!raw) return { selectedVoiceName: null, autoSpeak: true };
    const parsed = JSON.parse(raw) as {
      state?: { selectedVoiceName?: unknown; quickInvokeAutoSpeak?: unknown };
    };
    const selectedVoiceName = typeof parsed?.state?.selectedVoiceName === "string" ? parsed.state.selectedVoiceName : null;
    const autoSpeak = typeof parsed?.state?.quickInvokeAutoSpeak === "boolean" ? parsed.state.quickInvokeAutoSpeak : true;
    return { selectedVoiceName, autoSpeak };
  } catch (e) {
    console.error("[quick-invoke] failed to read voice settings:", e);
    return { selectedVoiceName: null, autoSpeak: true };
  }
}

/** Ported from ResultWidget.tsx, unchanged in spirit: this widget-mode result
 *  view stays dumb — it never runs a follow-up itself. It just emits
 *  `quick-followup` with the original Q&A plus whatever the user typed
 *  (empty string for the "Open in chat →" case) and hands off to App.tsx
 *  (the main window), which surfaces itself, seeds a new conversation, and
 *  — if `followUp` is non-empty — sends it through the normal chat pipeline. */
function emitQuickFollowup(prompt: string, answer: string, followUp: string): void {
  emit("quick-followup", { prompt, answer, followUp }).catch((err) =>
    console.error("[quick-followup] emit failed:", err)
  );
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
  // opens ready to listen (its actual primary use) rather than ready to draw.
  const [drawMode, setDrawMode] = useState(false);
  /** Last backing-store size the render loop REQUESTED — see the resize
   *  reconciliation in the render loop for why this tracks the request rather
   *  than reading canvas.width back. */
  const appliedCanvasSizeRef = useRef<{ w: number; h: number } | null>(null);

  // Pause/resume flag for the render loop. Set to false only when the window
  // is genuinely hidden, to save battery — true whenever it's visible, in
  // ANY phase (see phase-transition code below for why this is no longer
  // fine-tuned per-phase: a paused loop leaves the canvas showing whatever
  // was drawn on it last, and that stale-frame risk is worse than the
  // negligible cost of clearing an empty canvas every frame).
  const renderActiveRef = useRef(true);

  // ─── Phase state machine (WP7.4) ───────────────────────────────────────
  const [phase, setPhase] = useState<Phase>("listening");
  // Stale-closure escape hatch for the onFocusChanged effect (registered
  // once, empty deps) — mirrors dictationActiveRef's own doc comment below.
  const phaseRef = useRef<Phase>("listening");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // The puck's FROZEN anchor position (CENTER, CSS px) — set exactly once,
  // at submit time, to wherever the spring-animated puck actually was (see
  // springPosRef below), and never touched again until the next fresh
  // session. Every later phase's card/pill positions itself around this.
  // While `phase === "listening"`, the puck's REAL rendered position is
  // driven imperatively by the spring physics in the render loop instead —
  // see targetPosRef/springPosRef — so this state deliberately does NOT
  // track the puck during listening (that would mean a React re-render on
  // every animation frame, fighting the whole point of animating it
  // imperatively).
  const [puckPos, setPuckPos] = useState(() => ({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
  }));
  // Stale-closure escape hatch for the highlight-element listener below
  // (registered once, empty deps) — same pattern as phaseRef.
  const puckPosRef = useRef(puckPos);
  useEffect(() => {
    puckPosRef.current = puckPos;
  }, [puckPos]);
  const puckElRef = useRef<HTMLDivElement>(null);
  // The plain-text (no background) typed/transcribed text — a SEPARATE
  // element from the dot itself (puckElRef), positioned a fixed offset to
  // its right each frame, so the dot's own centering point never shifts as
  // the text next to it grows/shrinks while typing.
  const puckTextRef = useRef<HTMLDivElement>(null);

  // ─── Puck spring-physics ("glides... sways a bit to feel alive") ───────
  //
  // targetPosRef is the raw, unlagged cursor position — updated at
  // CURSOR_FOLLOW_INTERVAL_MS by positionPuckAtCursor below. springPosRef is
  // what actually gets rendered, updated every animation frame in the main
  // render loop by chasing targetPosRef with a damped-spring simulation
  // (see the PUCK_SPRING_* constants' doc comment). Neither is React state —
  // both are mutated in place, 60x/sec, directly against the DOM via
  // puckElRef; going through setState at that rate would fight React's
  // render cycle for no benefit, since nothing else needs to react to the
  // puck's position mid-flight (only the FROZEN puckPos above does).
  const targetPosRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const springPosRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const velocityRef = useRef({ x: 0, y: 0 });
  const lastSpringFrameRef = useRef<number | null>(null);
  // Last stable squash-and-stretch rotation angle (degrees) — see
  // PUCK_MIN_ROTATE_SPEED_PX_S's doc comment for why this persists across
  // frames instead of being recomputed from scratch every time.
  const puckAngleDegRef = useRef(0);
  // Rolling history of recent mic RMS samples (dictation.ts's onLevel),
  // oldest first — feeds the waveform bars so adjacent bars show slightly
  // different heights (a real, if tiny, waveform) instead of one value
  // pulsing every bar identically.
  const levelHistoryRef = useRef<number[]>(new Array(WAVEFORM_BAR_COUNT).fill(0));
  const waveBarRefs = useRef<(HTMLDivElement | null)[]>([]);
  // Stale-closure escape hatch for the render loop (registered once, empty
  // deps) — same pattern as phaseRef/dictationActiveRef.
  const micStateRef = useRef(micState);
  useEffect(() => {
    micStateRef.current = micState;
  }, [micState]);

  // WP7.13: while non-null, the pet is being sent to a highlight_element
  // target instead of the cursor — positionPuckAtCursor checks this and
  // skips updating targetPosRef so the cursor-follow poll doesn't fight the
  // hijack, and the render loop watches travelStartedAt to know when to
  // stop treating this as "still traveling" and drop the ring instead.
  const highlightTravelRef = useRef<{
    rectX: number; rectY: number; rectWidth: number; rectHeight: number; travelStartedAt: number;
  } | null>(null);

  const cursorFollowRef = useRef<number | null>(null);
  const cursorFollowBusyRef = useRef(false);

  const [resultPayload, setResultPayload] = useState<QuickResultPayload | null>(null);
  const followUpInputRef = useRef<HTMLInputElement>(null);

  const [walkthrough, setWalkthrough] = useState<WalkthroughStep | null>(null);
  // WP7.10: drives the grow/fade-in transition for showing-result's card and
  // walkthrough's step box — false the instant either phase is entered
  // (rendered at a small scale, transparent), flipped true a couple of
  // frames later so the CSS transition actually animates "the pet grew into
  // this" instead of the box just popping in at full size.
  const [cardEntered, setCardEntered] = useState(false);
  // Pending "shrink out, then actually hide()" timeout — see
  // closeWithExitAnimation below. Tracked in a ref (not fired-and-forgotten)
  // so a fresh quick-invoke-open can cancel a stale one: closing then
  // immediately reopening within the exit transition's window must not let
  // an old timer hide() the brand-new session out from under the user.
  const exitTimeoutRef = useRef<number | null>(null);

  // ─── Click-through (WP7.6) ──────────────────────────────────────────────
  //
  // A transparent CSS background does NOT make a Tauri/WebView2 window
  // click-through on its own — that was a wrong assumption baked into every
  // "background: transparent" comment elsewhere in this file. Without this,
  // the fullscreen, always-on-top overlay silently ate every click on the
  // ENTIRE monitor for as long as it was visible, even over empty space —
  // observed live as "while it's thinking I can't do anything on my
  // computer" during the "running" phase, which has no interactive content
  // at all and should never have been capturing input in the first place.
  // getCurrentWindow().setIgnoreCursorEvents(true) is the real fix (needs
  // core:window:allow-set-ignore-cursor-events, added to capabilities/
  // overlay.json) — it's an all-or-nothing flag for the whole window, so
  // phases with no clickable content (running, highlightOnly's bare ring)
  // just stay fully click-through; phases WITH clickable content
  // (showing-result's card, walkthrough's step box) run a cursor-position
  // poll (hoverWatch below) and flip the flag off only while the cursor is
  // actually over that box, back on the instant it isn't. "listening" is
  // deliberately left alone — its puck already tracks the cursor everywhere
  // it goes, so there's no fixed hoverable box to hit-test against; that
  // phase keeps today's fully-interactive behavior.
  const ignoreCursorEventsRef = useRef(false);
  const hoverWatchRef = useRef<number | null>(null);
  // Shared by whichever ONE of showing-result's card / walkthrough's step
  // box is actually mounted right now (the two phases are mutually
  // exclusive) — hoverWatch hit-tests the cursor against whichever box this
  // currently points at.
  const frozenBoxRef = useRef<HTMLDivElement>(null);
  // Dragging showing-result's card / walkthrough's step box — mirrors the
  // pre-WP7.4 ResultWidget.tsx's drag pattern, just repositioning `puckPos`
  // directly (a plain CSS position) instead of moving the actual OS window
  // (there's no separate window anymore to move — see this file's header
  // comment). Named distinctly from the old bar-drag system it replaces:
  // this one drives the FROZEN phases' box position, not the listening
  // puck's (which already moves on its own via cursor-follow).
  const frozenDragRef = useRef<{
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
    width: number;
    height: number;
  } | null>(null);
  // WP7.16: while an active drag is in progress, the box's on-screen
  // position lives HERE (imperatively DOM-mutated on every mousemove),
  // not in puckPos React state — see onMouseMove's doc comment for why.
  // Also read by the two showing-result/walkthrough-active style blocks so
  // a re-render mid-drag (for any unrelated reason) renders the box at its
  // actual current dragged position instead of snapping back to the
  // pre-drag one puckPos still holds. Null whenever no drag is active,
  // meaning "defer to clampedTopLeft(puckPos)" as before.
  const dragPosRef = useRef<{ left: number; top: number } | null>(null);

  useEffect(() => {
    function onMouseMove(e: MouseEvent): void {
      const drag = frozenDragRef.current;
      const box = frozenBoxRef.current;
      if (!drag || !box) return;
      const deltaX = e.clientX - drag.startX;
      const deltaY = e.clientY - drag.startY;
      // Same edge clamp as clampedTopLeft(), reimplemented against this
      // drag's own captured width/height rather than calling that function
      // (which derives its box size from a specific phase's constant, not
      // something generic code here can assume).
      const left = Math.max(
        EDGE_MARGIN_PX,
        Math.min(window.innerWidth - drag.width - EDGE_MARGIN_PX, drag.startLeft + deltaX),
      );
      const top = Math.max(
        EDGE_MARGIN_PX,
        Math.min(window.innerHeight - drag.height - EDGE_MARGIN_PX, drag.startTop + deltaY),
      );
      // Mutate the DOM directly, bypassing React state entirely, for the
      // same reason the puck's spring-physics position does (see
      // targetPosRef/springPosRef's own doc comment): dragging a box whose
      // position is piped through setPuckPos on every single mousemove
      // pixel was observed live to go "stuck" while the answer was being
      // read aloud — the mousemove listener itself was still firing (this
      // is a plain document-level DOM listener, never throttled), but
      // Web Speech Synthesis's own callback activity on the same main
      // thread was apparently enough to starve React's render/commit pass
      // for the whole time it was speaking, so the state updates piled up
      // without ever visibly flushing until speech stopped. Writing
      // directly to style.left/top has no render pass to starve.
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      dragPosRef.current = { left, top };
    }
    function onMouseUp(): void {
      const drag = frozenDragRef.current;
      const pos = dragPosRef.current;
      if (drag && pos) {
        // Commit back to React state once dragging ends, so the NEXT
        // normal (non-dragging) render's clampedTopLeft(puckPos) derives
        // the same spot the box was just dropped at. puckPos is the box's
        // CENTER anchor, not its top-left — invert clampedTopLeft's own
        // math to recover it.
        setPuckPos({ x: pos.left + drag.width / 2, y: pos.top + drag.height / 2 });
      }
      frozenDragRef.current = null;
      dragPosRef.current = null;
    }
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  /** Grab handler for showing-result's header / walkthrough's box — ignores
   *  a mousedown that started on a BUTTON or INPUT so clicking Close/Next/
   *  the follow-up field doesn't also start a drag. */
  function beginFrozenDrag(e: React.MouseEvent): void {
    const target = e.target as HTMLElement;
    if (target.tagName === "BUTTON" || target.tagName === "INPUT") return;
    if (frozenDragRef.current) return;
    const box = frozenBoxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    frozenDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }

  function setWindowIgnoreCursorEvents(ignore: boolean): void {
    if (ignoreCursorEventsRef.current === ignore) return; // dedupe — avoid spamming IPC every poll tick
    ignoreCursorEventsRef.current = ignore;
    getCurrentWindow()
      .setIgnoreCursorEvents(ignore)
      .catch((err) => console.error("[quick-invoke] setIgnoreCursorEvents failed:", err));
  }

  function stopHoverWatch(): void {
    if (hoverWatchRef.current !== null) {
      window.clearInterval(hoverWatchRef.current);
      hoverWatchRef.current = null;
    }
    hoverWatchBusyRef.current = false;
  }

  // WP7.16: skips a tick rather than letting overlapping get_cursor_position
  // round-trips stack up — same pattern as cursorFollowBusyRef above, and
  // for the same reason: if a tick dispatched later somehow resolves BEFORE
  // an earlier one (any transient IPC/scheduling delay can cause this), the
  // earlier one's stale result would land last and could flip
  // ignoreCursorEvents back to the wrong state, effectively stranding the
  // window click-through until a later tick happens to correct it.
  const hoverWatchBusyRef = useRef(false);

  function startHoverWatch(): void {
    if (hoverWatchRef.current !== null) return;
    hoverWatchRef.current = window.setInterval(async () => {
      // Never toggle click-through mid-drag: a drag can only ever START with
      // ignore=false (it begins on a mousedown inside the box, which only
      // reaches this webview at all because the cursor was already inside
      // it), but the drag itself moves the box out from under a cursor that
      // hasn't "moved" from the OS's perspective (the BOX moved, not the
      // pointer) — a poll tick mid-drag could otherwise measure the box's
      // now-stale-by-a-frame rect, decide the cursor looks "outside" it, and
      // flip ignore=true. That would stop this window from receiving any
      // further mousemove/mouseup at all, permanently stranding dragRef in
      // its non-null state with no mouseup ever left to clear it.
      if (frozenDragRef.current || hoverWatchBusyRef.current) return;
      hoverWatchBusyRef.current = true;
      try {
        const pos = await invoke<[number, number] | null>("get_cursor_position");
        const box = frozenBoxRef.current;
        if (!pos || !box) {
          setWindowIgnoreCursorEvents(true);
          return;
        }
        const dpr = window.devicePixelRatio || 1;
        const cx = pos[0] / dpr;
        const cy = pos[1] / dpr;
        const rect = box.getBoundingClientRect();
        const inside = cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom;
        setWindowIgnoreCursorEvents(!inside);
      } catch (err) {
        console.error("[quick-invoke] hover-watch cursor check failed:", err);
      } finally {
        hoverWatchBusyRef.current = false;
      }
    }, HOVER_WATCH_INTERVAL_MS);
  }

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
  // open, release the mic and stop cursor-following rather than leaving them
  // running with nothing left to stop them — mirrors the same cleanup in
  // ChatInput.tsx.
  useEffect(() => {
    return () => {
      cancelDictation(dictationSessionRef.current);
      dictationSessionRef.current = null;
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      stopCursorFollow();
      if (exitTimeoutRef.current !== null) {
        window.clearTimeout(exitTimeoutRef.current);
        exitTimeoutRef.current = null;
      }
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

  /** Re-shows the window without stealing focus — mirrors the deleted
   *  show_result_widget's contract exactly ("never call set_focus() here —
   *  stealing focus is exactly what this widget exists to avoid"), just as a
   *  plain client-side call now that there's no separate Rust-managed
   *  `result` window to resize/reposition: this window never moves or
   *  resizes for any phase, only the content drawn inside it does. Needed
   *  because submitWithRegion/submitWithAutoScreenshot hide the window
   *  themselves right before capturing a clean screenshot — something has to
   *  bring it back once there's a pill/card to show. */
  function showWithoutFocus(): void {
    renderActiveRef.current = true;
    getCurrentWindow()
      .show()
      .catch((err) => console.error("[quick-invoke] show failed:", err));
  }

  /** "Fly back out" when a result card or walkthrough box is on screen:
   *  reverses the entrance transition (shrink+fade back toward the pet's
   *  frozen spot) and only calls the real hide() once that transition has
   *  actually finished, instead of yanking the window away mid-answer.
   *  Outside those two phases there's no card to shrink, so it's just hide()
   *  — e.g. Escape while still "listening" with no result yet. `afterExit`
   *  runs right before hide() fires, for callers (Escape, cancelWalkthrough)
   *  that need to clear phase-specific state (walkthrough payload, etc.)
   *  only once the box has actually finished animating away rather than
   *  unmounting it mid-shrink. */
  function closeWithExitAnimation(afterExit?: () => void): void {
    const hasCard = phaseRef.current === "showing-result" || phaseRef.current === "walkthrough-active";
    if (exitTimeoutRef.current !== null) {
      window.clearTimeout(exitTimeoutRef.current);
      exitTimeoutRef.current = null;
    }
    if (!hasCard) {
      afterExit?.();
      hide();
      return;
    }
    setCardEntered(false);
    exitTimeoutRef.current = window.setTimeout(() => {
      exitTimeoutRef.current = null;
      afterExit?.();
      hide();
    }, 260);
  }

  /** Wipe every drawn stroke and reset the status-row state. Called on
   *  right-click, on submit/dismiss, and whenever a fresh session opens
   *  (see the quick-invoke-open effect below) — a fresh invocation must
   *  never inherit the previous session's ink. */
  function clearStrokes(): void {
    strokesRef.current = [];
    setHasInk(false);
  }

  /** Same as clearStrokes, plus telling Rust to drop any PENDING_REGION
   *  stash. Used by the two paths that are a deliberate "no, I don't want
   *  this region after all" (right-click, and Escape while ink exists) — as
   *  opposed to a fresh-session reset, which is just clearing stale UI state
   *  rather than actively cancelling something the user asked for.
   *  clear_pending_region is a no-op if nothing is stashed. */
  function clearStrokesAndPendingRegion(): void {
    clearStrokes();
    invoke("clear_pending_region").catch((err) =>
      console.error("[quick-invoke] clear_pending_region failed:", err)
    );
  }

  /** A prompt round has ended (submitted or dismissed) — clear the typed
   *  text AND any drawn ink, since both belong to the prompt that just
   *  ended, not whatever the user does next time the overlay opens. Does
   *  NOT touch `phase` — callers decide what phase comes next (a fresh
   *  "listening" session, or "running" while a submit is in flight). */
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
    // Deliberately does NOT stopCursorFollow() here (WP7.10) — this runs
    // right after submit's capture/emit sequence finishes, long before the
    // actual answer comes back, and the pet is meant to keep chasing the
    // cursor through the whole "running" (thinking) phase, not just while
    // composing. Cursor-follow is stopped exactly once, at the moment the
    // answer/walkthrough actually arrives — see the quick-result and
    // quick-walkthrough-step listeners.
  }

  // Escape always dismisses, from anywhere.
  //
  // This is a WINDOW-level listener rather than the input's onKeyDown because
  // the input is not reliably what has focus — and now, with the collapsed
  // puck, may not even be MOUNTED. Ctrl+M (dictation toggle) lives here too
  // for the same reason: the mic button/input only exist once the capsule is
  // expanded, but starting/stopping dictation has to work from the collapsed
  // puck too.
  //
  // Deliberately NOT a ladder (an earlier revision made the first Escape
  // cancel dictation, the second clear ink, and only the third dismiss).
  // Escape means "get this off my screen". resetForNextPrompt() releases the
  // mic on the way out, so dismissing mid-recording can't leave it hot.
  useEffect(() => {
    function onWindowKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        const wasWalkthrough = phaseRef.current === "walkthrough-active";
        if (wasWalkthrough) {
          emit("quick-walkthrough-cancel").catch((err) =>
            console.error("[quick-invoke] quick-walkthrough-cancel emit failed:", err)
          );
          // setWalkthrough(null) is deferred into closeWithExitAnimation's
          // afterExit below — clearing it here would unmount the box before
          // it gets a chance to shrink away.
        }
        resetForNextPrompt();
        // WP7.10: cursor-follow now runs through "running" too (see the
        // broadened spring-physics gate), not just "listening" — Escape
        // used to get this for free via resetForNextPrompt's own
        // stopCursorFollow() call, which had to be removed from there so
        // the pet could keep chasing the cursor past submit. Without an
        // explicit call here, dismissing mid-"running" would leave the
        // cursor poll running forever in the background with the window
        // hidden and nothing left to ever stop it.
        stopCursorFollow();
        // Same reasoning as the quick-invoke-open handler's identical
        // block: an in-progress highlight travel/ring must not survive
        // past Escape — nothing else would ever clear it if the user
        // doesn't happen to reopen soon.
        highlightTravelRef.current = null;
        highlightRef.current = null;
        if (highlightTimeoutRef.current !== null) {
          window.clearTimeout(highlightTimeoutRef.current);
          highlightTimeoutRef.current = null;
        }
        invoke("clear_pending_region").catch((err) =>
          console.error("[quick-invoke] clear_pending_region failed:", err)
        );
        closeWithExitAnimation(() => {
          if (wasWalkthrough) setWalkthrough(null);
        });
        return;
      }
      if (e.key.toLowerCase() === "m" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void toggleDictation();
      }
      // Dedicated Draw-mode hotkey — separate from the puck's right-click
      // toggle because the puck now floats offset from the literal cursor
      // (see PUCK_CURSOR_OFFSET_X/Y): right-clicking "the dot" means aiming
      // at a point that isn't where your hand actually is, which got
      // reported as broken. Ctrl+D works from anywhere, cursor position
      // irrelevant, and only while the puck itself is interactible.
      if (e.key.toLowerCase() === "d" && (e.ctrlKey || e.metaKey) && phaseRef.current === "listening") {
        e.preventDefault();
        setDrawMode((on) => !on);
      }
    }
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The actual "start recording" mechanics — pulled out of toggleDictation
   * (below) so the auto-start-on-open effect can call it directly rather than
   * going through toggleDictation's micState branching. That matters because
   * the quick-invoke-open effect this feeds (see below) is registered once
   * with an empty deps array: a `toggleDictation` reference captured there
   * would be a stale closure permanently frozen at whatever micState was at
   * mount ("idle"), which happens to coincidentally take the right branch
   * today but is exactly the kind of stale-closure trap dictationActiveRef
   * exists to avoid elsewhere in this file — better to have a function with
   * no micState dependency at all than to rely on that coincidence.
   */
  /** Shared onLevel callback for both dictation entry points below — shifts
   *  a new RMS sample into levelHistoryRef's rolling window. Read directly
   *  by the render loop's waveform-bar drawing, never via React state (see
   *  levelHistoryRef's own doc comment for why). */
  function handleAudioLevel(rms: number): void {
    const history = levelHistoryRef.current;
    history.shift();
    history.push(rms);
  }

  async function beginListening(): Promise<void> {
    setMicError(null);
    if (!isDictationSupported()) {
      setMicError("Microphone capture isn't supported in this build.");
      return;
    }
    try {
      // onSilence: once the user stops talking, stop and auto-submit rather
      // than waiting for another click/Ctrl+M — this is the hands-free loop
      // the overlay is meant to support. Manual click-to-stop (toggleDictation
      // called again mid-recording) still works identically alongside this;
      // whichever fires first calls stopDictationAndInsert once.
      const session = await startDictation({ onSilence: () => void stopDictationAndInsert(), onLevel: handleAudioLevel });
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

  /**
   * Same start mechanics as beginListening, but for a walkthrough step: on
   * silence, check the transcript for a "next"/"done"/"skip" confirmation
   * word instead of submitting it as a new prompt. Anything else just
   * re-arms listening for the SAME step — a stray remark or silence with no
   * speech should not accidentally advance/cancel. This is deliberately the
   * simplest of the three click-detection options considered (see the plan):
   * it reuses the existing single-shot record-until-silence dictation
   * pipeline verbatim, just with a different post-transcript action, so it
   * ships with zero new Rust surface and no continuous-recognition machinery.
   */
  async function beginWalkthroughListening(): Promise<void> {
    if (!isDictationSupported()) return;
    try {
      const session = await startDictation({ onSilence: () => void handleWalkthroughSilence(), onLevel: handleAudioLevel });
      dictationSessionRef.current = session;
      setMicState("recording");
    } catch (e) {
      console.error("[quick-invoke] walkthrough startDictation failed:", e);
      setMicState("idle");
    }
  }

  async function handleWalkthroughSilence(): Promise<void> {
    const session = dictationSessionRef.current;
    dictationSessionRef.current = null;
    if (!session) {
      setMicState("idle");
      return;
    }
    setMicState("transcribing");
    let transcript = "";
    try {
      transcript = (await session.stop(readWhisperModelSetting())) ?? "";
    } catch (e) {
      console.error("[quick-invoke] walkthrough dictation stop/transcribe failed:", e);
    }
    setMicState("idle");
    // Still in a walkthrough? (Escape/cancel could have fired while awaiting
    // transcription.) If not, just drop the transcript silently.
    if (phaseRef.current !== "walkthrough-active") return;
    const lower = transcript.trim().toLowerCase();
    if (/\b(done|stop|cancel)\b/.test(lower)) {
      cancelWalkthrough();
    } else if (/\b(next|skip|continue)\b/.test(lower)) {
      advanceWalkthrough();
    } else {
      // No confirmation word heard — keep listening for the same step rather
      // than silently going deaf after one unrelated utterance.
      void beginWalkthroughListening();
    }
  }

  function advanceWalkthrough(): void {
    cancelDictation(dictationSessionRef.current);
    dictationSessionRef.current = null;
    emit("quick-walkthrough-advance").catch((err) =>
      console.error("[quick-invoke] quick-walkthrough-advance emit failed:", err)
    );
  }

  function cancelWalkthrough(): void {
    cancelDictation(dictationSessionRef.current);
    dictationSessionRef.current = null;
    setMicState("idle");
    stopCursorFollow(); // defensive — already stopped by the time a walkthrough starts, but cheap to be sure
    emit("quick-walkthrough-cancel").catch((err) =>
      console.error("[quick-invoke] quick-walkthrough-cancel emit failed:", err)
    );
    // walkthrough state (and renderActiveRef) clear only once the box has
    // actually finished shrinking away — see closeWithExitAnimation.
    closeWithExitAnimation(() => {
      setWalkthrough(null);
      renderActiveRef.current = false;
    });
  }

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

    await beginListening();
  }

  /**
   * Stops the active dictation session, transcribes it, and auto-submits the
   * result — hands-free, no separate Enter press needed. Called both from a
   * manual click/Ctrl+M-to-stop (toggleDictation) and from startDictation's
   * onSilence callback once the user stops talking. Appends to whatever was
   * already typed (space-separated) rather than clobbering it, then submits
   * that merged text directly — reading it back out of `text` state right
   * after setText would still see the stale pre-update value, so `submit`
   * gets the computed string explicitly instead of relying on a re-render.
   */
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
        const merged = text.trim() ? `${text.trim()} ${transcript}` : transcript;
        setText(merged);
        submit(merged);
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

  /**
   * Reads the OS cursor position and moves the puck's CENTER there, clamped
   * so it can never render partially off-screen. Measures the puck's own
   * CURRENT rendered box (not a fixed constant) because its size changes
   * materially between the collapsed orb and the expanded capsule, and this
   * has to keep tracking correctly through that transition. get_cursor_position
   * (src-tauri/src/tray.rs) returns physical pixels; this divides by
   * devicePixelRatio to land in the same CSS-pixel space the puck's `left`/
   * `top` style already uses — the same conversion submitWithRegion does in
   * the opposite direction.
   */
  async function positionPuckAtCursor(): Promise<void> {
    // WP7.13: don't fight an active highlight_element travel — the pet is
    // deliberately being sent to a target rect instead of the cursor right
    // now (see highlightTravelRef's doc comment); this poll resumes on its
    // own next tick once that ref is cleared.
    if (highlightTravelRef.current) return;
    try {
      const pos = await invoke<[number, number] | null>("get_cursor_position");
      if (!pos) return; // keep whatever target the puck already had
      const dpr = window.devicePixelRatio || 1;
      const cursorX = pos[0] / dpr;
      const cursorY = pos[1] / dpr;

      // Clamp against the LARGER (recording) size always, regardless of the
      // puck's current actual size — this function runs from a setInterval
      // closure created once when listening starts, so reading micState
      // directly here would be a stale read frozen at whatever it was at
      // that moment (the exact trap dictationActiveRef/phaseRef exist
      // elsewhere in this file to avoid). Using the conservative constant
      // instead of a live size means the clamp boundary never needs a live
      // value at all — cheap and avoids the staleness question entirely.
      const half = PUCK_RECORDING_SIZE_PX / 2;
      // PUCK_CURSOR_OFFSET_*: float near the cursor, not under it — see that
      // constant's doc comment.
      targetPosRef.current = {
        x: Math.max(half, Math.min(window.innerWidth - half, cursorX + PUCK_CURSOR_OFFSET_X)),
        y: Math.max(half, Math.min(window.innerHeight - half, cursorY + PUCK_CURSOR_OFFSET_Y)),
      };
    } catch (err) {
      console.error("[quick-invoke] get_cursor_position failed:", err);
    }
  }

  /** Starts polling the cursor position and moving the puck to follow it —
   *  active only while `phase === "listening"` (see startCursorFollow's call
   *  sites). setInterval, not requestAnimationFrame: see
   *  CURSOR_FOLLOW_INTERVAL_MS's doc comment for why. cursorFollowBusyRef
   *  skips a tick rather than letting invoke() calls stack up if one
   *  round-trip runs long. */
  function startCursorFollow(): void {
    if (cursorFollowRef.current !== null) return;
    cursorFollowRef.current = window.setInterval(() => {
      if (cursorFollowBusyRef.current) return;
      cursorFollowBusyRef.current = true;
      void positionPuckAtCursor().finally(() => {
        cursorFollowBusyRef.current = false;
      });
    }, CURSOR_FOLLOW_INTERVAL_MS);
  }

  /** Picks a point on the screen edge opposite the given target, for the
   *  fly-in entrance: mirrors the direction from screen-center to target
   *  and scales it out to whichever edge (horizontal or vertical) it hits
   *  first, so the start point always lands exactly on the border rather
   *  than drifting toward center for targets that are already near it. */
  function computeFlyInStart(targetX: number, targetY: number): { x: number; y: number } {
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const dx = targetX - cx;
    const dy = targetY - cy;
    if (dx === 0 && dy === 0) {
      return { x: EDGE_MARGIN_PX, y: cy };
    }
    const scaleX = dx !== 0 ? (cx - EDGE_MARGIN_PX) / Math.abs(dx) : Infinity;
    const scaleY = dy !== 0 ? (cy - EDGE_MARGIN_PX) / Math.abs(dy) : Infinity;
    const scale = Math.min(scaleX, scaleY);
    return { x: cx - dx * scale, y: cy - dy * scale };
  }

  /** Stops the cursor-follow loop — the puck freezes wherever it last was.
   *  Called right before submit transitions to "running", on Escape/dismiss,
   *  and on unmount. Clearing the interval alone is the whole "freeze": no
   *  separate freeze step is needed since React state simply stops changing
   *  once nothing is calling setPuckPos anymore. */
  function stopCursorFollow(): void {
    if (cursorFollowRef.current !== null) {
      window.clearInterval(cursorFollowRef.current);
      cursorFollowRef.current = null;
    }
  }

  // ─── Fresh-session reset (WP7.4) ───────────────────────────────────────
  //
  // Emitted by toggle_overlay's SHOW branch (src-tauri/src/tray.rs) —
  // distinct from onFocusChanged(true) below, which now ALSO fires for
  // reasons that are not a fresh hotkey press (this window regaining focus
  // while "running"/"showing-result"/"walkthrough-active" must survive
  // blur — see the onFocusChanged effect). Only a genuine new invocation
  // should reset ink/position/dictation/phase; a plain refocus must not.
  useEffect(() => {
    const unlistenPromise = listen("quick-invoke-open", () => {
      sizeCanvas();
      requestAnimationFrame(sizeCanvas);
      // A stale exit-animation timeout from the PREVIOUS session (closed,
      // then hotkeyed open again inside its 260ms shrink window) must not
      // be allowed to hide() this brand-new session out from under the user.
      if (exitTimeoutRef.current !== null) {
        window.clearTimeout(exitTimeoutRef.current);
        exitTimeoutRef.current = null;
      }
      clearStrokes();
      setDrawMode(false);
      setResultPayload(null);
      setWalkthrough(null);
      lastHighlightRestRef.current = null;
      // A fresh session must never inherit an in-progress highlight travel
      // from the last one — without this, positionPuckAtCursor's guard
      // would stay tripped forever (nothing else ever clears
      // highlightTravelRef except the travel's own completion timer).
      highlightTravelRef.current = null;
      highlightRef.current = null;
      if (highlightTimeoutRef.current !== null) {
        window.clearTimeout(highlightTimeoutRef.current);
        highlightTimeoutRef.current = null;
      }
      setPhase("listening");
      // Fly-in: park the spring's current position at the screen edge
      // opposite the cursor BEFORE the follow loop starts, so the very
      // first frames of the damped-spring simulation visibly travel in
      // from off to the side rather than just appearing at the cursor.
      // positionPuckAtCursor() is awaited first so targetPosRef reflects
      // the real (offset, clamped) destination the mirror is computed
      // against.
      void (async () => {
        await positionPuckAtCursor();
        const target = targetPosRef.current;
        const start = computeFlyInStart(target.x, target.y);
        springPosRef.current = { x: start.x, y: start.y };
        velocityRef.current = { x: 0, y: 0 };
      })();
      startCursorFollow();
      inputRef.current?.focus();
      renderActiveRef.current = true;
      // Start listening immediately — no click needed. This is the primary
      // hands-free path the overlay is designed around; typing still works
      // as a fallback. Reads dictationActiveRef, not micState — this effect
      // is registered once with an empty deps array, so a state variable
      // read in here would be a stale closure frozen at mount time;
      // dictationActiveRef exists specifically to give effects like this one
      // a live-updated value (see its own doc comment above).
      // dictationSessionRef is a ref too, so it's likewise safe to read here
      // directly.
      if (!dictationActiveRef.current && !dictationSessionRef.current) {
        if (readDictationEngineSetting() === "browser") {
          toggleWebSpeechDictation();
        } else {
          void beginListening();
        }
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Visual guidance: highlight-element ring (WP7.3; WP7.5 glide) ──────
  //
  // `highlight_screen_rect` (src-tauri/src/tray.rs) is the agent-callable
  // command that drives this — it resolves which monitor a UI element's
  // bounding rect (from `uia_list_elements`) is on, positions/shows the
  // overlay there WITHOUT stealing focus, converts the rect into that
  // monitor's CSS-pixel space, and emits this event. Unlike ink, this can
  // arrive while the overlay is hidden, so `was_visible` (from the payload)
  // tells us whether THIS event is the reason the window is up right now —
  // `highlightOnly` tracks that, both to skip ALL of the phase-based UI
  // below (a passive "look here" pointer shouldn't show a stale puck/card
  // left over from whatever session was last open) and so this effect knows
  // whether it owns hiding the window again once the ring expires.
  const highlightRef = useRef<HighlightTarget | null>(null);
  const [highlightOnly, setHighlightOnly] = useState(false);
  const highlightTimeoutRef = useRef<number | null>(null);
  // Where the ring last came to rest — the NEXT highlight (a second "where's
  // X" ask, or the next step of a walkthrough) glides FROM here instead of
  // from the puck, so a run of highlights reads as the ring traveling from
  // one thing to the next rather than always darting back to the cursor.
  // Reset to null on every fresh session (see quick-invoke-open below).
  const lastHighlightRestRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  useEffect(() => {
    const unlistenPromise = listen<{
      x: number;
      y: number;
      width: number;
      height: number;
      was_visible: boolean;
    }>("highlight-element", (event) => {
      const { x, y, width, height, was_visible } = event.payload;

      // Rust may have just resized/repositioned this window onto a
      // different monitor before emitting — re-measure exactly like
      // onFocusChanged does below, and for the same reason (see its
      // comment): a focus event's own timing already races the webview's
      // layout pass, and this arrives with no focus event at all.
      sizeCanvas();
      requestAnimationFrame(sizeCanvas);
      renderActiveRef.current = true;
      if (highlightTimeoutRef.current !== null) {
        window.clearTimeout(highlightTimeoutRef.current);
      }

      // WP7.13/7.15: if the pet is already visible and free (not frozen
      // showing the RESULT card — "walkthrough-active" now qualifies too,
      // since the pet renders and travels between steps there just like it
      // does in "running"), send IT to the target instead of animating a
      // separate ring shape across the screen — "the assistant walks over
      // and points," not "a ring flies there." Originally scoped to just
      // listening/running; observed live during a real multi-step
      // walkthrough that steps 2+ (which fire while phase is already
      // "walkthrough-active") fell through to the old ring-glide fallback,
      // making only the FIRST step's highlight travel correctly and every
      // step after it look like "a box flying into position" instead.
      // positionPuckAtCursor's own guard stops the cursor-follow poll from
      // fighting this. The render loop below watches highlightTravelRef and
      // creates the actual ring (a "drop," growing from a point at the
      // target's own position) once the travel duration elapses — nothing
      // else to do here for that path.
      const petCanTravel =
        was_visible &&
        (phaseRef.current === "listening" || phaseRef.current === "running" || phaseRef.current === "walkthrough-active");
      if (petCanTravel) {
        targetPosRef.current = { x: x + width / 2, y: y + height / 2 };
        highlightTravelRef.current = { rectX: x, rectY: y, rectWidth: width, rectHeight: height, travelStartedAt: performance.now() };
        highlightRef.current = null;
        return;
      }

      // Fallback — no visible pet to send (highlightOnly mode, or a frozen
      // phase like showing-result/walkthrough-active): animate a ring shape
      // across the screen instead, exactly as before this rework.
      const prevRest = lastHighlightRestRef.current;
      const fromX = prevRest ? prevRest.x : puckPosRef.current.x;
      const fromY = prevRest ? prevRest.y : puckPosRef.current.y;
      const fromWidth = prevRest ? prevRest.width : 0;
      const fromHeight = prevRest ? prevRest.height : 0;
      highlightRef.current = { x, y, width, height, fromX, fromY, fromWidth, fromHeight, startedAt: performance.now() };
      lastHighlightRestRef.current = { x, y, width, height };

      if (!was_visible) {
        setHighlightOnly(true);
      }
      highlightTimeoutRef.current = window.setTimeout(() => {
        highlightRef.current = null;
        highlightTimeoutRef.current = null;
        // Functional form to read the live value — this effect has an empty
        // deps array, so a plain `highlightOnly` read here would be frozen
        // at whatever it was when the effect first ran (always `false`).
        setHighlightOnly((wasHighlightOnly) => {
          if (wasHighlightOnly) {
            renderActiveRef.current = false;
            hide();
          }
          return false;
        });
      }, HIGHLIGHT_DURATION_MS);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
      if (highlightTimeoutRef.current !== null) {
        window.clearTimeout(highlightTimeoutRef.current);
      }
    };
  }, []);

  // Reactively drives the click-through state from phase/highlightOnly —
  // one place deciding this instead of scattering ignore-cursor-events calls
  // across every transition site (submit, the quick-result listener, the
  // walkthrough listeners, etc.).
  useEffect(() => {
    if (highlightOnly) {
      // No interactive content at all in this state — always click-through.
      stopHoverWatch();
      setWindowIgnoreCursorEvents(true);
      return;
    }
    if (phase === "showing-result" || phase === "walkthrough-active") {
      startHoverWatch();
      return () => stopHoverWatch();
    }
    if (phase === "running") {
      // WP7.19 (actual fix — the WP7.10 comment this replaces claimed this
      // already worked, but the code below it set ignoreCursorEvents(false)
      // for "running" too, i.e. fully INTERACTIVE, which is backwards: that
      // makes this window swallow every click across the whole screen for
      // as long as a request is in flight — exactly "can't interact with my
      // computer while it's thinking." The puck's onClick/onContextMenu are
      // both explicitly gated to phase === "listening" only (see the puck
      // JSX below) — there is nothing clickable on screen during "running",
      // so unlike "listening" this phase has no reason to ever accept
      // input at all.
      stopHoverWatch();
      setWindowIgnoreCursorEvents(true);
      return;
    }
    // "listening" — the puck IS click/right-click interactive (stop
    // dictation, arm Draw mode) and follows the cursor everywhere, so
    // there's no FIXED region to hover-watch against the way showing-result/
    // walkthrough-active have — the whole window has to stay interactive
    // for the entire phase. A click landing elsewhere on screen while still
    // composing a prompt is the accepted trade-off this phase makes.
    stopHoverWatch();
    setWindowIgnoreCursorEvents(false);
  }, [phase, highlightOnly]);

  // ─── quick-result: the widget-mode run's progress/answer (WP7.4, ported
  // from the deleted src/result/ResultWidget.tsx) ─────────────────────────
  //
  // App.tsx (the main window) does the actual headless run via
  // runHeadlessTask and reports progress/results here purely by emitting
  // this event — this window never runs any agent logic itself. There is no
  // handshake to worry about: this listener is registered on mount, long
  // before any hotkey press could ever result in a `quick-result` emit.
  useEffect(() => {
    const unlistenPromise = listen<QuickResultPayload>("quick-result", (event) => {
      setResultPayload(event.payload);
      if (followUpInputRef.current) followUpInputRef.current.value = "";

      if (event.payload.status === "running") {
        setPhase("running");
        // submitWithRegion/submitWithAutoScreenshot hid this window right
        // before capturing a clean screenshot — bring it back now that the
        // pet (still chasing the cursor — see WP7.10) has something to show
        // again. Never steals focus.
        showWithoutFocus();
        return;
      }

      // done | error — WP7.10: THIS is where the pet actually freezes, at
      // wherever the spring animation currently is (not the raw cursor
      // target — the whole point of the spring is that those two can
      // differ), right as the card is about to grow in from that point.
      // cardEntered drives the grow/fade-in transition below (see the
      // showing-result JSX) — set false then flipped true a couple of
      // frames later so the CSS transition actually animates from the
      // "just arrived, tiny" state instead of skipping straight to full
      // size (a single rAF can still land before the browser's first paint
      // of the false state, hence the double rAF).
      stopCursorFollow();
      setPuckPos({ x: springPosRef.current.x, y: springPosRef.current.y });
      setPhase("showing-result");
      showWithoutFocus();
      setCardEntered(false);
      requestAnimationFrame(() => requestAnimationFrame(() => setCardEntered(true)));
      if (event.payload.status === "done") {
        const { selectedVoiceName, autoSpeak } = readVoiceSettings();
        if (autoSpeak) {
          const plain = event.payload.text
            .replace(/```[\s\S]*?```/g, "code block")
            .replace(/[#*`_~[\]()>]/g, "")
            .slice(0, 3000);
          speakText(plain, selectedVoiceName).catch((err) =>
            console.error("[quick-invoke] speakText failed:", err)
          );
        }
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // ─── Guided walkthroughs (WP7.4, new) ──────────────────────────────────
  //
  // App.tsx orchestrates step resolution/highlighting (it already has the
  // uia_list_elements/highlight_screen_rect pattern via the highlight_element
  // tool) — this window just renders whatever step it's told about and reports
  // advance/cancel intents back. See headlessRunner.ts/tools.ts/App.tsx for
  // the model-facing half of this feature.
  useEffect(() => {
    const unlistenStep = listen<WalkthroughStep>("quick-walkthrough-step", (event) => {
      // Same freeze-and-grow-in treatment as a normal answer (see the
      // quick-result listener's doc comment) — harmless no-ops on the
      // second+ step, since the pet is already frozen from step 1 by then.
      stopCursorFollow();
      setPuckPos({ x: springPosRef.current.x, y: springPosRef.current.y });
      setWalkthrough(event.payload);
      setPhase("walkthrough-active");
      showWithoutFocus();
      setCardEntered(false);
      requestAnimationFrame(() => requestAnimationFrame(() => setCardEntered(true)));
      // WP7.15: walkthrough steps never spoke at all — the quick-result
      // listener's auto-speak only fires on a normal "done" answer, and a
      // walkthrough goes through this entirely separate event instead, so
      // nothing ever called speakText for it. Same settings/stripping as a
      // normal answer, just for the step's instruction text.
      const { selectedVoiceName, autoSpeak } = readVoiceSettings();
      if (autoSpeak) {
        speakText(event.payload.instruction, selectedVoiceName).catch((err) =>
          console.error("[quick-invoke] walkthrough speakText failed:", err)
        );
      }
      void beginWalkthroughListening();
    });
    const unlistenDone = listen("quick-walkthrough-done", () => {
      cancelDictation(dictationSessionRef.current);
      dictationSessionRef.current = null;
      setMicState("idle");
      setWalkthrough(null);
      renderActiveRef.current = false;
      hide();
    });
    return () => {
      void unlistenStep.then((unlisten) => unlisten());
      void unlistenDone.then((unlisten) => unlisten());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
  // show (via onFocusChanged/quick-invoke-open below) is what actually fixes
  // it — the mount-time call and the resize listener just keep it correct
  // across whatever else can change the viewport afterward.
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

  // Focus handling. A fresh invocation's reset logic now lives ENTIRELY in
  // the quick-invoke-open effect above (see its doc comment for why) — this
  // effect only re-measures the canvas on focus-gain (harmless and
  // idempotent in any phase) and decides whether losing focus should hide
  // the window, which now depends on `phase`, not just whether dictation is
  // live.
  useEffect(() => {
    const unlistenPromise = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) {
        // Rust may have just resized this window to a different monitor's
        // full bounds before showing it — re-measure now, not just on mount,
        // or a second invocation on a different monitor (or after a
        // resolution change) silently breaks drawing again. See sizeCanvas's
        // doc comment above.
        sizeCanvas();
        // ...and again after a frame. The focus event can arrive before the
        // webview has laid out at the new window size, in which case the
        // measurement above is of the OLD box — which is precisely how ink
        // ends up offset from the cursor. Re-measuring once layout has
        // settled costs nothing and makes the common case self-correcting.
        requestAnimationFrame(sizeCanvas);
      } else if (dictationActiveRef.current) {
        // Losing focus because a mic session is live (e.g. a WebView2
        // permission prompt, or the mic button click itself moving focus
        // without the user meaning to dismiss the overlay) — never hide.
      } else if (
        phaseRef.current === "running" ||
        phaseRef.current === "showing-result" ||
        phaseRef.current === "walkthrough-active"
      ) {
        // This is the behavior the now-deleted `result` window used to exist
        // as a SEPARATE window purely to get: surviving the user clicking
        // back into whatever app they were using while a run is in flight or
        // an answer/walkthrough is on screen.
      } else {
        // Genuinely idle (typing with no active dictation, or nothing to
        // show) — pause the render loop to save battery and hide, matching
        // the overlay's original blur-to-dismiss behavior.
        renderActiveRef.current = false;
        hide();
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // ─── Render loop: ink + highlight ring ──────────────────────────────────
  //
  // Redraws every frame (not just on pointer events) so the ink stays exact
  // and the highlight ring's pulse animates continuously. Runs whenever
  // renderActiveRef is true — which now covers every VISIBLE phase, not just
  // "listening" — so the canvas is always correctly cleared/repainted rather
  // than possibly showing a stale frame from before the window was last
  // hidden (e.g. the hide-to-capture step in submitWithRegion).
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

      // ─── Puck spring-physics + idle sway + waveform (WP7.8; WP7.10) ────
      //
      // Piggybacks on this already-running loop rather than a second rAF
      // loop duplicating the same per-frame delta-time bookkeeping. Active
      // during "listening" AND "running" — the pet keeps chasing the cursor
      // the whole time a request is thinking, not just while composing it
      // (WP7.10 removed the separate stationary loading pill entirely; see
      // that phase's own JSX below). Reading phaseRef, not `phase`, since
      // this whole effect is registered once with an empty deps array (see
      // phaseRef's own doc comment for why a direct state read here would
      // be permanently stale).
      const nowMs = performance.now();
      const lastFrameMs = lastSpringFrameRef.current;
      lastSpringFrameRef.current = nowMs;
      if (
        (phaseRef.current === "listening" || phaseRef.current === "running" || highlightTravelRef.current !== null) &&
        puckElRef.current
      ) {
        // Clamp dt: a dropped frame (tab backgrounded, a hitch) must never
        // inject one huge step into the spring — that reads as a teleport,
        // exactly what the spring exists to avoid.
        const dt = lastFrameMs === null ? 1 / 60 : Math.min((nowMs - lastFrameMs) / 1000, 0.05);
        const target = targetPosRef.current;
        const spring = springPosRef.current;
        const vel = velocityRef.current;
        const ax = PUCK_SPRING_STIFFNESS * (target.x - spring.x) - PUCK_SPRING_DAMPING * vel.x;
        const ay = PUCK_SPRING_STIFFNESS * (target.y - spring.y) - PUCK_SPRING_DAMPING * vel.y;
        vel.x += ax * dt;
        vel.y += ay * dt;
        spring.x += vel.x * dt;
        spring.y += vel.y * dt;

        // Squash-and-stretch + rotate-toward-velocity — see
        // PUCK_MAX_STRETCH's doc comment for the shape of this curve.
        const speed = Math.hypot(vel.x, vel.y);
        const stretchT = speed / (speed + PUCK_STRETCH_HALF_SPEED);
        const stretch = 1 + (PUCK_MAX_STRETCH - 1) * stretchT;
        const squash = 1 / stretch;
        if (speed > PUCK_MIN_ROTATE_SPEED_PX_S) {
          puckAngleDegRef.current = Math.atan2(vel.y, vel.x) * (180 / Math.PI);
        }

        // Idle "breathing" sway, always on (not just when stationary) —
        // subtle enough not to read as jitter, but enough that the puck
        // never looks perfectly rigid even at rest.
        const swayT = nowMs / 1000;
        const swayX = Math.sin(swayT * PUCK_SWAY_SPEED) * PUCK_SWAY_AMPLITUDE_PX;
        const swayY = Math.cos(swayT * PUCK_SWAY_SPEED * 0.7) * PUCK_SWAY_AMPLITUDE_PX * 0.6;
        const renderedX = spring.x + swayX;
        const renderedY = spring.y + swayY;

        puckElRef.current.style.left = `${renderedX}px`;
        puckElRef.current.style.top = `${renderedY}px`;
        // translate(-50%,-50%) still recenters the (rotated, scaled) box on
        // that point — percentage translate resolves against the element's
        // own untransformed layout size, and rotate/scale below both pivot
        // around the default center origin, so composing them in this order
        // keeps the puck anchored exactly where it always was, just leaning
        // into its own motion now.
        puckElRef.current.style.transform =
          `translate(-50%, -50%) rotate(${puckAngleDegRef.current}deg) scale(${stretch}, ${squash})`;
        if (puckTextRef.current) {
          const dotSize = micStateRef.current === "recording" ? PUCK_RECORDING_SIZE_PX : PUCK_IDLE_SIZE_PX;
          puckTextRef.current.style.left = `${renderedX + dotSize / 2 + 8}px`;
          puckTextRef.current.style.top = `${renderedY}px`;
        }

        if (micStateRef.current === "recording") {
          const history = levelHistoryRef.current;
          for (let i = 0; i < waveBarRefs.current.length; i++) {
            const bar = waveBarRefs.current[i];
            if (!bar) continue;
            const level = history[i] ?? 0;
            // Floored so a near-silent bar still reads as "present," not
            // invisible — a waveform that flatlines to nothing looks broken,
            // not calm.
            const heightPct = Math.min(100, 22 + level * 260);
            bar.style.height = `${heightPct}%`;
          }
        }
      }

      // WP7.13: has the pet finished traveling to a highlight_element
      // target? Drop the ring — growing from a zero-size point at the
      // rect's own top-left, per the existing glide-render code below,
      // rather than traveling in from elsewhere (the PET already made that
      // trip; the ring just needs to appear where it landed). Guarded on
      // `!highlightRef.current` so this only ever fires once per travel —
      // once the ring exists, this check is false on every later frame.
      const travel = highlightTravelRef.current;
      if (travel && !highlightRef.current && nowMs - travel.travelStartedAt >= HIGHLIGHT_TRAVEL_MS) {
        highlightRef.current = {
          x: travel.rectX, y: travel.rectY, width: travel.rectWidth, height: travel.rectHeight,
          fromX: travel.rectX, fromY: travel.rectY, fromWidth: 0, fromHeight: 0,
          startedAt: nowMs,
        };
        lastHighlightRestRef.current = { x: travel.rectX, y: travel.rectY, width: travel.rectWidth, height: travel.rectHeight };
        if (highlightTimeoutRef.current !== null) {
          window.clearTimeout(highlightTimeoutRef.current);
        }
        highlightTimeoutRef.current = window.setTimeout(() => {
          highlightRef.current = null;
          highlightTimeoutRef.current = null;
          // Only NOW let cursor-follow resume — the pet stays put next to
          // its own ring for the whole display duration rather than
          // wandering off while the ring it just placed is still showing.
          highlightTravelRef.current = null;
        }, HIGHLIGHT_DURATION_MS);
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

      const highlight = highlightRef.current;
      if (highlight) {
        // Same rect-relative translation as strokes above — the payload
        // already arrives in this window's CSS-pixel viewport space (see
        // highlight_screen_rect's doc comment in tray.rs), so no further
        // conversion is needed here.
        const elapsed = performance.now() - highlight.startedAt;

        // The glide: interpolate from the starting box (the puck, or wherever
        // the ring last rested) to the target box over HIGHLIGHT_GLIDE_MS,
        // eased out (fast start, gentle arrival) so it reads as the ring
        // TRAVELING to the thing being pointed at, not just appearing there.
        const glideT = Math.min(1, elapsed / HIGHLIGHT_GLIDE_MS);
        const eased = 1 - Math.pow(1 - glideT, 3);
        const curX = highlight.fromX + (highlight.x - highlight.fromX) * eased;
        const curY = highlight.fromY + (highlight.y - highlight.fromY) * eased;
        const curWidth = Math.max(0, highlight.fromWidth + (highlight.width - highlight.fromWidth) * eased);
        const curHeight = Math.max(0, highlight.fromHeight + (highlight.height - highlight.fromHeight) * eased);

        // Only start the breathing pulse once the glide has actually
        // arrived — starting it mid-flight (elapsed measured from t=0) would
        // visually fight the glide's own motion. Full opacity while gliding
        // reads as "moving with purpose", not an alert/error indicator.
        const pulse = glideT >= 1 ? 0.55 + 0.35 * Math.sin((elapsed - HIGHLIGHT_GLIDE_MS) / 320) : 1;

        ctx!.save();
        ctx!.lineWidth = 3;
        ctx!.strokeStyle = `rgba(${STROKE_RGB}, ${pulse.toFixed(3)})`;
        const rx = curX - rect.left;
        const ry = curY - rect.top;
        const radius = Math.max(0, Math.min(8, curWidth / 2, curHeight / 2));
        if (typeof ctx!.roundRect === "function") {
          ctx!.beginPath();
          ctx!.roundRect(rx, ry, curWidth, curHeight, radius);
          ctx!.stroke();
        } else {
          ctx!.strokeRect(rx, ry, curWidth, curHeight);
        }
        ctx!.restore();
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
  // rendering surface. This is why the puck/card need their own
  // onPointerDown={stopPropagation}: a pointerdown that lands on them (which
  // sit visually on top of the canvas) still bubbles up to these root
  // handlers unless they stop it, which would otherwise start a new stroke
  // "under" them. Once a stroke IS in progress from the canvas area,
  // setPointerCapture below keeps subsequent move/up events targeted at the
  // root regardless of the pointer wandering elsewhere, so only pointerdown
  // needs the guard.
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
   *  (capture only happens at submit time), so unlike Escape (which also
   *  clears a stashed region) this only needs to clear local drawing state. */
  function handleContextMenu(e: React.MouseEvent<HTMLDivElement>): void {
    e.preventDefault();
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
    //
    // WP7.12 dead end, noted so it isn't retried: SetWindowDisplayAffinity +
    // WDA_EXCLUDEFROMCAPTURE looked like it would remove this hide step
    // entirely, but Windows renders an excluded window's rectangle as SOLID
    // BLACK in the captured frame rather than making it transparent to
    // whatever's behind it — for a window covering the whole monitor
    // (this one), that means every screenshot would come back entirely
    // black while the overlay is open, which is exactly when captures
    // happen. That's a correctness-breaking regression (OCR/vision would
    // see nothing), not an improvement, so it was reverted before shipping.
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

    // Re-show right here, before emitting — don't wait for the round-trip
    // through App.tsx (workspace check, OCR peek, "running" quick-result
    // event) just to bring the pet back. The capture itself is already
    // done by this point, so there's no clean-frame reason left to stay
    // hidden; this shrinks the visible gap down to just the hide+settle+
    // capture time instead of that plus a full IPC round-trip.
    showWithoutFocus();

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

  /**
   * No ink was drawn this session, but the question may still implicitly
   * refer to whatever's on screen (see QUICK_INVOKE_SCREEN_HINT in App.tsx —
   * "if this refers to something visible on screen, call take_screenshot").
   * Pre-captures the FULL screen and stashes it via the same PENDING_REGION
   * mechanism capture_region already uses for a circled region, so it's
   * ready the moment the agent decides to call take_screenshot, instead of
   * that later call grabbing a fresh (possibly stale-by-then, or
   * overlay-still-animating) screenshot of its own.
   *
   * A deliberate near-duplicate of submitWithRegion's hide→wait→capture→emit
   * ordering above, rather than a shared/generalized implementation — the two differ
   * in exactly one meaningful way (a computed stroke bbox vs. the full
   * viewport) but the RACE-AVOIDANCE ordering, error handling, and
   * hasRegion semantics are each subtly different (this path always emits
   * hasRegion:false — no actual circling happened, so
   * QUICK_INVOKE_REGION_PREAMBLE's "the user circled a specific region"
   * wording would be wrong here). Keeping them separate means neither
   * function's logic has to branch on which case it's handling, so the
   * well-tested circling path above stays exactly as it was.
   */
  async function submitWithAutoScreenshot(prompt: string, mode: Mode): Promise<void> {
    // Hide BEFORE capturing, same reasoning as submitWithRegion: the scrim
    // and this window's own pixels must never end up in the captured frame.
    try {
      await getCurrentWindow().hide();
    } catch (err) {
      console.error("[quick-invoke] hide before auto-capture failed:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, 140));

    // Full window bounds in physical pixels — this window covers the whole
    // monitor (see the file-level comment), so window.innerWidth/Height IS
    // the screen size, same as submitWithRegion's own clamping already
    // assumes. capture_region with a full-frame rectangle is just a normal
    // (uncropped) capture — no new Rust code needed, and it stashes into
    // PENDING_REGION exactly like a real circled region does.
    const dpr = window.devicePixelRatio || 1;
    try {
      await invoke("capture_region", {
        x: 0,
        y: 0,
        width: Math.round(window.innerWidth * dpr),
        height: Math.round(window.innerHeight * dpr),
      });
    } catch (err) {
      // Best-effort only: a failed pre-capture just means take_screenshot
      // (if the agent calls it at all) falls through to its own fresh
      // full-screen capture instead of the stash — never worth blocking or
      // even flagging the submit over.
      console.error("[quick-invoke] auto full-screen capture failed:", err);
    }

    // Re-show right here, before emitting — see submitWithRegion's identical
    // comment for why (shrinks the visible gap to just hide+settle+capture
    // instead of that plus a full round-trip through App.tsx).
    showWithoutFocus();

    // Same ordering guarantee as submitWithRegion: emit only after the
    // capture attempt has resolved, so a race with the agent's own
    // take_screenshot call can never win against an empty stash.
    try {
      await emit("quick-invoke", { prompt, mode, hasRegion: false });
    } catch (err) {
      console.error("[quick-invoke] emit failed:", err);
    }
  }

  /**
   * Shared submit path — extracted from the Enter-key handler so
   * stopDictationAndInsert can also auto-submit once a transcript completes
   * (see its own doc comment), not just insert text for the user to review
   * and separately press Enter on. `mode` defaults to "widget" (background,
   * reported via this same window's "showing-result" phase): a hands-free
   * voice submission has no Ctrl/Cmd-Enter equivalent for "chat" mode, so
   * anything triggered without an explicit keyboard modifier goes to the
   * background widget path.
   */
  function submit(promptText: string, mode: Mode = "widget"): void {
    if (phaseRef.current !== "listening") return; // already submitted this session
    const trimmed = promptText.trim();
    if (!trimmed) {
      resetForNextPrompt();
      hide();
      return;
    }
    // WP7.10: switch to "running" WITHOUT freezing the puck — it keeps
    // chasing the cursor through the whole thinking phase (see the
    // broadened spring-physics gate in the render loop above), only
    // freezing once the actual answer/walkthrough arrives (see the
    // quick-result/quick-walkthrough-step listeners for where
    // stopCursorFollow()+setPuckPos() now happen instead).
    setPhase("running");
    if (hasInk) {
      // submitWithRegion hides the window itself, BEFORE capturing — see
      // its doc comment. No extra hide() call is needed here.
      void submitWithRegion(trimmed, mode)
        .catch((err) => console.error("[quick-invoke] submitWithRegion failed:", err))
        .finally(() => {
          resetForNextPrompt();
        });
    } else {
      // No ink drawn this session — pre-capture the full screen and stash it
      // (see submitWithAutoScreenshot's doc comment) so screen context is
      // ready if the agent decides it's relevant, without requiring the user
      // to circle anything. submitWithAutoScreenshot hides the window itself,
      // BEFORE capturing — no extra hide() call is needed here, same as the
      // hasInk branch above.
      void submitWithAutoScreenshot(trimmed, mode)
        .catch((err) => console.error("[quick-invoke] submitWithAutoScreenshot failed:", err))
        .finally(() => {
          resetForNextPrompt();
        });
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Escape") {
      // Handled by the window-level listener so Escape works no matter what
      // has focus. Swallow it here only so the input doesn't also act on it.
      e.preventDefault();
      return;
    }
    // Ctrl/Cmd+M is handled by the window-level listener too (it has to work
    // from the collapsed puck, which has no input to attach a handler to) —
    // do NOT also handle it here, or a keypress while this input IS focused
    // would toggle dictation twice (start-then-immediately-stop).
    if (e.key === "Enter") {
      e.preventDefault();
      // Plain Enter runs in the background (WP5.4) — the whole point of
      // quick-invoke is to not get yanked out of whatever app you're
      // currently in. Ctrl/Cmd+Enter is the escape hatch for when you
      // actually want the full chat window.
      const mode: Mode = e.ctrlKey || e.metaKey ? "chat" : "widget";
      submit(text, mode);
    }
  }

  /** Clamped top-left for a box of the given size, centered on the frozen
   *  puckPos — used by every "frozen" phase's card/pill so it never renders
   *  partially off the monitor the puck happened to freeze near the edge of. */
  function clampedTopLeft(width: number, height: number): { left: number; top: number } {
    const left = Math.max(
      EDGE_MARGIN_PX,
      Math.min(window.innerWidth - width - EDGE_MARGIN_PX, puckPos.x - width / 2),
    );
    const top = Math.max(
      EDGE_MARGIN_PX,
      Math.min(window.innerHeight - height - EDGE_MARGIN_PX, puckPos.y - height / 2),
    );
    return { left, top };
  }

  return (
    <div
      className="w-screen h-screen relative"
      // The scrim is deliberate and load-bearing twice over when shown: it
      // visually signals "you're in draw mode", and — just as importantly —
      // it guarantees this transparent, click-through-if-empty window
      // actually has painted pixels everywhere, so the OS routes pointer
      // events to it instead of whatever's behind it on the desktop (ink
      // needs the whole window hit-testable while armed). Every OTHER
      // state — listening, running, showing a result, a walkthrough, or a
      // highlight-only ring — is transparent by default (WP7.4's biggest
      // visual departure from the old always-dimmed search bar): the puck/
      // card/ring are the only painted pixels, and clicks everywhere else
      // fall through to whatever the user is actually working in.
      style={{ background: drawMode && phase === "listening" ? "rgba(0,0,0,0.06)" : "transparent" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onContextMenu={handleContextMenu}
    >
      {/* Fullscreen drawing surface, below the puck/card in z-order. Pure
          rendering — no handlers of its own; see the "Drawing input" comment
          above for why the root div owns pointer events instead. */}
      {/* Cursor is left at the OS default always. A crosshair here read as
          the app having taken over the pointer, which is exactly the wrong
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

      {!highlightOnly && (phase === "listening" || phase === "running" || phase === "walkthrough-active") && (
        <>
          {/* The dot/waveform — its own imperatively-positioned element
              (puckElRef; see the spring-physics block in the render loop
              above), independent of the text beside it so the text
              growing/shrinking while typing never shifts the dot's own
              centering point. No visible button row anymore (per the
              product decision behind this rework: "a little cursor," not a
              bar) — left-click toggles dictation, right-click arms/disarms
              Draw mode. WP7.10: also renders through "running" (the pet
              keeps chasing the cursor while thinking, instead of a separate
              stationary loading pill) — click/right-click are disabled in
              that phase specifically, since there's nothing to dictate or
              draw for a request that's already been submitted. */}
          <div
            ref={puckElRef}
            className="absolute z-10 flex items-center justify-center"
            // WP7.16: the container's hit area used to be exactly as small
            // as whatever was visually rendered inside it (the 20px dot, or
            // the waveform box) — with zero margin for error. Combined with
            // the dot's deliberate spring lag (it doesn't sit exactly under
            // the cursor, by design — that's what makes it feel alive), a
            // right-click aimed "at the dot" would often land on the
            // transparent background just beside it instead, which silently
            // does nothing (no ink to clear). A fixed minimum hit area,
            // centered on the same point regardless of what's drawn inside
            // it, gives real room for error without changing how anything
            // actually looks.
            style={{ left: 0, top: 0, transform: "translate(-50%, -50%)", minWidth: 44, minHeight: 44 }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={phase === "listening" ? () => void toggleDictation() : undefined}
            onContextMenu={
              phase === "listening"
                ? (e) => {
                    e.preventDefault();
                    // Without this, the event bubbles to the root div's own
                    // onContextMenu (handleContextMenu), which clears any
                    // drawn ink — right-clicking the puck to DISARM Draw
                    // mode after actually drawing something would otherwise
                    // wipe it out as an unintended side effect of the same
                    // click.
                    e.stopPropagation();
                    setDrawMode((on) => !on);
                  }
                : (e) => e.preventDefault()
            }
            title={
              phase === "walkthrough-active"
                ? "Walkthrough in progress"
                : phase === "running"
                ? "Thinking…"
                : micState === "transcribing"
                ? "Transcribing…"
                : drawMode
                ? "Drawing armed — right-click to stop"
                : micState === "recording"
                ? "Listening — click to stop, right-click to draw a region"
                : "Click to dictate, right-click to draw a region"
            }
          >
            {micState === "transcribing" ? (
              // WP7.11: the transcribing spinner used to live in the
              // separate text-row element, offset to the dot's right —
              // reported as looking wrong ("not on top of the circle, to
              // the right"). It now replaces the dot's own content
              // directly, same size/position as the idle dot, so the
              // spinner reads as "the dot itself is working" rather than a
              // separate indicator floating nearby.
              <div
                className="flex items-center justify-center"
                style={{
                  width: PUCK_IDLE_SIZE_PX,
                  height: PUCK_IDLE_SIZE_PX,
                  borderRadius: "9999px",
                  background: BUTTON_DARK,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
                }}
              >
                <Loader2 className="animate-spin text-white" style={{ width: PUCK_IDLE_SIZE_PX * 0.6, height: PUCK_IDLE_SIZE_PX * 0.6 }} />
              </div>
            ) : micState === "recording" ? (
              // Waveform: live mic level (dictation.ts's onLevel, via
              // levelHistoryRef), bars updated imperatively every frame in
              // the render loop above — the "morphs into the waveform for
              // mic" state.
              <div
                className="flex items-end justify-center gap-[2px]"
                style={{
                  width: PUCK_RECORDING_SIZE_PX,
                  height: PUCK_RECORDING_SIZE_PX,
                  borderRadius: "9999px",
                  background: BUTTON_DARK,
                  padding: "6px 5px",
                  boxShadow: hasInk
                    ? `0 0 0 2px rgb(${STROKE_RGB}), 0 4px 12px rgba(0,0,0,0.25)`
                    : "0 4px 12px rgba(0,0,0,0.25)",
                }}
              >
                {Array.from({ length: WAVEFORM_BAR_COUNT }).map((_, i) => (
                  <div
                    key={i}
                    ref={(el) => {
                      waveBarRefs.current[i] = el;
                    }}
                    className="rounded-full bg-white"
                    style={{ width: 2, height: "22%" }}
                  />
                ))}
              </div>
            ) : (
              // Idle dot — "a little cursor," not a button. drawMode gets
              // the ink color so it's visible at a glance that drawing is
              // armed even at this size.
              <div
                className={phase === "running" ? "animate-pulse" : ""}
                style={{
                  width: PUCK_IDLE_SIZE_PX,
                  height: PUCK_IDLE_SIZE_PX,
                  borderRadius: "9999px",
                  background: drawMode ? `rgb(${STROKE_RGB})` : BUTTON_DARK,
                  boxShadow:
                    hasInk && !drawMode
                      ? `0 0 0 2px rgb(${STROKE_RGB}), 0 4px 12px rgba(0,0,0,0.25)`
                      : "0 4px 12px rgba(0,0,0,0.25)",
                }}
              />
            )}
          </div>

          {/* Typed/transcribed text — plain, no background/border/pill (per
              product decision: "make it like a little cursor," not a search
              bar). Always mounted while listening, even when empty, so it
              can hold focus and take keystrokes the instant the overlay
              opens — an empty, borderless input has no visible footprint of
              its own, so there's nothing that needs a click to "reveal" it
              the way the old capsule did. Unmounted entirely once "running"
              starts — the question's already been asked, so stale text
              floating next to the "thinking" dot would just be clutter. */}
          {phase === "listening" && (
            <div
              ref={puckTextRef}
              className="absolute z-10 flex items-center"
              style={{ left: 0, top: 0, transform: "translateY(-50%)" }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <input
                ref={inputRef}
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={micError ?? regionError ?? ""}
                autoFocus
                disabled={micState === "transcribing"}
                className={
                  "bg-transparent border-0 outline-none text-sm font-sans disabled:opacity-60 text-foreground " +
                  (micError || regionError ? "placeholder:text-destructive" : "placeholder:text-muted-foreground")
                }
                style={{ width: PUCK_TEXT_MAX_WIDTH_PX, maxWidth: "70vw" }}
              />
            </div>
          )}
        </>
      )}

      {!highlightOnly && phase === "showing-result" && resultPayload && resultPayload.status !== "running" && (
        <div
          ref={frozenBoxRef}
          className="absolute z-10"
          style={{
            ...(dragPosRef.current ?? clampedTopLeft(CARD_WIDTH_PX, CARD_HEIGHT_PX)),
            width: CARD_WIDTH_PX,
            height: CARD_HEIGHT_PX,
            // WP7.10: "glides to show a position and then shows the
            // window" — the card grows in from the pet's own frozen
            // position instead of just popping into existence. cardEntered
            // flips true a couple of frames after mount (see the
            // quick-result listener) so this transition actually has a
            // "from" state to animate away from.
            transformOrigin: "center",
            transform: cardEntered ? "scale(1)" : "scale(0.3)",
            opacity: cardEntered ? 1 : 0,
            transition: "transform 260ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 200ms ease",
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
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
              style={{ cursor: frozenDragRef.current ? "grabbing" : "grab" }}
              onMouseDown={beginFrozenDrag}
            >
              <div className="flex-1 min-w-0 truncate text-[11px] text-muted-foreground font-sans">
                {resultPayload.prompt}
              </div>
              <button
                type="button"
                onClick={() => {
                  // "Open in chat" hands the conversation over as-is —
                  // followUp is deliberately "" so App.tsx seeds the new
                  // conversation and stops there (no follow-up to send).
                  emitQuickFollowup(resultPayload.prompt, resultPayload.text, "");
                  closeWithExitAnimation();
                }}
                className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground font-sans whitespace-nowrap"
              >
                Open in chat →
              </button>
              <button
                type="button"
                onClick={() => closeWithExitAnimation()}
                aria-label="Close"
                className="shrink-0 w-5 h-5 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
              >
                ✕
              </button>
            </div>
            {/* WP7.6 debug timing — total round-trip time, so slowness is
                visible at a glance without opening DevTools. Full per-round
                breakdown is console.log'd instead (see App.tsx's
                handleQuickInvokeWidget) — too detailed for this small card. */}
            {resultPayload.durationMs !== undefined && (
              <div className="px-4 pb-1.5 -mt-1 text-[10px] text-muted-foreground font-mono shrink-0">
                ⏱ {(resultPayload.durationMs / 1000).toFixed(1)}s
              </div>
            )}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 text-sm font-sans">
              {/* Wide children (long code fences, display-mode KaTeX) must
                  scroll horizontally within this fixed-width card instead of
                  stretching it or getting clipped. */}
              <div
                className={
                  (resultPayload.status === "error" ? "text-destructive" : "text-foreground") +
                  " [&_pre]:overflow-x-auto [&_.katex-display]:overflow-x-auto" +
                  " [&_ol]:list-decimal [&_ul]:list-disc [&_ol]:pl-5 [&_ul]:pl-5 [&_li]:my-0.5" +
                  " [&_h1]:font-medium [&_h2]:font-medium [&_h3]:font-medium [&_h1]:mt-2 [&_h2]:mt-2 [&_h3]:mt-2" +
                  " [&_p]:my-1.5 [&_code]:font-mono [&_code]:text-[0.9em]"
                }
              >
                <Markdown>{resultPayload.text}</Markdown>
              </div>
            </div>
            <div className="shrink-0 px-4 pb-3 pt-1">
              <input
                ref={followUpInputRef}
                type="text"
                placeholder="Ask a follow-up…"
                autoComplete="off"
                spellCheck={false}
                onPointerDown={() => {
                  // This window is created with focus:false and is
                  // always-on-top/skipTaskbar — showWithoutFocus() never
                  // gives it keyboard focus. Force it explicitly so the very
                  // first keystroke after clicking actually lands here.
                  getCurrentWindow()
                    .setFocus()
                    .catch((err) => console.error("[quick-invoke] setFocus failed:", err));
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  const value = e.currentTarget.value.trim();
                  if (!value) return;
                  emitQuickFollowup(resultPayload.prompt, resultPayload.text, value);
                  hide();
                }}
                className="w-full text-[12px] font-sans px-3 py-2 rounded-full outline-none text-foreground placeholder:text-muted-foreground"
                style={{ background: "var(--muted)", border: "1px solid rgba(0,0,0,0.08)" }}
              />
            </div>
          </div>
        </div>
      )}

      {!highlightOnly && phase === "walkthrough-active" && walkthrough && (
        <div
          ref={frozenBoxRef}
          className="absolute z-10"
          style={{
            ...(dragPosRef.current ?? clampedTopLeft(WALKTHROUGH_WIDTH_PX, WALKTHROUGH_MAX_HEIGHT_PX)),
            width: WALKTHROUGH_WIDTH_PX,
            maxHeight: WALKTHROUGH_MAX_HEIGHT_PX,
            transformOrigin: "center",
            transform: cardEntered ? "scale(1)" : "scale(0.3)",
            opacity: cardEntered ? 1 : 0,
            transition: "transform 260ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 200ms ease",
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div
            className="flex flex-col overflow-hidden"
            style={{
              borderRadius: "16px",
              background: "var(--card)",
              border: "1px solid rgba(0,0,0,0.05)",
              boxShadow: "0 8px 60px rgba(0,0,0,0.1), 0 2px 8px rgba(0,0,0,0.05)",
              maxHeight: WALKTHROUGH_MAX_HEIGHT_PX,
            }}
          >
            {/* Drag handle scoped to just this header row, not the whole
                box — dragging used to grab anywhere including the
                instruction text itself, which would now fight with that
                text's own scroll-drag below. Mirrors the result card's
                identical header-only drag handle. */}
            <div
              className="shrink-0 text-[11px] text-muted-foreground font-sans px-4 pt-3 pb-1.5"
              style={{ cursor: frozenDragRef.current ? "grabbing" : "grab" }}
              onMouseDown={beginFrozenDrag}
            >
              Step {walkthrough.index + 1}/{walkthrough.total}
              {micState === "recording" ? " — say “next” or “done”" : ""}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-4 text-sm font-sans text-foreground">
              {walkthrough.instruction}
            </div>
            <div className="shrink-0 flex items-center gap-3 px-4 py-2.5">
              <button
                type="button"
                onClick={advanceWalkthrough}
                className="text-[11px] text-muted-foreground hover:text-foreground font-sans"
              >
                Next →
              </button>
              <button
                type="button"
                onClick={cancelWalkthrough}
                className="text-[11px] text-muted-foreground hover:text-foreground font-sans"
              >
                Cancel (Esc)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
