import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * The user's manually-picked TTS voice (Settings > Voice), by name — the only
 * stable, serializable identifier a SpeechSynthesisVoice exposes (the objects
 * themselves aren't persistable and are re-fetched fresh each session from
 * window.speechSynthesis.getVoices()). null means "no manual pick — auto-select
 * the best available voice" (see pickBestSpeechVoice in lib/speech.ts).
 */
interface VoiceState {
  selectedVoiceName: string | null;
  setSelectedVoiceName: (name: string | null) => void;
  /** Speak quick-invoke's widget-mode (background) answers aloud automatically
   *  once they're ready — the point of that mode is not having to look at a
   *  screen, so a silent text-only answer defeats it. Defaults to true.
   *  Chat-mode quick-invoke (opens the full window) is unaffected — that
   *  surface already shows the answer visibly, so auto-speaking there would
   *  be redundant rather than the primary way of receiving the answer. Read
   *  directly from localStorage (not this hook) by QuickInvoke.tsx, which
   *  must never import ../store — see that file's header comment. */
  quickInvokeAutoSpeak: boolean;
  setQuickInvokeAutoSpeak: (enabled: boolean) => void;
}

export const useVoiceStore = create<VoiceState>()(
  persist(
    (set) => ({
      selectedVoiceName: null,
      setSelectedVoiceName: (name) => set({ selectedVoiceName: name }),
      quickInvokeAutoSpeak: true,
      setQuickInvokeAutoSpeak: (enabled) => set({ quickInvokeAutoSpeak: enabled }),
    }),
    { name: "localmind-voice" }
  )
);
