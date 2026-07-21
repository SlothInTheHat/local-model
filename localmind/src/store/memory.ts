import { create } from "zustand";

export interface MemoryEntry {
  id: string;
  text: string;
  embedding: number[];
  tags: string[];
  source: "user" | "agent" | "session-digest";
  createdAt: number;
  /** Optional (absent on legacy/browser-mode data): last retrieval time, ms epoch. */
  lastUsedAt?: number;
  /** Optional (absent on legacy/browser-mode data): retrieval count. */
  useCount?: number;
}

interface MemoryState {
  entries: MemoryEntry[];
  embedModel: string;
  /** True once entries have been hydrated from the SQLite backend (or, in
   *  browser mode, from the legacy localStorage blob). Guards loadFromDb()
   *  against re-hydrating on every call. */
  hydrated: boolean;
  addEntry: (entry: MemoryEntry) => void;
  removeEntry: (id: string) => void;
  setEmbedModel: (model: string) => void;
  /** Populate `entries` from the SQLite backend. Idempotent — safe to call
   *  from every code path that needs memories (vectorMemory.ts calls it
   *  lazily before search/add if not yet hydrated). */
  loadFromDb: () => Promise<void>;
}

// ─── Legacy localStorage persistence (pre-WP1.4) ───────────────────────────
//
// Memory used to live entirely in a zustand `persist` store under this key,
// including the full float embedding array — which silently stopped growing
// once localStorage's ~5MB cap was hit. WP1.4 moves the source of truth to a
// SQLite DB in the Rust backend; the keys below are only read once, to
// migrate old data, and to preserve the (much smaller) embedModel setting.

const LEGACY_PERSIST_KEY = "localmind-memory";
const MIGRATED_FLAG_KEY = "localmind-memory-migrated";
const EMBED_MODEL_KEY = "localmind-embed-model";

function isTauri(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { __TAURI__?: unknown }).__TAURI__;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const w = window as unknown as Record<string, unknown>;
  const tauri = w.__TAURI__ as { core: { invoke: (c: string, a?: unknown) => Promise<T> } };
  return tauri.core.invoke(cmd, args);
}

interface DbMemoryRow {
  id: string;
  text: string;
  embedding: number[];
  tags: string;
  source: string;
  created_at: number;
  // Optional so an older Rust binary (without these columns in memory_all)
  // still deserializes cleanly.
  last_used_at?: number;
  use_count?: number;
}

function tagsToDb(tags: string[]): string {
  return tags.join(",");
}

function tagsFromDb(tags: string): string[] {
  return tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
}

function rowToEntry(row: DbMemoryRow): MemoryEntry {
  return {
    id: row.id,
    text: row.text,
    embedding: Array.isArray(row.embedding) ? row.embedding : [],
    tags: tagsFromDb(row.tags),
    source: row.source === "agent" ? "agent" : row.source === "session-digest" ? "session-digest" : "user",
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? row.created_at,
    useCount: row.use_count ?? 0,
  };
}

/** Fire-and-forget usage bump for retrieved memories: mirrors the increment
 *  into the in-memory cache (so usage-weighted ranking reacts within the
 *  session) and persists via `memory_touch`. Must never throw or block the
 *  caller's scoring path — errors are swallowed, DB write skipped outside
 *  Tauri. */
export function touchMemories(ids: string[]): void {
  if (ids.length === 0) return;
  const now = Date.now();
  const idSet = new Set(ids);
  useMemoryStore.setState((s) => ({
    entries: s.entries.map((e) =>
      idSet.has(e.id) ? { ...e, lastUsedAt: now, useCount: (e.useCount ?? 0) + 1 } : e
    ),
  }));
  if (!isTauri()) return;
  for (const id of ids) {
    invoke("memory_touch", { id }).catch(() => {});
  }
}

/** Read entries out of the old zustand-persist localStorage blob, if present. */
function readLegacyEntries(): MemoryEntry[] {
  try {
    const raw = localStorage.getItem(LEGACY_PERSIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { state?: { entries?: MemoryEntry[] } };
    return Array.isArray(parsed?.state?.entries) ? parsed.state!.entries! : [];
  } catch {
    return [];
  }
}

/** One-time migration of legacy localStorage entries into SQLite. Old data is
 *  intentionally left in place (not deleted) as a safety net — only the
 *  "migrated" flag is set, so this never re-runs once it succeeds. */
async function migrateLegacyIfNeeded(): Promise<void> {
  if (localStorage.getItem(MIGRATED_FLAG_KEY)) return;
  const legacy = readLegacyEntries();
  for (const entry of legacy) {
    try {
      await invoke("memory_upsert", {
        id: entry.id,
        text: entry.text,
        embedding: entry.embedding ?? [],
        tags: tagsToDb(entry.tags ?? []),
        source: entry.source ?? "user",
        createdAt: entry.createdAt ?? Date.now(),
      });
    } catch (e) {
      // Leave the flag unset so migration is retried on a later launch.
      console.error("Memory migration failed, will retry next launch", e);
      return;
    }
  }
  localStorage.setItem(MIGRATED_FLAG_KEY, "1");
}

export const useMemoryStore = create<MemoryState>()((set, get) => ({
  entries: [],
  embedModel: (typeof localStorage !== "undefined" && localStorage.getItem(EMBED_MODEL_KEY)) || "nomic-embed-text",
  hydrated: false,

  addEntry: (entry) => {
    set((s) => ({ entries: [entry, ...s.entries] }));
    if (isTauri()) {
      invoke("memory_upsert", {
        id: entry.id,
        text: entry.text,
        embedding: entry.embedding,
        tags: tagsToDb(entry.tags),
        source: entry.source,
        createdAt: entry.createdAt,
      }).catch((e) => console.error("memory_upsert failed", e));
    }
    // Browser mode: no backend — the entry just lives in memory for this
    // session (see module doc / report for the documented limitation).
  },

  removeEntry: (id) => {
    set((s) => ({ entries: s.entries.filter((e) => e.id !== id) }));
    if (isTauri()) {
      invoke("memory_delete", { id }).catch((e) => console.error("memory_delete failed", e));
    }
  },

  setEmbedModel: (model) => {
    set({ embedModel: model });
    try {
      localStorage.setItem(EMBED_MODEL_KEY, model);
    } catch {
      // ignore — non-fatal
    }
  },

  loadFromDb: async () => {
    if (get().hydrated) return;
    if (!isTauri()) {
      // Browser-mode fallback: no Rust/SQLite backend available. Fall back to
      // whatever the old localStorage persist blob has, so the web build
      // doesn't crash and existing dev data isn't invisible. New memories
      // added this session are NOT persisted (in-memory only) until the app
      // is run inside Tauri.
      set({ entries: readLegacyEntries(), hydrated: true });
      return;
    }
    try {
      await migrateLegacyIfNeeded();
      const rows = await invoke<DbMemoryRow[]>("memory_all");
      set({ entries: rows.map(rowToEntry), hydrated: true });
    } catch (e) {
      console.error("Failed to load memories from SQLite", e);
      set({ hydrated: true });
    }
  },
}));
