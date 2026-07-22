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

/** Begin capturing microphone audio. Resolves once the recorder is actively
 * running; rejects (e.g. with a `NotAllowedError` DOMException if the user
 * denies mic permission) before anything is recorded. */
export async function startDictation(): Promise<DictationSession> {
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

  let released = false;
  function release(): void {
    if (released) return;
    released = true;
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
