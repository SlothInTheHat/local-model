import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];   // user-configured list; empty = discovered at runtime
  enabled: boolean;
}

export const BUILTIN_PROVIDERS: ProviderConfig[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "o3-mini", "o1-mini"],
    enabled: false,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "",
    models: [
      "anthropic/claude-3-5-sonnet",
      "anthropic/claude-3-haiku",
      "google/gemini-flash-1.5",
      "google/gemini-pro-1.5",
      "meta-llama/llama-3.1-70b-instruct",
      "mistralai/mixtral-8x7b-instruct",
      "openai/gpt-4o",
      "deepseek/deepseek-chat",
    ],
    enabled: false,
  },
  {
    id: "llamacpp",
    name: "llama.cpp",
    baseUrl: "http://localhost:8080/v1",
    apiKey: "",
    models: [],
    enabled: false,
  },
];

interface ProvidersState {
  providers: ProviderConfig[];
  setProvider: (id: string, patch: Partial<ProviderConfig>) => void;
  addProvider: (config: ProviderConfig) => void;
  removeProvider: (id: string) => void;
}

export const useProvidersStore = create<ProvidersState>()(
  persist(
    (set) => ({
      providers: BUILTIN_PROVIDERS,
      setProvider: (id, patch) =>
        set((s) => ({
          providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        })),
      addProvider: (config) =>
        set((s) => ({ providers: [...s.providers, config] })),
      removeProvider: (id) =>
        set((s) => ({ providers: s.providers.filter((p) => p.id !== id) })),
    }),
    { name: "localmind-providers" }
  )
);
