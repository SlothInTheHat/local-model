/**
 * Piper (OHF-Voice/piper1-gpl) offline neural TTS — a real local neural voice
 * engine to pair with the Web Speech API path in speech.ts, for when a
 * system's only installed voices are the classic robotic SAPI ones. Manages
 * its own Python venv under the app data dir (see src-tauri/src/piper.rs) —
 * requires Python 3.9+ on the user's machine, downloaded/installed on demand
 * from Settings, nothing bundled into the app itself.
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

export interface PiperStatus {
  python_available: boolean;
  venv_ready: boolean;
  voices: string[];
}

export function getPiperStatus(): Promise<PiperStatus> {
  return tauriInvoke<PiperStatus>("piper_status");
}

export function setupPiper(): Promise<string> {
  return tauriInvoke<string>("piper_setup");
}

export function downloadPiperVoice(voice: string): Promise<string> {
  return tauriInvoke<string>("piper_download_voice", { voice });
}

export function speakWithPiper(text: string, voice: string): Promise<string> {
  return tauriInvoke<string>("piper_speak", { text, voice });
}

/** A small curated set of well-regarded English voices to offer by default —
 *  piper.download_voices supports many more (other qualities/languages/speakers)
 *  but listing everything would need parsing its full catalog output for
 *  limited benefit here. */
export const CURATED_PIPER_VOICES: { id: string; label: string }[] = [
  { id: "en_US-lessac-medium", label: "Lessac (US, medium) — clear, neutral" },
  { id: "en_US-ryan-high", label: "Ryan (US, high) — male, high quality" },
  { id: "en_US-amy-medium", label: "Amy (US, medium) — female" },
  { id: "en_GB-alan-medium", label: "Alan (UK, medium) — male, British" },
  { id: "en_GB-southern_english_female-medium", label: "Southern English Female (UK, medium)" },
];

/** Prefix used to encode a Piper voice selection inside useVoiceStore's plain
 *  string field, alongside browser SpeechSynthesisVoice names. */
const PIPER_PREFIX = "piper:";

export function encodePiperVoiceSelection(voiceId: string): string {
  return `${PIPER_PREFIX}${voiceId}`;
}

export function decodePiperVoiceSelection(selection: string | null): string | null {
  if (!selection || !selection.startsWith(PIPER_PREFIX)) return null;
  return selection.slice(PIPER_PREFIX.length);
}
