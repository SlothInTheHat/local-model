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
  /** Short summary — last assistant text, or first 500 chars of the transcript.
   *  This is a LABEL (for a Logs row, a toast), not the answer. Anything that
   *  actually shows a user the agent's response wants `fullText`. */
  summary: string;
  /**
   * The agent's full answer, capped at 8000 chars. `summary`'s 500-char cut
   * was truncating real answers mid-sentence anywhere a result got surfaced
   * (it did exactly that in the quick-invoke result widget), and unattended
   * runs had nowhere else to recover the text from — the transcript was
   * discarded once the record was built, surviving only in the FTS index.
   * Optional because records persisted before this field existed won't have it.
   */
  fullText?: string;
  /** Tool-call summaries in order ("`${label} → ${summary}`"). */
  steps: string[];
  roundsUsed: number;
  hadSideEffects: boolean;
  /** The Workflow.id (src/store/workflows.ts) this run belongs to, if any — lets the
   *  Workflows dashboard filter run history per workflow. Absent for every other origin. */
  workflowId?: string;
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
