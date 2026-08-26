import { create } from "zustand";

export interface DebugPromptEntry {
  round: number;
  systemMessage: string;
  capturedAt: number;
}

/** A tool the model called that wasn't in that round's retrieved candidate
 *  set (src/lib/toolFilter.ts's retrieveToolsForStep) — surfaced here so
 *  this is diagnosable without opening the browser devtools console, where
 *  it was previously only a console.info. Not necessarily a bug: LocalMind
 *  deliberately doesn't hard-block a call outside the retrieved set (the
 *  model may be recalling a tool from earlier in the conversation, or
 *  retrieval may have genuinely under-ranked something relevant) — this is
 *  the evidence trail for tuning ToolDef.aliases/useWhen, not an error log. */
export interface RetrievalMissEntry {
  round: number;
  toolName: string;
  objective: string;
  capturedAt: number;
}

/** Cap per conversation — a debug session isn't meant to be a permanent
 *  record, just a live look at the last several rounds. */
const MAX_ENTRIES_PER_CONV = 30;

interface DebugPromptsState {
  /** Whether debug mode is currently on — gates whether App.tsx wires
   *  onDebugPrompt/onRetrievalMiss at all, so this store stays empty (zero
   *  overhead) unless explicitly enabled. */
  enabled: boolean;
  byConversation: Record<string, DebugPromptEntry[]>;
  missesByConversation: Record<string, RetrievalMissEntry[]>;
  setEnabled: (v: boolean) => void;
  addEntry: (conversationId: string, entry: DebugPromptEntry) => void;
  addMiss: (conversationId: string, entry: RetrievalMissEntry) => void;
  clearConversation: (conversationId: string) => void;
}

/** Deliberately NOT persisted — this is a live debugging aid for the current
 *  session, not a durable record; the exact prompt text is large and
 *  reconstructible any time debug mode is re-enabled. */
export const useDebugPromptsStore = create<DebugPromptsState>()((set) => ({
  enabled: false,
  byConversation: {},
  missesByConversation: {},
  setEnabled: (v) => set({ enabled: v }),
  addEntry: (conversationId, entry) =>
    set((s) => {
      const existing = s.byConversation[conversationId] ?? [];
      const next = [...existing, entry].slice(-MAX_ENTRIES_PER_CONV);
      return { byConversation: { ...s.byConversation, [conversationId]: next } };
    }),
  addMiss: (conversationId, entry) =>
    set((s) => {
      const existing = s.missesByConversation[conversationId] ?? [];
      const next = [...existing, entry].slice(-MAX_ENTRIES_PER_CONV);
      return { missesByConversation: { ...s.missesByConversation, [conversationId]: next } };
    }),
  clearConversation: (conversationId) =>
    set((s) => {
      const nextPrompts = { ...s.byConversation };
      delete nextPrompts[conversationId];
      const nextMisses = { ...s.missesByConversation };
      delete nextMisses[conversationId];
      return { byConversation: nextPrompts, missesByConversation: nextMisses };
    }),
}));
