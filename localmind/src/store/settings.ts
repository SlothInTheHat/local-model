import { create } from "zustand";
import { persist } from "zustand/middleware";

interface Settings {
  defaultSystemPrompt: string;
  agentAutoApproveReads: boolean;
  theme: "light" | "dark";
}

interface SettingsState extends Settings {
  setDefaultSystemPrompt: (prompt: string) => void;
  setAgentAutoApproveReads: (val: boolean) => void;
  setTheme: (theme: "light" | "dark") => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      defaultSystemPrompt:
        "You are a helpful, precise AI assistant running locally via Ollama. Be concise and accurate.",
      agentAutoApproveReads: false,
      theme: "light",

      setDefaultSystemPrompt: (prompt) => set({ defaultSystemPrompt: prompt }),
      setAgentAutoApproveReads: (val) => set({ agentAutoApproveReads: val }),
      setTheme: (theme) => set({ theme }),
    }),
    { name: "localmind-settings" }
  )
);
