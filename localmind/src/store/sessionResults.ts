import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Cap on stored results — oldest are dropped first. */
const MAX_RESULTS = 50;

export interface SessionResult {
  id: string;
  origin: string;
  task: string;
  startedAt: number;
  finishedAt: number;
  outcome: "completed" | "error" | "aborted" | "hit_round_limit";
  /** Short summary — last assistant text, or first 500 chars of the transcript. */
  summary: string;
  /** Tool-call summaries in order ("`${label} → ${summary}`"). */
  steps: string[];
  roundsUsed: number;
  hadSideEffects: boolean;
}

interface SessionResultsState {
  results: SessionResult[];
  addResult: (r: SessionResult) => void;
  clear: () => void;
}

export const useSessionResultsStore = create<SessionResultsState>()(
  persist(
    (set) => ({
      results: [],
      addResult: (r) =>
        set((s) => ({ results: [...s.results, r].slice(-MAX_RESULTS) })),
      clear: () => set({ results: [] }),
    }),
    {
      name: "localmind-session-results",
      partialize: (s) => ({ results: s.results.slice(-MAX_RESULTS) }),
    }
  )
);
