/**
 * Local offline dictation (WP6.3): mic capture → base64 → Rust
 * `transcribe_audio_base64` (reuses the same faster-whisper pipeline as video
 * transcription). No React, no stores — ChatInput owns the UI state machine
 * (idle/recording/transcribing) and calls into this module for the mechanics.
 *
 * This is Tauri-only. In plain browser dev mode, ChatInput keeps using the
 * existing Web Speech API path instead of this module.
 */

// Tauri invoke shim — mirrors the pattern already used in
// src/lib/fileSystem.ts and src/components/AppSettings.tsx.
async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__;
  if (!tauri) throw new Error("Not in Tauri desktop mode");
  const core = (tauri as Record<string, unknown>).core as {
    invoke?: (cmd: string, args?: unknown) => Promise<T>;
  };
  if (typeof core?.invoke !== "function") throw new Error("Tauri core.invoke unavailable");
  return core.invoke(cmd, args);
}

/** Maps a MediaRecorder Blob mime type to the extension allowlist the Rust
 * side (`transcribe.rs` `ALLOWED_DICTATION_EXTS`) accepts. Defaults to
 * "webm" — Chromium/WebView2's most common MediaRecorder output — for any
 * mime type not explicitly recognized. */
function mimeToExt(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower.includes("webm")) return "webm";
  if (lower.includes("ogg")) return "ogg";
  if (lower.includes("wav")) return "wav";
  if (lower.includes("mp4")) return "mp4";
  if (lower.includes("m4a") || lower.includes("aac")) return "m4a";
  return "webm";
}

/** Reads a Blob as a DataURL and strips the "data:...;base64," prefix,
 * mirroring `fileToBase64` in src/lib/imageUtils.ts (that one takes a File;
 * this takes a Blob — MediaRecorder's output isn't a File). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1];
      if (!base64) {
        reject(new Error("Failed to extract base64 data from recording"));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
}

/** Stops every track on a stream so the OS mic indicator turns off. Forgetting
 * this leaves the mic hot after recording ends — a privacy problem, not a
 * cosmetic one — so every exit path in this module (success, error, cancel)
 * routes through this call. */
function stopTracks(stream: MediaStream): void {
  stream.getTracks().forEach((t) => t.stop());
}

export interface DictationSession {
  /** Stop recording, transcribe what was captured, and return the trimmed
   * transcript text. Always stops mic tracks before returning or throwing.
   * `whisperModel` is passed through to `transcribe_audio_base64` — this
   * module owns no store, so the caller (ChatInput, reading
   * useSettingsStore) supplies it here rather than at `startDictation`. */
  stop: (whisperModel?: string) => Promise<string>;
  /** Stop recording and release the mic WITHOUT transcribing — used by
   * `cancelDictation` below. Synchronous best-effort; safe to call even if
   * the recorder already stopped. */
  cancel: () => void;
}

/** True if this environment can plausibly support local dictation capture
 * (getUserMedia + MediaRecorder both present). Does not guarantee permission
 * will be granted — that's only known once `startDictation()` is attempted. */
export function isDictationSupported(): boolean {
  return (
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof window.MediaRecorder !== "undefined"
  );
}

/** RMS (0-1 scale) below this is treated as silence. Tuned loosely — this is
 *  a "stop listening once you've clearly stopped talking" heuristic, not a
 *  precise VAD; a false trigger just means the user has to press Enter/click
 *  the mic again, not a lost recording (the buffered audio up to that point
 *  is still transcribed normally). */
const SILENCE_RMS_THRESHOLD = 0.02;

export interface StartDictationOptions {
  /**
   * Fires once, at most, when sustained silence follows detected speech —
   * intended for an auto-stop-on-silence UX (see QuickInvoke.tsx). Never
   * fires before the session has seen at least one above-threshold sample,
   * so a session that opens into silence (permission prompt still up,
   * thinking pause before speaking) doesn't immediately fire with nothing
   * recorded yet. Purely a notification — this module never calls `stop()`
   * itself; the caller decides what to do (and can ignore this entirely by
   * not passing it, preserving today's manual-stop-only behavior).
   */
  onSilence?: () => void;
  /** Continuous below-threshold duration (ms) required to fire onSilence. */
  silenceTimeoutMs?: number;
  /**
   * Fires on every animation frame with the current RMS amplitude (0-1) —
   * for a live waveform/level visualization (QuickInvoke.tsx's listening
   * puck). Purely observational, like onSilence; never affects the
   * recording itself. Sharing one rAF loop with the silence-detection read
   * below (rather than a second independent poll) means there's only ever
   * one place reading the analyser.
   */
  onLevel?: (rms: number) => void;
}

/** Begin capturing microphone audio. Resolves once the recorder is actively
 * running; rejects (e.g. with a `NotAllowedError` DOMException if the user
 * denies mic permission) before anything is recorded. */
export async function startDictation(opts: StartDictationOptions = {}): Promise<DictationSession> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream);
  } catch (e) {
    // Constructing the recorder failed (e.g. no supported mime type) —
    // nothing was recorded, but the stream is already open, so it must still
    // be released here.
    stopTracks(stream);
    throw e;
  }

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e: BlobEvent) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const stopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve();
    recorder.onerror = (e: Event) => reject(new Error(`MediaRecorder error: ${String(e)}`));
  });

  recorder.start();

  // Silence-detection auto-stop + live level reporting (opt-in via
  // opts.onSilence/opts.onLevel — see their doc comments), sharing ONE
  // AudioContext/AnalyserNode/rAF loop tapping the same stream. Entirely
  // independent of the MediaRecorder above, so a failure here (e.g.
  // AudioContext unsupported) can never affect the actual recording.
  // rAF instead of the previous 200ms setInterval: silence-detection only
  // needs coarse timing, but onLevel is meant to drive a smooth
  // frame-synced waveform, and there's no reason to read the analyser twice
  // at two different rates when one loop can serve both.
  let audioLevelFrame: number | undefined;
  let audioCtx: AudioContext | undefined;
  if (opts.onSilence || opts.onLevel) {
    try {
      audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const timeoutMs = opts.silenceTimeoutMs ?? 1500;
      let heardSpeech = false;
      let belowThresholdSinceMs: number | null = null;
      let fired = false;

      const tick = (): void => {
        analyser.getByteTimeDomainData(data);
        let sumSquares = 0;
        for (let i = 0; i < data.length; i++) {
          const normalized = (data[i] - 128) / 128;
          sumSquares += normalized * normalized;
        }
        const rms = Math.sqrt(sumSquares / data.length);

        opts.onLevel?.(rms);

        if (opts.onSilence && !fired) {
          const now = Date.now();
          if (rms >= SILENCE_RMS_THRESHOLD) {
            heardSpeech = true;
            belowThresholdSinceMs = null;
          } else if (heardSpeech) {
            // Silent so far without ever having heard speech isn't "gone
            // quiet" — it just hasn't started (e.g. a permission prompt or
            // thinking pause), so onSilence must never fire in that case.
            if (belowThresholdSinceMs === null) {
              belowThresholdSinceMs = now;
            } else if (now - belowThresholdSinceMs >= timeoutMs) {
              fired = true;
              opts.onSilence();
            }
          }
        }

        audioLevelFrame = requestAnimationFrame(tick);
      };
      audioLevelFrame = requestAnimationFrame(tick);
    } catch (e) {
      // AudioContext/analyser setup failed — silence auto-stop/level
      // reporting just never fire; the recording itself (via MediaRecorder,
      // set up above) is completely unaffected, so this is a soft-fail, not
      // a session failure.
      console.error("[dictation] audio analysis unavailable:", e);
    }
  }

  let released = false;
  function release(): void {
    if (released) return;
    released = true;
    if (audioLevelFrame !== undefined) cancelAnimationFrame(audioLevelFrame);
    if (audioCtx) void audioCtx.close().catch(() => {});
    stopTracks(stream);
  }

  return {
    async stop(whisperModel?: string): Promise<string> {
      try {
        if (recorder.state !== "inactive") {
          recorder.stop();
          await stopped;
        }
        const mimeType = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunks, { type: mimeType });
        if (blob.size === 0) {
          throw new Error("No audio was captured — recording was too short or the mic produced no data.");
        }
        const audioBase64 = await blobToBase64(blob);
        const mimeExt = mimeToExt(mimeType);
        const text = await tauriInvoke<string>("transcribe_audio_base64", {
          audioBase64,
          mimeExt,
          whisperModel: whisperModel ?? null,
        });
        return text.trim();
      } finally {
        release();
      }
    },
    cancel(): void {
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } finally {
        release();
      }
    },
  };
}

/** Abort an in-progress dictation session without transcribing: stops the
 * recorder (if still active) and releases the mic. Discards whatever audio
 * was captured so far. */
export function cancelDictation(session: DictationSession | null): void {
  session?.cancel();
}
