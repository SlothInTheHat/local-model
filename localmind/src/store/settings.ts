import { create } from "zustand";
import { persist } from "zustand/middleware";

interface Settings {
  defaultSystemPrompt: string;
  agentAutoApproveReads: boolean;
  theme: "light" | "dark";
  /** Manual override for the agent's Ollama num_ctx. null = auto (based on detected hardware). */
  numCtxOverride: number | null;
  /** Free-text steering used by the "Research feature ideas" action to guide what the agent looks for. */
  featureIdeasSteering: string;
  /** Base URL of the Ollama server. Defaults to the local instance; can point at a remote/alternate host. */
  ollamaBaseUrl: string;
  /** Clicking the window's X hides it to the system tray instead of quitting (WP5.1). */
  closeToTray: boolean;
}

interface SettingsState extends Settings {
  setDefaultSystemPrompt: (prompt: string) => void;
  setAgentAutoApproveReads: (val: boolean) => void;
  setTheme: (theme: "light" | "dark") => void;
  setNumCtxOverride: (val: number | null) => void;
  setFeatureIdeasSteering: (val: string) => void;
  setOllamaBaseUrl: (url: string) => void;
  setCloseToTray: (val: boolean) => void;
}

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      defaultSystemPrompt:
        "You are a helpful, precise AI assistant running locally via Ollama. Be concise and accurate.",
      agentAutoApproveReads: false,
      theme: "light",
      numCtxOverride: null,
      featureIdeasSteering: "",
      ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
      closeToTray: true,

      setDefaultSystemPrompt: (prompt) => set({ defaultSystemPrompt: prompt }),
      setAgentAutoApproveReads: (val) => set({ agentAutoApproveReads: val }),
      setTheme: (theme) => set({ theme }),
      setNumCtxOverride: (val) => set({ numCtxOverride: val }),
      setFeatureIdeasSteering: (val) => set({ featureIdeasSteering: val }),
      setOllamaBaseUrl: (url) => set({ ollamaBaseUrl: url }),
      setCloseToTray: (val) => set({ closeToTray: val }),
    }),
    { name: "localmind-settings" }
  )
);
