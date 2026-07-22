/**
 * KM1 — shared types for the document ingestion pipeline.
 *
 * A file is extracted into `Section`s (one per natural unit — a PDF page, a
 * markdown heading block, a whole image's vision transcription), then
 * `chunk.ts` splits any oversized section into `KnowledgeChunk`s that are
 * small enough to embed individually. Both carry a `location` — the human
 * citation anchor (e.g. "p.12", "#Eigenvalues L45") that flows straight into
 * `MemoryEntry.location` (src/store/memory.ts) and, from there, into
 * `formatMemoriesForContext`'s bracketed citation (src/lib/vectorMemory.ts).
 */

/** One naturally-delimited piece of a source document, before chunking. */
export interface Section {
  text: string;
  /** Human citation anchor for this section, e.g. "p.12" or "#Eigenvalues L45". */
  location: string;
}

/** One embed-ready piece of a source document, after chunking. */
export interface KnowledgeChunk {
  text: string;
  /** Human citation anchor — inherited from the section, with " (cont.)"
   *  appended on any chunk after the first split out of one oversized section. */
  location: string;
  /** Position of this chunk within its document (0-based, monotonically
   *  increasing across the whole file, not reset per-section). */
  chunkIndex: number;
}

/** Per-file progress callback shape for `ingestFiles` (src/lib/knowledge/ingest.ts). */
export type IngestProgress = {
  /** Basename of the file currently being processed. */
  file: string;
  phase: "reading" | "extracting" | "embedding" | "done" | "error";
  /** Chunks embedded so far (only meaningful during "embedding"). */
  done: number;
  /** Total chunks for this file (only meaningful during "embedding"). */
  total: number;
  /** Populated only when phase === "error". */
  error?: string;
};
