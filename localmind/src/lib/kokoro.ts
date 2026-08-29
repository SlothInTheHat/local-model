/**
 * Kokoro-82M offline text-to-speech — replaces the earlier Piper integration
 * (see src-tauri/src/kokoro.rs for the full rationale: Apache-2.0 weights
 * instead of Piper's GPL-3.0 package, one shared model+voices download
 * instead of Piper's per-voice downloads, and synthesis runs through a warm
 * daemon instead of Piper's cold-spawn-per-utterance process).
 *
 * Manages its own dedicated venv under the app data dir, downloaded/set up
 * at the user's request from Settings — nothing bundled into LocalMind
 * itself. Windows-only Tauri commands, invoked directly via the raw
 * `window.__TAURI__` bridge (not the `@tauri-apps/api/core` import) so this
 * module stays importable from isolated windows (QuickInvoke.tsx) that must
 * never pull in a real Tauri API import — see speech.ts's own header comment
 * for the identical constraint this mirrors.
 */

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__;
  if (!tauri) throw new Error("Not in Tauri desktop mode");
  const core = (tauri as Record<string, unknown>).core as {
    invoke?: (cmd: string, args?: unknown) => Promise<T>;
  };
  if (typeof core?.invoke !== "function") throw new Error("Tauri core.invoke unavailable");
  return core.invoke(cmd, args);
}

export interface KokoroStatus {
  python_available: boolean;
  venv_ready: boolean;
  /** Both the ONNX model and the shared voices file are downloaded. */
  model_ready: boolean;
  /** Informational only — whether setup detected an NVIDIA GPU and picked
   *  onnxruntime-gpu over the plain CPU-only package. */
  gpu_detected: boolean;
}

export function getKokoroStatus(): Promise<KokoroStatus> {
  return tauriInvoke<KokoroStatus>("kokoro_status");
}

export function setupKokoro(): Promise<string> {
  return tauriInvoke<string>("kokoro_setup");
}

export function downloadKokoroModel(): Promise<string> {
  return tauriInvoke<string>("kokoro_download_model");
}

export function speakWithKokoro(text: string, voice: string): Promise<string> {
  return tauriInvoke<string>("kokoro_speak", { text, voice });
}

/** A small curated set of well-regarded English voices out of Kokoro's ~54 —
 *  all bundled in the one voices file downloadKokoroModel fetches, so unlike
 *  Piper's CURATED_PIPER_VOICES this is just a picker list, nothing to
 *  individually download. */
export const CURATED_KOKORO_VOICES: { id: string; label: string }[] = [
  { id: "af_heart", label: "Heart (US, female) — default, warm" },
  { id: "af_bella", label: "Bella (US, female)" },
  { id: "af_nova", label: "Nova (US, female)" },
  { id: "am_adam", label: "Adam (US, male)" },
  { id: "am_michael", label: "Michael (US, male)" },
  { id: "bf_emma", label: "Emma (UK, female)" },
  { id: "bm_george", label: "George (UK, male)" },
];

/** Prefix used to encode a Kokoro voice selection inside useVoiceStore's
 *  plain string field, alongside browser SpeechSynthesisVoice names. */
const KOKORO_PREFIX = "kokoro:";

export function encodeKokoroVoiceSelection(voiceId: string): string {
  return `${KOKORO_PREFIX}${voiceId}`;
}

export function decodeKokoroVoiceSelection(selection: string | null): string | null {
  if (!selection || !selection.startsWith(KOKORO_PREFIX)) return null;
  return selection.slice(KOKORO_PREFIX.length);
}
