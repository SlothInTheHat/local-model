import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ModelSelectionState {
  selectedModel: string;
  setSelectedModel: (model: string) => void;
}

/**
 * Persisted so the user's model choice survives a restart.
 *
 * It deliberately used to be ephemeral, but the consequence was that
 * `initOllama` reset `selectedModel` to `availableModels[0]` on every launch —
 * silently discarding an explicit choice. Because this store IS the `primary`
 * model role (see src/lib/modelRoles.ts), that reset changed which model ran
 * every agent task, chat, and scheduled job after each restart, with no
 * indication anything had changed.
 *
 * The caller is responsible for validating a restored value against the
 * models that actually exist now — a persisted model can be deleted from
 * Ollama or belong to a provider that's since been disabled (see the
 * availability check at initOllama's setSelectedModel call site).
 */
export const useModelSelectionStore = create<ModelSelectionState>()(
  persist(
    (set) => ({
      selectedModel: "",
      setSelectedModel: (model) => set({ selectedModel: model }),
    }),
    { name: "localmind-model-selection" },
  ),
);
