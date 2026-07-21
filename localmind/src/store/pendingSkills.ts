import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * A skill candidate captured from a completed agent session, awaiting the
 * user's one-click approval before it's written to .localmind/skills/. Never
 * saved silently — see the digest hook at the end of runAgentSession in
 * agentRuntime.ts (WP3.3).
 */
export interface PendingSkill {
  id: string;
  name: string;
  tags: string[];
  content: string;
  /** The original task query this skill was distilled from, for context in the approval UI. */
  sourceTask: string;
  createdAt: number;
}

interface PendingSkillsState {
  pending: PendingSkill[];
  add: (skill: Omit<PendingSkill, "id" | "createdAt">) => void;
  remove: (id: string) => void;
}

export const usePendingSkillsStore = create<PendingSkillsState>()(
  persist(
    (set) => ({
      pending: [],
      add: (skill) =>
        set((s) => ({
          pending: [...s.pending, { ...skill, id: crypto.randomUUID(), createdAt: Date.now() }],
        })),
      remove: (id) => set((s) => ({ pending: s.pending.filter((p) => p.id !== id) })),
    }),
    {
      name: "localmind-pending-skills",
    }
  )
);
