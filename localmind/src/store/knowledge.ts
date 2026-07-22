/**
 * KM1 — Knowledge Hub store: collections (classes) + document ingestion.
 *
 * Deliberately NOT a zustand `persist` store — the actual data (collections,
 * knowledge chunks) lives in SQLite via src-tauri/src/db.rs, same as
 * src/store/memory.ts. This store is just a thin, reactive cache over the
 * `collection_*` Tauri commands plus a live `ingesting`/`progress` pair KM2
 * can render as a progress bar during `ingest()`.
 */
import { create } from "zustand";
import { ingestFiles } from "../lib/knowledge/ingest";
import type { IngestProgress } from "../lib/knowledge/types";
import { buildGraph as buildGraphImpl, getGraph as getGraphImpl, type GraphProgress, type KbNode, type KbEdge } from "../lib/knowledge/graph";

export interface Collection {
  id: string;
  label: string;
  createdAt: number;
  docCount: number;
}

export interface DocRow {
  docId: string;
  sourceUri: string;
  chunkCount: number;
  /** Full original file path (KM4 "open source file"), if this document was
   *  ingested after source_path started being captured. Undefined for
   *  documents ingested before then — the "Open" action hides itself. */
  sourcePath?: string;
}

// Mirrors src/store/memory.ts's isTauri()/invoke() helpers (not exported
// there, so duplicated here rather than reached into another module's
// private internals).
function isTauri(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { __TAURI__?: unknown }).__TAURI__;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const w = window as unknown as Record<string, unknown>;
  const tauri = w.__TAURI__ as { core: { invoke: (c: string, a?: unknown) => Promise<T> } };
  return tauri.core.invoke(cmd, args);
}

interface CollectionRow {
  id: string;
  label: string;
  created_at: number;
  doc_count: number;
}

interface DbDocRow {
  doc_id: string;
  source_uri: string;
  chunk_count: number;
  source_path?: string;
}

function rowToCollection(row: CollectionRow): Collection {
  return { id: row.id, label: row.label, createdAt: row.created_at, docCount: row.doc_count };
}

function rowToDoc(row: DbDocRow): DocRow {
  return {
    docId: row.doc_id,
    sourceUri: row.source_uri,
    chunkCount: row.chunk_count,
    sourcePath: row.source_path ?? undefined,
  };
}

interface KnowledgeState {
  collections: Collection[];
  /** True while an ingest() batch is running — KM2 can gate the upload UI on this. */
  ingesting: boolean;
  /** Most recent progress event from the in-flight ingest() call, if any. */
  progress: IngestProgress | null;
  /** True while a buildGraph() extraction run is in flight (KM4a) — gates the
   *  Hub's "Build concept map" button the same way `ingesting` gates Upload. */
  buildingGraph: boolean;
  /** Most recent progress event from the in-flight buildGraph() call, if any. */
  graphProgress: GraphProgress | null;

  loadCollections: () => Promise<void>;
  createCollection: (label: string) => Promise<void>;
  deleteCollection: (id: string) => Promise<void>;
  listDocs: (collectionId: string) => Promise<DocRow[]>;
  deleteDoc: (docId: string) => Promise<void>;
  ingest: (
    collectionId: string,
    filePaths: string[],
    onProgress?: (p: IngestProgress) => void,
  ) => Promise<{ docId: string; chunks: number }[]>;
  /** KM4a: (re)build a class's concept graph from its ingested chunks. See
   *  src/lib/knowledge/graph.ts's module doc comment for the full pipeline
   *  and cancellation contract; this is a thin store wrapper that tracks
   *  `buildingGraph`/`graphProgress` around the call. */
  buildGraph: (
    collectionId: string,
    onProgress?: (p: GraphProgress) => void,
    signal?: AbortSignal,
  ) => Promise<{ nodes: number; edges: number }>;
  /** KM4a: fetch a class's stored concept graph (empty if none built yet). */
  getGraph: (collectionId: string) => Promise<{ nodes: KbNode[]; edges: KbEdge[] }>;
}

export const useKnowledgeStore = create<KnowledgeState>()((set, get) => ({
  collections: [],
  ingesting: false,
  progress: null,
  buildingGraph: false,
  graphProgress: null,

  loadCollections: async () => {
    if (!isTauri()) return; // browser mode: no SQLite backend — leave empty
    try {
      const rows = await invoke<CollectionRow[]>("collections_all");
      set({ collections: rows.map(rowToCollection) });
    } catch (e) {
      console.error("Failed to load collections", e);
    }
  },

  createCollection: async (label: string) => {
    if (!isTauri()) throw new Error("Collections require the desktop app (Tauri) — not available in browser mode.");
    const id = label.trim();
    if (!id) throw new Error("Collection name cannot be empty");
    await invoke("collection_upsert", { id, label: id, createdAt: Date.now() });
    await get().loadCollections();
  },

  deleteCollection: async (id: string) => {
    if (!isTauri()) throw new Error("Collections require the desktop app (Tauri) — not available in browser mode.");
    await invoke("collection_delete", { id });
    await get().loadCollections();
  },

  listDocs: async (collectionId: string) => {
    if (!isTauri()) return [];
    const rows = await invoke<DbDocRow[]>("collection_docs", { collection: collectionId });
    return rows.map(rowToDoc);
  },

  deleteDoc: async (docId: string) => {
    if (!isTauri()) throw new Error("Documents require the desktop app (Tauri) — not available in browser mode.");
    await invoke("memory_delete_by_doc", { docId });
    await get().loadCollections();
  },

  ingest: async (collectionId, filePaths, onProgress) => {
    set({ ingesting: true, progress: null });
    try {
      const result = await ingestFiles(collectionId, filePaths, (p) => {
        set({ progress: p });
        onProgress?.(p);
      });
      await get().loadCollections();
      return result;
    } finally {
      set({ ingesting: false });
    }
  },

  buildGraph: async (collectionId, onProgress, signal) => {
    set({ buildingGraph: true, graphProgress: null });
    try {
      return await buildGraphImpl(collectionId, (p) => {
        set({ graphProgress: p });
        onProgress?.(p);
      }, signal);
    } finally {
      set({ buildingGraph: false });
    }
  },

  getGraph: async (collectionId) => {
    return getGraphImpl(collectionId);
  },
}));
