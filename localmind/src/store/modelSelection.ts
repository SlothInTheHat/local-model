import { create } from "zustand";

interface ModelSelectionState {
  selectedModel: string;
  setSelectedModel: (model: string) => void;
}

export const useModelSelectionStore = create<ModelSelectionState>()((set) => ({
  selectedModel: "",
  setSelectedModel: (model) => set({ selectedModel: model }),
}));
