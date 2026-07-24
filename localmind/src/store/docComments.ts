import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Google-Docs-style comments for the Docs tab, anchored to a quoted text
 * range rather than embedded in the saved markdown — comments are editor
 * metadata, not document content (matching how Google Docs comments don't
 * show up in a plain-text export of the doc either). Keyed by workspace path
 * + file path so different documents (and different workspaces reusing the
 * same relative path) don't collide.
 */

export interface CommentMessage {
  id: string;
  author: "user" | "ai";
  text: string;
  createdAt: number;
}

export interface DocComment {
  id: string;
  /** The exact text this comment was anchored to, used to re-find and
   *  re-highlight the range whenever the file is reopened (the Tiptap mark
   *  itself doesn't survive a save/reload — see tiptapComment.ts). */
  anchorText: string;
  resolved: boolean;
  messages: CommentMessage[];
  createdAt: number;
}

function docKey(workspacePath: string | null | undefined, filePath: string): string {
  return `${workspacePath ?? ""}::${filePath}`;
}

interface DocCommentsState {
  commentsByDoc: Record<string, DocComment[]>;
  getComments: (workspacePath: string | null | undefined, filePath: string) => DocComment[];
  addComment: (workspacePath: string | null | undefined, filePath: string, comment: DocComment) => void;
  addMessage: (workspacePath: string | null | undefined, filePath: string, commentId: string, message: CommentMessage) => void;
  setResolved: (workspacePath: string | null | undefined, filePath: string, commentId: string, resolved: boolean) => void;
  deleteComment: (workspacePath: string | null | undefined, filePath: string, commentId: string) => void;
}

export const useDocCommentsStore = create<DocCommentsState>()(
  persist(
    (set, get) => ({
      commentsByDoc: {},

      getComments: (workspacePath, filePath) => get().commentsByDoc[docKey(workspacePath, filePath)] ?? [],

      addComment: (workspacePath, filePath, comment) => {
        const key = docKey(workspacePath, filePath);
        set((s) => ({
          commentsByDoc: { ...s.commentsByDoc, [key]: [...(s.commentsByDoc[key] ?? []), comment] },
        }));
      },

      addMessage: (workspacePath, filePath, commentId, message) => {
        const key = docKey(workspacePath, filePath);
        set((s) => ({
          commentsByDoc: {
            ...s.commentsByDoc,
            [key]: (s.commentsByDoc[key] ?? []).map((c) =>
              c.id === commentId ? { ...c, messages: [...c.messages, message] } : c
            ),
          },
        }));
      },

      setResolved: (workspacePath, filePath, commentId, resolved) => {
        const key = docKey(workspacePath, filePath);
        set((s) => ({
          commentsByDoc: {
            ...s.commentsByDoc,
            [key]: (s.commentsByDoc[key] ?? []).map((c) => (c.id === commentId ? { ...c, resolved } : c)),
          },
        }));
      },

      deleteComment: (workspacePath, filePath, commentId) => {
        const key = docKey(workspacePath, filePath);
        set((s) => ({
          commentsByDoc: { ...s.commentsByDoc, [key]: (s.commentsByDoc[key] ?? []).filter((c) => c.id !== commentId) },
        }));
      },
    }),
    { name: "localmind-doc-comments" }
  )
);
