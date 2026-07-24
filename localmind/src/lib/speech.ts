import { useVoiceStore } from "../store/voice";
import { decodePiperVoiceSelection, speakWithPiper } from "./piper";

/** Shared cap advertised by the speak_text tool description — keeps a single call bounded. */
export const SPEAK_TEXT_MAX_CHARS = 1000;

/** Resolves once the browser's voice list is populated — getVoices() can return
 *  empty on the very first call until the async 'voiceschanged' event fires. */
export function loadSpeechVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    const existing = window.speechSynthesis.getVoices();
    if (existing.length > 0) {
      resolve(existing);
      return;
    }
    let settled = false;
    window.speechSynthesis.onvoiceschanged = () => {
      if (settled) return;
      settled = true;
      resolve(window.speechSynthesis.getVoices());
    };
    // Some platforms never fire voiceschanged (or already had voices ready) —
    // don't hang the caller waiting on an event that isn't coming.
    setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(window.speechSynthesis.getVoices());
    }, 1000);
  });
}

/**
 * Prefers higher-quality neural/cloud voices over generic local system ones —
 * WebView2 (this app's Windows webview) exposes Microsoft's "X Online (Natural)"
 * neural voices, noticeably more natural-sounding than a default local voice.
 * Falls back to any English voice, then whatever's first in the list.
 */
export function pickBestSpeechVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const english = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
  const pool = english.length > 0 ? english : voices;
  return (
    pool.find((v) => /online \(natural\)/i.test(v.name)) ??
    pool.find((v) => /natural/i.test(v.name)) ??
    pool.find((v) => /google/i.test(v.name)) ??
    pool[0] ??
    voices[0] ??
    null
  );
}

/** Honors the user's Settings > Voice pick (by name) if it still exists in the
 *  current voice list, otherwise falls back to the automatic "best" choice. */
export function resolveSelectedVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const selectedName = useVoiceStore.getState().selectedVoiceName;
  if (selectedName) {
    const match = voices.find((v) => v.name === selectedName);
    if (match) return match;
  }
  return pickBestSpeechVoice(voices);
}

export function splitIntoSentences(text: string): string[] {
  return text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
}

/** Speaks a single utterance with the given voice and resolves/rejects on completion. */
export function speakUtterance(text: string, voice: SpeechSynthesisVoice | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    if (voice) utterance.voice = voice;
    utterance.onend = () => resolve();
    utterance.onerror = (e) => reject(new Error(`Speech synthesis error: ${e.error}`));
    window.speechSynthesis.speak(utterance);
  });
}

/**
 * Speaks text via the browser's Web Speech API (available in Tauri's WebView2
 * webview) instead of shelling out to Windows SAPI from Rust — gets access to
 * the same higher-quality neural voices a browser-based TTS UI would use, and
 * honors the user's Settings > Voice pick. Sentence-by-sentence (like a real
 * read-aloud UI) rather than one long utterance, both for a more natural
 * cadence and because some engines truncate very long single utterances.
 */
export async function speakText(text: string): Promise<void> {
  const piperVoice = decodePiperVoiceSelection(useVoiceStore.getState().selectedVoiceName);
  if (piperVoice) {
    await speakWithPiper(text, piperVoice);
    return;
  }

  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    throw new Error("Web Speech API unavailable in this environment");
  }
  window.speechSynthesis.cancel();
  const voices = await loadSpeechVoices();
  const voice = resolveSelectedVoice(voices);
  for (const sentence of splitIntoSentences(text)) {
    await speakUtterance(sentence, voice);
  }
}
