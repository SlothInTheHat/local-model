import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ChatMessage } from "../lib/ollama";

export interface Conversation {
  id: string;
  title: string;
  model: string;
  messages: ChatMessage[];
  createdAt: number;
  systemPrompt: string;
}

interface ChatState {
  conversations: Conversation[];
  activeId: string | null;
  availableModels: string[];
  isStreaming: boolean;

  setModels: (models: string[]) => void;
  newConversation: (model: string) => string;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  addMessage: (convId: string, msg: ChatMessage) => void;
  appendToLastMessage: (convId: string, text: string) => void;
  setStreaming: (val: boolean) => void;
  updateTitle: (convId: string, title: string) => void;
  updateSystemPrompt: (convId: string, prompt: string) => void;
  renameConversation: (convId: string, title: string) => void;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      conversations: [],
      activeId: null,
      availableModels: [],
      isStreaming: false,

      setModels: (models) => set({ availableModels: models }),

      newConversation: (model) => {
        const id = crypto.randomUUID();
        const conv: Conversation = {
          id,
          title: "New Chat",
          model,
          messages: [],
          createdAt: Date.now(),
          systemPrompt: "",
        };
        set((s) => ({ conversations: [conv, ...s.conversations], activeId: id }));
        return id;
      },

      selectConversation: (id) => set({ activeId: id }),

      deleteConversation: (id) =>
        set((s) => {
          const convs = s.conversations.filter((c) => c.id !== id);
          const activeId = s.activeId === id ? (convs[0]?.id ?? null) : s.activeId;
          return { conversations: convs, activeId };
        }),

      addMessage: (convId, msg) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === convId ? { ...c, messages: [...c.messages, msg] } : c
          ),
        })),

      appendToLastMessage: (convId, text) =>
        set((s) => ({
          conversations: s.conversations.map((c) => {
            if (c.id !== convId) return c;
            const msgs = [...c.messages];
            const last = msgs[msgs.length - 1];
            if (!last || last.role !== "assistant") return c;
            msgs[msgs.length - 1] = { ...last, content: last.content + text };
            return { ...c, messages: msgs };
          }),
        })),

      setStreaming: (val) => set({ isStreaming: val }),

      updateTitle: (convId, title) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === convId ? { ...c, title } : c
          ),
        })),

      updateSystemPrompt: (convId, prompt) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === convId ? { ...c, systemPrompt: prompt } : c
          ),
        })),

      renameConversation: (convId, title) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === convId ? { ...c, title } : c
          ),
        })),
    }),
    {
      name: "localmind-chat",
      partialize: (state) => ({
        conversations: state.conversations.map((c) => ({
          ...c,
          messages: c.messages.slice(-200),
        })),
        activeId: state.activeId,
        availableModels: state.availableModels,
      }),
    }
  )
);
