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
}

export const useVoiceStore = create<VoiceState>()(
  persist(
    (set) => ({
      selectedVoiceName: null,
      setSelectedVoiceName: (name) => set({ selectedVoiceName: name }),
    }),
    { name: "localmind-voice" }
  )
);
