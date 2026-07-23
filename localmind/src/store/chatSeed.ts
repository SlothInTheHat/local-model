import { create } from "zustand";

/**
 * Cross-component "jump to chat with context" request — used by the Study
 * tab's concept graph "Ask about this" action (and any future similar
 * entry point) to start a fresh chat conversation pre-loaded with context
 * the user didn't type themselves, then immediately send their actual
 * question. Not persisted — this is a one-shot handoff, not durable state.
 *
 * Plumbing lives in App.tsx (the only place with access to handleSend/
 * newConversation/setView) via a useEffect watching `pending`; this store
 * just carries the request across the component tree without threading
 * props through ConceptGraph -> KnowledgeHub -> App.
 */
export interface ChatSeedRequest {
  /** Becomes the new conversation's system prompt — invisible context (e.g.
   *  "the user is studying X, here's what's known about it, search the
   *  class's knowledge base to help answer"), not shown as a chat bubble. */
  systemPrompt: string;
  /** The user's actual typed question — sent as a normal, visible user message. */
  question: string;
}

interface ChatSeedState {
  pending: ChatSeedRequest | null;
  requestSeed: (req: ChatSeedRequest) => void;
  clearSeed: () => void;
}

export const useChatSeedStore = create<ChatSeedState>()((set) => ({
  pending: null,
  requestSeed: (req) => set({ pending: req }),
  clearSeed: () => set({ pending: null }),
}));
