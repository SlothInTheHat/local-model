import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ChatMessage } from "../lib/ollama";

// ─── Inline IndexedDB storage adapter ────────────────────────────────────────
// Replaces localStorage (5 MB cap) with IndexedDB (hundreds of MB).
function makeIdbStorage(dbName: string, storeName: string) {
  let db: IDBDatabase | null = null;

  function open(): Promise<IDBDatabase> {
    if (db) return Promise.resolve(db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(storeName);
      req.onsuccess = () => { db = req.result; resolve(db!); };
      req.onerror = () => reject(req.error);
    });
  }

  return {
    getItem: async (key: string): Promise<string | null> => {
      const store = await open();
      return new Promise((resolve, reject) => {
        const tx = store.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve((req.result as string | undefined) ?? null);
        req.onerror = () => reject(req.error);
      });
    },
    setItem: async (key: string, value: string): Promise<void> => {
      const store = await open();
      return new Promise((resolve, reject) => {
        const tx = store.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
    removeItem: async (key: string): Promise<void> => {
      const store = await open();
      return new Promise((resolve, reject) => {
        const tx = store.transaction(storeName, "readwrite");
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };
}

const chatIdbStorage = makeIdbStorage("localmind-db", "chat-store");

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
  appendThinkingToLastMessage: (convId: string, text: string) => void;
  setLastMessageContent: (convId: string, content: string) => void;
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

      appendThinkingToLastMessage: (convId, text) =>
        set((s) => ({
          conversations: s.conversations.map((c) => {
            if (c.id !== convId) return c;
            const msgs = [...c.messages];
            const last = msgs[msgs.length - 1];
            if (!last || last.role !== "assistant") return c;
            msgs[msgs.length - 1] = { ...last, thinking: (last.thinking ?? "") + text };
            return { ...c, messages: msgs };
          }),
        })),

      setLastMessageContent: (convId, content) =>
        set((s) => ({
          conversations: s.conversations.map((c) => {
            if (c.id !== convId) return c;
            const msgs = [...c.messages];
            const last = msgs[msgs.length - 1];
            if (!last || last.role !== "assistant") return c;
            msgs[msgs.length - 1] = { ...last, content };
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
      storage: createJSONStorage(() => chatIdbStorage),
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
