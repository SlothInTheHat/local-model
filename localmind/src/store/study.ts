import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ChatMessage } from "../lib/ollama";

export interface StudyBranch {
  id: string;
  parentBranchId: string | null; // null = root
  parentMessageIndex: number;    // index of the assistant message that spawned this
  topic: string;                 // short label shown in the tree
  messages: ChatMessage[];
}

export interface StudySession {
  id: string;
  title: string;
  createdAt: number;
  branches: StudyBranch[];       // branches[0] is always root
  activeBranchId: string;
}

interface StudyState {
  sessions: StudySession[];
  activeSessionId: string | null;

  newSession: (title: string) => string;
  deleteSession: (id: string) => void;
  selectSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;

  addMessage: (sessionId: string, branchId: string, msg: ChatMessage) => void;
  appendToLastMessage: (sessionId: string, branchId: string, text: string) => void;

  diveDeeperOn: (sessionId: string, branchId: string, messageIndex: number, topic: string) => string;
  setActiveBranch: (sessionId: string, branchId: string) => void;
}

function makeRootBranch(): StudyBranch {
  return {
    id: crypto.randomUUID(),
    parentBranchId: null,
    parentMessageIndex: 0,
    topic: "Main",
    messages: [],
  };
}

export const useStudyStore = create<StudyState>()(
  persist(
    (set) => ({
      sessions: [],
      activeSessionId: null,

      newSession: (title) => {
        const root = makeRootBranch();
        const session: StudySession = {
          id: crypto.randomUUID(),
          title,
          createdAt: Date.now(),
          branches: [root],
          activeBranchId: root.id,
        };
        set((s) => ({ sessions: [session, ...s.sessions], activeSessionId: session.id }));
        return session.id;
      },

      deleteSession: (id) =>
        set((s) => {
          const sessions = s.sessions.filter((sess) => sess.id !== id);
          return {
            sessions,
            activeSessionId: s.activeSessionId === id ? (sessions[0]?.id ?? null) : s.activeSessionId,
          };
        }),

      selectSession: (id) => set({ activeSessionId: id }),

      renameSession: (id, title) =>
        set((s) => ({
          sessions: s.sessions.map((sess) => (sess.id === id ? { ...sess, title } : sess)),
        })),

      addMessage: (sessionId, branchId, msg) =>
        set((s) => ({
          sessions: s.sessions.map((sess) => {
            if (sess.id !== sessionId) return sess;
            return {
              ...sess,
              branches: sess.branches.map((b) =>
                b.id !== branchId ? b : { ...b, messages: [...b.messages, msg] }
              ),
            };
          }),
        })),

      appendToLastMessage: (sessionId, branchId, text) =>
        set((s) => ({
          sessions: s.sessions.map((sess) => {
            if (sess.id !== sessionId) return sess;
            return {
              ...sess,
              branches: sess.branches.map((b) => {
                if (b.id !== branchId) return b;
                const msgs = [...b.messages];
                const last = msgs[msgs.length - 1];
                if (!last || last.role !== "assistant") return b;
                msgs[msgs.length - 1] = { ...last, content: last.content + text };
                return { ...b, messages: msgs };
              }),
            };
          }),
        })),

      diveDeeperOn: (sessionId, branchId, messageIndex, topic) => {
        const newBranch: StudyBranch = {
          id: crypto.randomUUID(),
          parentBranchId: branchId,
          parentMessageIndex: messageIndex,
          topic,
          messages: [],
        };

        set((s) => ({
          sessions: s.sessions.map((sess) => {
            if (sess.id !== sessionId) return sess;
            return {
              ...sess,
              branches: [...sess.branches, newBranch],
              activeBranchId: newBranch.id,
            };
          }),
        }));

        return newBranch.id;
      },

      setActiveBranch: (sessionId, branchId) =>
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === sessionId ? { ...sess, activeBranchId: branchId } : sess
          ),
        })),
    }),
    { name: "localmind-study" }
  )
);
