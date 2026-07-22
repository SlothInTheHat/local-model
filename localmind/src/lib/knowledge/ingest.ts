/**
 * KM1 — document ingestion orchestrator.
 *
 * Ties together the per-format extractors (pdf.ts / markdown.ts / image.ts),
 * chunk.ts, and vectorMemory.ts's addMemory into one `ingestFiles` call: for
 * each file, wipe any previously-ingested chunks for that same filename
 * (memory_delete_by_doc), extract + chunk it, then embed each chunk
 * sequentially into the given collection. Embedding is sequential (not
 * parallel) deliberately — embedText is not behind the generation gate
 * (src/lib/generationGate.ts), and sequential is the simplest way to avoid
 * hammering Ollama with a burst of concurrent embed requests for one file.
 *
 * ─── docId contract (KM2/KM3 should match this) ────────────────────────────
 * `docId = "<collectionId>::<sourceUri>"`, where `sourceUri` is the file's
 * basename (not its full path — a user's home-directory path is not
 * something to leak into citations). This is deterministic by filename, not
 * file content — re-ingesting a file with the same name into the same
 * collection is treated as "replace this document" (old chunks deleted
 * first via memory_delete_by_doc), which is the whole point of the
 * re-ingestion behavior below. Ingesting two *different* files that happen
 * to share a basename into the same collection will collide (the second
 * ingest wipes the first's chunks); that's an accepted tradeoff for a
 * simple, predictable id rather than a content hash.
 *
 * ─── location anchor contract ───────────────────────────────────────────────
 * "p.<n>" for PDF pages (pdf.ts), "#<heading> L<line>" or "L<line>" for
 * markdown/text (markdown.ts), "(image)" for images (image.ts) — see each
 * module's own doc comment. chunk.ts appends " (cont.)" to every chunk after
 * the first one split out of an oversized section.
 */
import { addMemory } from "../vectorMemory";
import { extractPdf } from "./pdf";
import { extractMarkdown } from "./markdown";
import { extractImage } from "./image";
import { chunkSections } from "./chunk";
import type { IngestProgress, Section } from "./types";

// Mirrors src/store/memory.ts's isTauri()/invoke() helpers — duplicated
// rather than imported since that module doesn't export them (they're
// intentionally private there), and this is a two-line helper, not worth an
// exported seam just to share.
function isTauri(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { __TAURI__?: unknown }).__TAURI__;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const w = window as unknown as Record<string, unknown>;
  const tauri = w.__TAURI__ as { core: { invoke: (c: string, a?: unknown) => Promise<T> } };
  return tauri.core.invoke(cmd, args);
}

/** Extensions routed to the vision-model path (image.ts). */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);
/** Extensions routed to the plain-text/markdown path (markdown.ts). */
const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt"]);

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** base64 -> Uint8Array, for pdf.js which wants raw bytes. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** base64 -> UTF-8 text, for markdown/plain-text files. */
function base64ToText(base64: string): string {
  return new TextDecoder("utf-8").decode(base64ToBytes(base64));
}

/**
 * Open the native multi-file picker (desktop only) and return the chosen
 * paths, or null if the user cancelled. Browser/dev-server mode has no
 * native dialog to call — KM2 will offer an `<input type="file">` fallback
 * there; until that lands this just rejects with a clear "desktop only"
 * message rather than silently doing nothing.
 */
export async function pickUploadFiles(): Promise<string[] | null> {
  if (!isTauri()) {
    throw new Error("File picker requires the desktop app (Tauri) — not available in browser mode.");
  }
  return invoke<string[] | null>("open_upload_dialog");
}

/**
 * Ingest a batch of files into a collection (creating it if it doesn't
 * already exist). Never throws for a single bad file — that file's failure
 * is reported via `onProgress({phase: "error", error})` and the batch
 * continues with the next file. Returns one result per *successfully*
 * ingested file (failed files are simply omitted from the returned array).
 */
export async function ingestFiles(
  collectionId: string,
  filePaths: string[],
  onProgress?: (p: IngestProgress) => void,
): Promise<{ docId: string; chunks: number }[]> {
  if (!isTauri()) {
    throw new Error("Document ingestion requires the desktop app (Tauri) — not available in browser mode.");
  }

  // Ensure the collection row exists before any file is ingested. id===label
  // here (KM2 can offer a friendlier rename later without touching the id
  // every memory row's `collection` column points at).
  await invoke("collection_upsert", { id: collectionId, label: collectionId, createdAt: Date.now() });

  const results: { docId: string; chunks: number }[] = [];

  for (const filePath of filePaths) {
    const file = basename(filePath);
    const sourceUri = file;
    const docId = `${collectionId}::${sourceUri}`;
    try {
      onProgress?.({ file, phase: "reading", done: 0, total: 0 });

      // Delete old chunks FIRST, so a failed re-ingest doesn't leave the
      // document half-replaced (stale chunks gone, fresh ones never written).
      await invoke("memory_delete_by_doc", { docId });

      const base64 = await invoke<string>("read_upload_bytes", { path: filePath });
      const ext = extensionOf(filePath);

      onProgress?.({ file, phase: "extracting", done: 0, total: 0 });
      let sections: Section[];
      if (ext === "pdf") {
        sections = await extractPdf(base64ToBytes(base64));
      } else if (IMAGE_EXTENSIONS.has(ext)) {
        sections = await extractImage(base64, file);
      } else if (TEXT_EXTENSIONS.has(ext)) {
        sections = extractMarkdown(base64ToText(base64));
      } else {
        throw new Error(`Unsupported file type: .${ext}`);
      }

      const chunks = chunkSections(sections);
      const total = chunks.length;
      onProgress?.({ file, phase: "embedding", done: 0, total });

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        await addMemory(chunk.text, [collectionId], "knowledge", {
          collection: collectionId,
          docId,
          sourceUri,
          location: chunk.location,
          chunkIndex: chunk.chunkIndex,
          // "Open source file" (KM4): the FULL original path, captured here —
          // this is the only place in the ingest pipeline that still has it
          // (sourceUri above is deliberately just the basename; see the
          // docId contract doc comment above for why the basename is what
          // gets baked into the citeable id/anchor instead).
          sourcePath: filePath,
        });
        onProgress?.({ file, phase: "embedding", done: i + 1, total });
      }

      onProgress?.({ file, phase: "done", done: total, total });
      results.push({ docId, chunks: total });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onProgress?.({ file, phase: "error", done: 0, total: 0, error: message });
      // Continue to the next file — one bad file must not abort the batch.
    }
  }

  return results;
}
