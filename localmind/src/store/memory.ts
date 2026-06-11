import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface MemoryEntry {
  id: string;
  text: string;
  embedding: number[];
  tags: string[];
  source: "user" | "agent";
  createdAt: number;
}

interface MemoryState {
  entries: MemoryEntry[];
  embedModel: string;
  addEntry: (entry: MemoryEntry) => void;
  removeEntry: (id: string) => void;
  setEmbedModel: (model: string) => void;
}

export const useMemoryStore = create<MemoryState>()(
  persist(
    (set) => ({
      entries: [],
      embedModel: "nomic-embed-text",
      addEntry: (entry) => set((s) => ({ entries: [entry, ...s.entries] })),
      removeEntry: (id) => set((s) => ({ entries: s.entries.filter((e) => e.id !== id) })),
      setEmbedModel: (model) => set({ embedModel: model }),
    }),
    { name: "localmind-memory" }
  )
);
