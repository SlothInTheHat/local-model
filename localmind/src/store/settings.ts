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
}

interface SettingsState extends Settings {
  setDefaultSystemPrompt: (prompt: string) => void;
  setAgentAutoApproveReads: (val: boolean) => void;
  setTheme: (theme: "light" | "dark") => void;
  setNumCtxOverride: (val: number | null) => void;
  setFeatureIdeasSteering: (val: string) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      defaultSystemPrompt:
        "You are a helpful, precise AI assistant running locally via Ollama. Be concise and accurate.",
      agentAutoApproveReads: false,
      theme: "light",
      numCtxOverride: null,
      featureIdeasSteering: "",

      setDefaultSystemPrompt: (prompt) => set({ defaultSystemPrompt: prompt }),
      setAgentAutoApproveReads: (val) => set({ agentAutoApproveReads: val }),
      setTheme: (theme) => set({ theme }),
      setNumCtxOverride: (val) => set({ numCtxOverride: val }),
      setFeatureIdeasSteering: (val) => set({ featureIdeasSteering: val }),
    }),
    { name: "localmind-settings" }
  )
);
