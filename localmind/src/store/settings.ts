import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ModelRole } from "../lib/modelRoles";

interface Settings {
  defaultSystemPrompt: string;
  theme: "light" | "dark";
  /** Monaco editor theme in the Code tab — independent of the app-wide `theme`
   *  above (Monaco can't read CSS custom properties, and users may prefer a
   *  dark editor regardless of the app's light/dark chrome). Defaults to
   *  "dark" — the editor's long-standing look before theme-following was
   *  briefly tried and reverted per user feedback. */
  codeEditorTheme: "light" | "dark";
  /** Manual override for the agent's Ollama num_ctx. null = auto (based on detected hardware). */
  numCtxOverride: number | null;
  /** Free-text steering used by the "Research feature ideas" action to guide what the agent looks for. */
  featureIdeasSteering: string;
  /** Base URL of the Ollama server. Defaults to the local instance; can point at a remote/alternate host. */
  ollamaBaseUrl: string;
  /** Clicking the window's X hides it to the system tray instead of quitting (WP5.1). */
  closeToTray: boolean;
  /**
   * User-pinned model overrides per role (WP6.2a). A role absent from this
   * map is auto-selected — see src/lib/modelRoles.ts `resolveRoleWithReason`.
   * `primary` is deliberately never set here; it has its own dedicated store
   * (src/store/modelSelection.ts) and is not offered as a pinnable role in
   * Settings, to avoid two sources of truth for the main model.
   */
  modelRoles: Partial<Record<ModelRole, string>>;
  /**
   * faster-whisper model size used for local offline dictation (WP6.3, mic
   * button in ChatInput) and video transcription. Bigger = more accurate but
   * slower; transcription always runs on CPU. Passed straight through to the
   * `transcribe_audio_base64` / `transcribe_video` Tauri commands.
   */
  whisperModel: "tiny" | "base" | "small" | "medium";
  /**
   * Which engine the mic button uses to turn speech into text.
   * - "whisper": local offline faster-whisper (accurate, but records-then-
   *   transcribes, so there's a wait after you stop talking).
   * - "browser": the platform Web Speech API — streams words in real time as
   *   you speak (feels much faster), but is experimental in the desktop
   *   webview and may require an internet connection. Offered as a toggle so
   *   the user can try it and compare. Falls back to whisper if the platform
   *   has no SpeechRecognition.
   */
  dictationEngine: "whisper" | "browser";
  /**
   * When true (default), a daily background job is auto-seeded once at first
   * launch that mines session history for recurring failure patterns
   * (find_recurring_issues) and scans workspace state for anything worth
   * surfacing unprompted via notify_user — the "proactive reach-out" /
   * self-improvement-loop closure. Off means no such job is ever seeded, and
   * an already-seeded job is left alone (toggling off doesn't retroactively
   * cancel a job the user may have since edited).
   */
  selfImprovementEnabled: boolean;
  /** Internal bookkeeping: true once the daily self-improvement job has been
   *  inserted for this install, so App.tsx's startup check doesn't insert a
   *  duplicate on every launch. Not a user-facing setting. */
  selfImprovementJobSeeded: boolean;
}

interface SettingsState extends Settings {
  setDefaultSystemPrompt: (prompt: string) => void;
  setTheme: (theme: "light" | "dark") => void;
  setCodeEditorTheme: (theme: "light" | "dark") => void;
  setNumCtxOverride: (val: number | null) => void;
  setFeatureIdeasSteering: (val: string) => void;
  setOllamaBaseUrl: (url: string) => void;
  setCloseToTray: (val: boolean) => void;
  /** Pin a model to a role, or pass `null` to clear the pin (fall back to auto). */
  setModelRole: (role: ModelRole, modelRef: string | null) => void;
  setWhisperModel: (model: Settings["whisperModel"]) => void;
  setDictationEngine: (engine: Settings["dictationEngine"]) => void;
  setSelfImprovementEnabled: (val: boolean) => void;
  /** Called once by App.tsx right after it successfully seeds the job. */
  markSelfImprovementJobSeeded: () => void;
}

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      defaultSystemPrompt:
        "You are a helpful, precise AI assistant running locally via Ollama. Be concise and accurate.",
      theme: "light",
      codeEditorTheme: "dark",
      numCtxOverride: null,
      featureIdeasSteering: "",
      ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
      closeToTray: true,
      modelRoles: {},
      whisperModel: "base",
      dictationEngine: "whisper",
      selfImprovementEnabled: true,
      selfImprovementJobSeeded: false,

      setDefaultSystemPrompt: (prompt) => set({ defaultSystemPrompt: prompt }),
      setTheme: (theme) => set({ theme }),
      setCodeEditorTheme: (theme) => set({ codeEditorTheme: theme }),
      setNumCtxOverride: (val) => set({ numCtxOverride: val }),
      setFeatureIdeasSteering: (val) => set({ featureIdeasSteering: val }),
      setOllamaBaseUrl: (url) => set({ ollamaBaseUrl: url }),
      setCloseToTray: (val) => set({ closeToTray: val }),
      setModelRole: (role, modelRef) =>
        set((s) => {
          const next = { ...s.modelRoles };
          if (modelRef) next[role] = modelRef;
          else delete next[role];
          return { modelRoles: next };
        }),
      setWhisperModel: (model) => set({ whisperModel: model }),
      setDictationEngine: (engine) => set({ dictationEngine: engine }),
      setSelfImprovementEnabled: (val) => set({ selfImprovementEnabled: val }),
      markSelfImprovementJobSeeded: () => set({ selfImprovementJobSeeded: true }),
    }),
    { name: "localmind-settings" }
  )
);
