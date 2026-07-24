import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getCredential, setCredential } from "../lib/credentials";

/** Credential-vault "service" namespace for provider API keys (see src/lib/credentials.ts). */
const CRED_SERVICE = "provider-api-key";

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
  /** Updates a provider's API key both in memory and in the credential vault
   *  (src/lib/credentials.ts) — use this instead of setProvider({apiKey}) so
   *  the key actually persists somewhere other than in-memory-only. */
  setProviderApiKey: (id: string, apiKey: string) => Promise<void>;
  /** Hydrates every provider's apiKey from the credential vault. Call once at
   *  startup (App.tsx) — apiKey is deliberately excluded from this store's
   *  own persisted snapshot (see partialize below), so without this call
   *  every provider's key would read back empty after a restart. */
  loadApiKeys: () => Promise<void>;
}

export const useProvidersStore = create<ProvidersState>()(
  persist(
    (set, get) => ({
      providers: BUILTIN_PROVIDERS,
      setProvider: (id, patch) =>
        set((s) => ({
          providers: s.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        })),
      addProvider: (config) =>
        set((s) => ({ providers: [...s.providers, config] })),
      removeProvider: (id) => {
        set((s) => ({ providers: s.providers.filter((p) => p.id !== id) }));
        void setCredential(CRED_SERVICE, id, ""); // clears any saved key — no orphaned vault entry
      },
      setProviderApiKey: async (id, apiKey) => {
        set((s) => ({
          providers: s.providers.map((p) => (p.id === id ? { ...p, apiKey } : p)),
        }));
        await setCredential(CRED_SERVICE, id, apiKey);
      },
      loadApiKeys: async () => {
        const ids = get().providers.map((p) => p.id);
        const keys = await Promise.all(ids.map((id) => getCredential(CRED_SERVICE, id)));
        set((s) => ({
          providers: s.providers.map((p) => {
            const i = ids.indexOf(p.id);
            return i >= 0 && keys[i] ? { ...p, apiKey: keys[i] } : p;
          }),
        }));
      },
    }),
    {
      name: "localmind-providers",
      // Never persist apiKey to localStorage — it lives in the credential
      // vault instead. apiKey reads back "" until App.tsx's startup call to
      // loadApiKeys() hydrates it from there (see setProviderApiKey/
      // loadApiKeys above).
      partialize: (s) => ({
        providers: s.providers.map((p) => ({ ...p, apiKey: "" })),
      }),
    }
  )
);
