/**
 * Past-session full-text search (WP4.3). Indexes headless run transcripts
 * (task queue / scheduler / subagent) and interactive conversations into the
 * Rust `sessions` / `sessions_fts` tables (src-tauri/src/db.rs), so the agent
 * and the search overlay can answer "what did we decide about X last week?"
 * against transcripts, not just the last-500-char summaries already kept in
 * useSessionResultsStore.
 *
 * Every export here is a no-op (or resolves to []) outside Tauri — there is
 * no SQLite backend in browser/dev mode.
 */

import { useChatStore } from "../store/chat";

/** Cap applied before every write — keeps rows (and FTS index growth) sane;
 *  the Rust side stores whatever it's given verbatim. */
const MAX_TRANSCRIPT_CHARS = 20_000;

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { __TAURI__?: unknown }).__TAURI__;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__ as
    | { core?: { invoke?: (c: string, a?: unknown) => Promise<T> } }
    | undefined;
  const fn = tauri?.core?.invoke;
  if (typeof fn !== "function") throw new Error("Tauri core.invoke unavailable");
  return fn(cmd, args);
}

export interface SessionIndexEntry {
  id: string;
  origin: string;
  task: string;
  transcript: string;
  outcome: string;
  createdAt: number;
}

export interface SessionSearchRow {
  id: string;
  origin: string;
  task: string;
  snippet: string;
  outcome: string;
  created_at: number;
}

/** Upsert a session's transcript into the searchable index. Fire-and-forget
 *  friendly: never throws — swallowed (and logged) so a failed index write
 *  never breaks the caller's actual work (headless run finishing, etc.). */
export async function indexSession(entry: SessionIndexEntry): Promise<void> {
  if (!isTauriEnv()) return;
  try {
    await invoke("session_insert", {
      id: entry.id,
      origin: entry.origin,
      task: entry.task,
      transcript: entry.transcript.slice(0, MAX_TRANSCRIPT_CHARS),
      outcome: entry.outcome,
      createdAt: entry.createdAt,
    });
  } catch (e) {
    console.error("indexSession failed", e);
  }
}

/** Full-text search across indexed sessions/conversations. Returns [] in
 *  browser mode, for a blank query, or on any backend error — callers treat
 *  "no results" and "search unavailable" identically (an empty section). */
export async function searchSessions(query: string, limit = 8): Promise<SessionSearchRow[]> {
  if (!isTauriEnv()) return [];
  const q = query.trim();
  if (!q) return [];
  try {
    return await invoke<SessionSearchRow[]>("session_search", { query: q, limit });
  } catch (e) {
    console.error("searchSessions failed", e);
    return [];
  }
}

/** Bulk-index every interactive conversation so chat history is covered by
 *  the same past-sessions search as headless runs. Cheap enough (each
 *  conversation is a single upsert + FTS delete/insert) to just re-run in
 *  full at the call sites below rather than tracking per-conversation dirty
 *  state. No-ops entirely in browser mode. */
export async function syncConversationsToFts(): Promise<void> {
  if (!isTauriEnv()) return;
  const conversations = useChatStore.getState().conversations;
  for (const conv of conversations) {
    const transcript = conv.messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
    await indexSession({
      id: conv.id,
      origin: "chat",
      task: conv.title,
      transcript,
      outcome: "chat",
      createdAt: conv.createdAt,
    });
  }
}
