import { create } from "zustand";

export interface DebugPromptEntry {
  round: number;
  systemMessage: string;
  capturedAt: number;
}

/** Cap per conversation — a debug session isn't meant to be a permanent
 *  record, just a live look at the last several rounds. */
const MAX_ENTRIES_PER_CONV = 30;

interface DebugPromptsState {
  /** Whether debug mode is currently on — gates whether App.tsx wires
   *  onDebugPrompt at all, so this store stays empty (zero overhead) unless
   *  explicitly enabled. */
  enabled: boolean;
  byConversation: Record<string, DebugPromptEntry[]>;
  setEnabled: (v: boolean) => void;
  addEntry: (conversationId: string, entry: DebugPromptEntry) => void;
  clearConversation: (conversationId: string) => void;
}

/** Deliberately NOT persisted — this is a live debugging aid for the current
 *  session, not a durable record; the exact prompt text is large and
 *  reconstructible any time debug mode is re-enabled. */
export const useDebugPromptsStore = create<DebugPromptsState>()((set) => ({
  enabled: false,
  byConversation: {},
  setEnabled: (v) => set({ enabled: v }),
  addEntry: (conversationId, entry) =>
    set((s) => {
      const existing = s.byConversation[conversationId] ?? [];
      const next = [...existing, entry].slice(-MAX_ENTRIES_PER_CONV);
      return { byConversation: { ...s.byConversation, [conversationId]: next } };
    }),
  clearConversation: (conversationId) =>
    set((s) => {
      const next = { ...s.byConversation };
      delete next[conversationId];
      return { byConversation: next };
    }),
}));
