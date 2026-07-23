/**
 * KM4a — per-class concept graph extraction + storage.
 *
 * Builds a lightweight knowledge graph (concepts + labeled relations between
 * them) out of a class's already-ingested knowledge chunks (KM0/KM1), keeping
 * every node/edge's SOURCE chunk references so the graph stays citeable —
 * same `[collection/sourceUri location]` anchor shape KM3/citationsRehype.ts
 * already use for chunk citations. This module only does extraction +
 * persistence; rendering an interactive visual graph is KM4b's job. For
 * KM4a, KnowledgeHub.tsx renders the stored graph as a plain cited concept
 * list (see its "Concept Map" section).
 *
 * ─── Pipeline ────────────────────────────────────────────────────────────────
 * 1. Read the collection's knowledge chunks out of the memory store (sorted
 *    by docId then chunkIndex, so batches roughly track document order).
 * 2. Batch chunks ~4 at a time and, SEQUENTIALLY (one batch at a time, never
 *    in parallel — protects VRAM the same way ingest.ts's sequential embed
 *    loop does), ask the `digest` model role (src/lib/modelRoles.ts — the
 *    small/fast model, not the user's primary chat model) to pull out the
 *    concepts and relations actually present in that batch's text, as strict
 *    JSON. A single batch's extraction failing (bad JSON, digest() returning
 *    null) never aborts the whole build — it just contributes nothing.
 * 3. Aggregate every batch's `{concepts, relations}` into a deduplicated node/
 *    edge set (`aggregateGraph`, exported separately so it's unit-testable in
 *    isolation from the model-calling/DB-writing side of this module).
 * 4. Persist the whole graph via `kb_replace_graph` (src-tauri/src/db.rs),
 *    which always *replaces* a collection's prior graph wholesale — this
 *    module never attempts an incremental patch, since a full rebuild rereads
 *    every chunk anyway.
 *
 * ─── Cancellation ────────────────────────────────────────────────────────────
 * `buildGraph` accepts an optional `AbortSignal`. Aborting stops the batch
 * loop from starting any *further* batch (checked at the top of each
 * iteration; a batch already in flight when abort fires still finishes, since
 * `digest()` itself also honors the signal and returns quickly). Whatever was
 * extracted before the abort is still aggregated and PERSISTED — cancel loses
 * time, not already-completed work — and the returned promise resolves
 * normally (not rejected) with however many nodes/edges made it in. Callers
 * that care whether a build ran to completion should inspect `signal.aborted`
 * themselves after the call returns; this module does not throw an
 * AbortError, since a partially-built (and now-saved) graph is a genuinely
 * useful, non-error outcome.
 */
import { useMemoryStore, type MemoryEntry } from "../../store/memory";
import { digest } from "../modelRoles";

// Mirrors src/store/memory.ts's isTauri()/invoke() helpers (not exported
// there, so duplicated here rather than reached into another module's
// private internals — same tradeoff src/store/knowledge.ts and
// src/lib/knowledge/ingest.ts already made).
function isTauri(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { __TAURI__?: unknown }).__TAURI__;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const w = window as unknown as Record<string, unknown>;
  const tauri = w.__TAURI__ as { core: { invoke: (c: string, a?: unknown) => Promise<T> } };
  return tauri.core.invoke(cmd, args);
}

/** A single citeable source location a node/edge was extracted from — same
 *  three fields as a knowledge MemoryEntry's provenance (src/store/memory.ts),
 *  just narrowed to what's needed to render/copy a citation anchor. */
export interface ChunkRef {
  docId: string;
  sourceUri: string;
  location: string;
}

export interface KbNode {
  /** `${collectionId}::${normalizedName}` — see normalizeKey/aggregateGraph. */
  id: string;
  /** Display name — the first-seen surface form of this concept. */
  name: string;
  chunkRefs: ChunkRef[];
}

export interface KbEdge {
  /** `${collectionId}::${sourceId}->${targetId}::${label.toLowerCase()}`. */
  id: string;
  sourceId: string;
  targetId: string;
  label: string;
  chunkRefs: ChunkRef[];
}

export interface GraphProgress {
  phase: "reading" | "extracting" | "saving" | "done" | "error";
  /** Batches completed so far (meaningful during "extracting"/"saving"/"done"). */
  done: number;
  /** Total batches this build will process. */
  total: number;
  /** Populated only when phase === "error". */
  error?: string;
}

/** One batch's raw (already JSON-parsed and shape-validated) extraction
 *  result — exported so aggregateGraph's unit tests can construct fixtures
 *  without going through parseGraphJson's string parsing. */
export interface BatchExtraction {
  concepts: string[];
  relations: { from: string; to: string; label: string }[];
}

// ─── Aggregation (pure — no I/O, no model calls) ───────────────────────────

/** Defensive cap on total distinct concepts a single build can produce — a
 *  pathological run (e.g. the digest model going off the rails on a huge
 *  class) can't blow up the stored graph past this size. New concepts past
 *  the cap are silently dropped (relations that would have referenced them
 *  are then dropped too, as dangling, by the normal endpoint-resolution
 *  check below — no special-casing needed). */
export const MAX_NODES = 300;
/** Same idea for edges, sized generously relative to MAX_NODES (a concept
 *  graph is typically sparser than fully-connected, but batches can each
 *  contribute a handful of relations among the same few concepts). */
export const MAX_EDGES = 1200;

function normalizeKey(name: string): string {
  return name.trim().toLowerCase();
}

function chunkRefKey(r: ChunkRef): string {
  return `${r.docId}::${r.sourceUri}::${r.location}`;
}

/** Dedupe a list of ChunkRefs by (docId, sourceUri, location), keeping the
 *  first occurrence's object identity. Used both when a single batch's own
 *  refs might repeat (won't normally happen, but chunks are cheap to re-check)
 *  and when merging a node/edge's existing refs with a new batch's. */
function dedupeChunkRefs(refs: ChunkRef[]): ChunkRef[] {
  const seen = new Map<string, ChunkRef>();
  for (const r of refs) {
    const key = chunkRefKey(r);
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

/**
 * Aggregate every batch's extraction result into a deduplicated node/edge set
 * for `collectionId`. Pure and synchronous — no model calls, no DB access —
 * so it's directly unit-testable (see the scratchpad smoke test referenced in
 * this work's report).
 *
 * `batchResults[i]` and `chunkRefsPerBatch[i]` must correspond to the same
 * batch (same index) — `chunkRefsPerBatch[i]` is the list of chunks that
 * batch's prompt was built from, attributed to every concept/relation that
 * batch's result mentions (extraction doesn't tell us which specific chunk
 * within a batch a concept came from, only which batch).
 *
 * Two passes, deliberately in this order:
 *  1. Concepts → nodes, across ALL batches first. Same normalized key
 *     (`name.trim().toLowerCase()`) merges into one node, unioning chunkRefs
 *     and keeping the first-seen surface form as the display `name`.
 *  2. Relations → edges, only AFTER every batch's concepts have been
 *     registered — so a relation in batch 1 that references a concept first
 *     introduced in batch 3 still resolves, instead of being dropped as
 *     dangling purely because of batch order. A relation is kept only if
 *     BOTH endpoints resolve (by normalized key) to a known node; otherwise
 *     it's dropped as dangling. Self-loops (from === to) are also dropped —
 *     not a meaningful "relationship between two concepts".
 */
export function aggregateGraph(
  batchResults: BatchExtraction[],
  collectionId: string,
  chunkRefsPerBatch: ChunkRef[][],
): { nodes: KbNode[]; edges: KbEdge[] } {
  const nodesByKey = new Map<string, KbNode>();

  batchResults.forEach((result, i) => {
    const batchRefs = dedupeChunkRefs(chunkRefsPerBatch[i] ?? []);
    for (const rawName of result?.concepts ?? []) {
      const name = typeof rawName === "string" ? rawName.trim() : "";
      const key = normalizeKey(name);
      if (!key) continue;
      const existing = nodesByKey.get(key);
      if (existing) {
        existing.chunkRefs = dedupeChunkRefs([...existing.chunkRefs, ...batchRefs]);
      } else if (nodesByKey.size < MAX_NODES) {
        nodesByKey.set(key, { id: `${collectionId}::${key}`, name, chunkRefs: batchRefs });
      }
      // At cap: silently drop new concepts (see MAX_NODES doc comment).
    }
  });

  const edgesById = new Map<string, KbEdge>();
  batchResults.forEach((result, i) => {
    const batchRefs = dedupeChunkRefs(chunkRefsPerBatch[i] ?? []);
    for (const rel of result?.relations ?? []) {
      if (!rel) continue;
      const fromKey = normalizeKey(typeof rel.from === "string" ? rel.from : "");
      const toKey = normalizeKey(typeof rel.to === "string" ? rel.to : "");
      const label = typeof rel.label === "string" ? rel.label.trim() : "";
      if (!fromKey || !toKey || !label) continue;
      if (fromKey === toKey) continue; // self-loop — not a meaningful relation

      const srcNode = nodesByKey.get(fromKey);
      const tgtNode = nodesByKey.get(toKey);
      if (!srcNode || !tgtNode) continue; // dangling endpoint — drop

      const edgeId = `${collectionId}::${srcNode.id}->${tgtNode.id}::${label.toLowerCase()}`;
      const existing = edgesById.get(edgeId);
      if (existing) {
        existing.chunkRefs = dedupeChunkRefs([...existing.chunkRefs, ...batchRefs]);
      } else if (edgesById.size < MAX_EDGES) {
        edgesById.set(edgeId, {
          id: edgeId,
          sourceId: srcNode.id,
          targetId: tgtNode.id,
          label,
          chunkRefs: batchRefs,
        });
      }
    }
  });

  return { nodes: [...nodesByKey.values()], edges: [...edgesById.values()] };
}

// ─── Model-facing extraction ────────────────────────────────────────────────

const EXTRACTION_SYSTEM_PROMPT =
  "You extract a lightweight concept graph from study notes. Respond with ONLY strict JSON — no prose, no markdown fences, no explanation.";

/** ~4 chunks per digest call — keeps the prompt modest for a small model
 *  while still giving it enough surrounding context to find relations
 *  between concepts that span a couple of chunks. */
const BATCH_SIZE = 4;

function buildExtractionPrompt(batch: MemoryEntry[]): string {
  const excerpts = batch
    .map((e, i) => {
      const anchor = [e.sourceUri, e.location].filter(Boolean).join(" ");
      return `--- Excerpt ${i + 1}${anchor ? ` [${anchor}]` : ""} ---\n${e.text}`;
    })
    .join("\n\n");
  return [
    "Read the following excerpt(s) from a student's class notes and extract:",
    "- \"concepts\": short noun-phrase topics (2-5 words) that this text is ACTUALLY about — not generic filler words.",
    "- \"relations\": short verb-phrase links between two of those concepts, e.g. \"causes\", \"is a type of\", \"depends on\".",
    "",
    "Respond with STRICT JSON only, in exactly this shape:",
    '{"concepts": ["concept one", "concept two"], "relations": [{"from": "concept one", "to": "concept two", "label": "relation label"}]}',
    "",
    "If this excerpt has nothing substantive to extract, respond with exactly:",
    '{"concepts": [], "relations": []}',
    "",
    excerpts,
  ].join("\n");
}

/** Pull the largest `{...}` block out of possibly-fenced model output and
 *  parse it defensively (crib of vectorMemory.ts's parseFactsJson, adapted
 *  for this module's object shape instead of a bare string array). Never
 *  throws — any parse/shape failure degrades to an empty extraction, so one
 *  bad batch just contributes nothing rather than aborting the whole build. */
function parseGraphJson(raw: string): BatchExtraction {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return { concepts: [], relations: [] };
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object") return { concepts: [], relations: [] };
    const obj = parsed as { concepts?: unknown; relations?: unknown };

    const concepts = Array.isArray(obj.concepts)
      ? obj.concepts
          .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
          .map((c) => c.trim())
      : [];

    const relations = Array.isArray(obj.relations)
      ? obj.relations
          .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
          .map((r) => ({
            from: typeof r.from === "string" ? r.from.trim() : "",
            to: typeof r.to === "string" ? r.to.trim() : "",
            label: typeof r.label === "string" ? r.label.trim() : "",
          }))
          .filter((r) => r.from && r.to && r.label)
      : [];

    return { concepts, relations };
  } catch {
    return { concepts: [], relations: [] };
  }
}

/** Ensure the in-memory memory-store cache is hydrated before reading a
 *  collection's chunks — mirrors vectorMemory.ts's ensureHydrated (not
 *  exported there, so a two-line duplicate here rather than a cross-module
 *  reach into a private helper). */
async function ensureHydrated(): Promise<void> {
  const { hydrated, loadFromDb } = useMemoryStore.getState();
  if (!hydrated) await loadFromDb();
}

/**
 * Build (or rebuild) the concept graph for a class from its ingested
 * knowledge chunks. See the module doc comment for the full pipeline and the
 * cancellation contract. Throws only for a catastrophic precondition failure
 * (no knowledge chunks in the class at all) — every per-batch extraction
 * failure degrades silently instead of throwing.
 */
export async function buildGraph(
  collectionId: string,
  onProgress?: (p: GraphProgress) => void,
  signal?: AbortSignal,
): Promise<{ nodes: number; edges: number }> {
  if (!isTauri()) {
    throw new Error("Concept maps require the desktop app (Tauri) — not available in browser mode.");
  }

  onProgress?.({ phase: "reading", done: 0, total: 0 });
  await ensureHydrated();

  const entries = useMemoryStore
    .getState()
    .entries.filter((e) => e.source === "knowledge" && e.collection === collectionId)
    .sort((a, b) => {
      const docCmp = (a.docId ?? "").localeCompare(b.docId ?? "");
      if (docCmp !== 0) return docCmp;
      return (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0);
    });

  if (entries.length === 0) {
    throw new Error("No documents in this class yet — upload some notes before building a concept map.");
  }

  const batches: MemoryEntry[][] = [];
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    batches.push(entries.slice(i, i + BATCH_SIZE));
  }
  const total = batches.length;

  const batchResults: BatchExtraction[] = [];
  const chunkRefsPerBatch: ChunkRef[][] = [];

  for (let i = 0; i < batches.length; i++) {
    // Cancellation: stop starting further batches (see module doc comment's
    // "Cancellation" section) — whatever was already extracted is still
    // aggregated and saved below, not discarded.
    if (signal?.aborted) break;

    onProgress?.({ phase: "extracting", done: i, total });

    const batch = batches[i];
    chunkRefsPerBatch.push(
      batch.map((e) => ({ docId: e.docId ?? "", sourceUri: e.sourceUri ?? "", location: e.location ?? "" })),
    );

    const out = await digest(EXTRACTION_SYSTEM_PROMPT, buildExtractionPrompt(batch), signal);
    batchResults.push(out == null ? { concepts: [], relations: [] } : parseGraphJson(out));
  }

  onProgress?.({ phase: "extracting", done: batchResults.length, total });

  const { nodes, edges } = aggregateGraph(batchResults, collectionId, chunkRefsPerBatch);

  onProgress?.({ phase: "saving", done: total, total });
  try {
    await invoke("kb_replace_graph", {
      collection: collectionId,
      nodes: nodes.map((n) => ({ id: n.id, name: n.name, chunk_refs: JSON.stringify(n.chunkRefs) })),
      edges: edges.map((e) => ({
        id: e.id,
        source_id: e.sourceId,
        target_id: e.targetId,
        label: e.label,
        chunk_refs: JSON.stringify(e.chunkRefs),
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress?.({ phase: "error", done: batchResults.length, total, error: message });
    throw err;
  }

  onProgress?.({ phase: "done", done: total, total });
  return { nodes: nodes.length, edges: edges.length };
}

// ─── Retrieval ───────────────────────────────────────────────────────────────

interface KbNodeRow {
  id: string;
  collection: string;
  name: string;
  chunk_refs: string;
  created_at: number;
}

interface KbEdgeRow {
  id: string;
  collection: string;
  source_id: string;
  target_id: string;
  label: string;
  chunk_refs: string;
  created_at: number;
}

interface KbGraphRows {
  nodes: KbNodeRow[];
  edges: KbEdgeRow[];
}

/** Parse a stored `chunk_refs` JSON column back into ChunkRef[]. Never
 *  throws — malformed/legacy data just yields no citations for that row
 *  rather than breaking the whole graph render. */
function parseChunkRefs(raw: string): ChunkRef[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is ChunkRef =>
        !!r && typeof r === "object" && typeof (r as ChunkRef).docId === "string",
    );
  } catch {
    return [];
  }
}

/** Fetch the stored concept graph for a class. Browser mode (no Tauri/SQLite
 *  backend) returns an empty graph rather than throwing. */
export async function getGraph(collectionId: string): Promise<{ nodes: KbNode[]; edges: KbEdge[] }> {
  if (!isTauri()) return { nodes: [], edges: [] };
  const raw = await invoke<KbGraphRows>("kb_get_graph", { collection: collectionId });
  return {
    nodes: raw.nodes.map((n) => ({ id: n.id, name: n.name, chunkRefs: parseChunkRefs(n.chunk_refs) })),
    edges: raw.edges.map((e) => ({
      id: e.id,
      sourceId: e.source_id,
      targetId: e.target_id,
      label: e.label,
      chunkRefs: parseChunkRefs(e.chunk_refs),
    })),
  };
}

// ─── KM4c: plain-English node summaries ─────────────────────────────────────
//
// The raw "subject — label → object" relationship list ConceptGraph.tsx shows
// when you click a node is precise but not easy to read at a glance — this
// generates a short, textbook-page-style prose explanation of a concept and
// how it connects to its neighbors instead. Generated by the same local
// `digest` model role KM4a's extraction already uses (never the user's
// primary chat model), and persisted (kb_node_summaries, src-tauri/src/db.rs)
// so it is generated AT MOST ONCE per node, not re-run on every click or
// every graph rebuild — see that table's doc comment for why it's a separate
// table from kb_nodes. Two call paths both funnel through
// `generateNodeSummary` and both check kb_get_node_summaries first:
//  1. `pregenerateHighValueSummaries` — fired (best-effort, fire-and-forget)
//     right after a concept-map build finishes, for the handful of
//     highest-degree (most-connected) nodes only, since those are the
//     concepts a student is most likely to click first and generating for
//     all 300 possible nodes up front would be slow and mostly wasted.
//  2. `ConceptGraph.tsx`'s node-click handler — generates lazily, on demand,
//     for whatever node the user actually clicks that doesn't already have
//     one (covers everything pregeneration skipped).

export interface KbNodeSummary {
  nodeId: string;
  summary: string;
  generatedAt: number;
}

interface KbNodeSummaryRow {
  node_id: string;
  summary: string;
  generated_at: number;
}

/** How many of a node's OWN chunk excerpts to pull into the summary prompt —
 *  capped small since these feed a "small/fast" digest model, not a large one. */
const MAX_EXCERPTS_PER_NODE = 3;
const MAX_EXCERPT_CHARS = 500;

const SUMMARY_SYSTEM_PROMPT =
  "You write short, clear, textbook-style explanations of a single concept for a student reviewing their class notes. " +
  "No JSON, no preamble like 'Sure, here is...'. Markdown IS allowed (this gets rendered, not shown as raw text) — " +
  "use it only where it earns its keep: write any formula in LaTeX ($...$ inline, or $$...$$ on its own line for a " +
  "standalone equation), and use *emphasis* sparingly for key terms. Do not add headers or bullet lists — write flowing prose. " +
  "Structure: (1) 1-2 sentences explaining what the concept IS in plain English, (2) how it relates to the connected " +
  "concepts listed, (3) a concrete example of the concept actually being used, (4) the relevant formula(s) IN LATEX if " +
  "this concept has one — omit part (4) entirely for concepts that aren't formula-based rather than forcing one in.";

/** Fetch every already-generated summary for a class in one round trip —
 *  callers should check this BEFORE calling generateNodeSummary for a node,
 *  since generation is meant to happen at most once per node. Browser mode
 *  returns an empty map (no SQLite backend). */
export async function getNodeSummaries(collectionId: string): Promise<Map<string, KbNodeSummary>> {
  if (!isTauri()) return new Map();
  const rows = await invoke<KbNodeSummaryRow[]>("kb_get_node_summaries", { collection: collectionId });
  const out = new Map<string, KbNodeSummary>();
  for (const r of rows) {
    out.set(r.node_id, { nodeId: r.node_id, summary: r.summary, generatedAt: r.generated_at });
  }
  return out;
}

async function persistNodeSummary(nodeId: string, summary: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("kb_set_node_summary", { nodeId, summary });
}

/** Pulls up to MAX_EXCERPTS_PER_NODE chunks of the node's own source text out
 *  of the memory store, for the summary prompt to actually explain FROM —
 *  same matching logic as ConceptGraph.tsx's resolveChunkSnippet (by
 *  collection/sourceUri/location), generalized to more than one ref and
 *  without the citation-preview-specific sourcePath return value. */
async function resolveNodeExcerptText(collectionId: string, node: KbNode): Promise<string> {
  await ensureHydrated();
  const entries = useMemoryStore.getState().entries;
  const texts: string[] = [];
  for (const ref of node.chunkRefs.slice(0, MAX_EXCERPTS_PER_NODE)) {
    const match = entries.find(
      (e) =>
        e.source === "knowledge" &&
        e.collection === collectionId &&
        e.sourceUri === ref.sourceUri &&
        (e.location === ref.location || (ref.location !== "" && !!e.location?.startsWith(ref.location))),
    );
    if (match) texts.push(match.text.slice(0, MAX_EXCERPT_CHARS));
  }
  return texts.join("\n\n");
}

function buildNodeSummaryPrompt(
  node: KbNode,
  outgoing: KbEdge[],
  incoming: KbEdge[],
  nodeById: Map<string, KbNode>,
  excerptText: string,
): string {
  const relationLines = [
    ...outgoing.map((e) => `${node.name} — ${e.label} → ${nodeById.get(e.targetId)?.name ?? "?"}`),
    ...incoming.map((e) => `${nodeById.get(e.sourceId)?.name ?? "?"} — ${e.label} → ${node.name}`),
  ];
  return [
    `Concept: ${node.name}`,
    "",
    relationLines.length > 0
      ? `Known relationships:\n${relationLines.join("\n")}`
      : "No extracted relationships to other concepts yet.",
    "",
    excerptText
      ? `Relevant excerpt(s) from the source notes:\n${excerptText}`
      : "(no source excerpt available — explain from the relationships alone)",
  ].join("\n");
}

/** Generate (never re-generate — caller must check getNodeSummaries first) a
 *  plain-English summary for one node, and persist it. Returns null (rather
 *  than throwing) on any failure — digest() unavailable, model error, etc. —
 *  since this is always a best-effort enhancement to the raw relationship
 *  list, never something a caller should treat as required for the concept
 *  map to function. */
export async function generateNodeSummary(
  collectionId: string,
  node: KbNode,
  edges: KbEdge[],
  nodeById: Map<string, KbNode>,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const outgoing = edges.filter((e) => e.sourceId === node.id);
    const incoming = edges.filter((e) => e.targetId === node.id);
    const excerptText = await resolveNodeExcerptText(collectionId, node);
    const prompt = buildNodeSummaryPrompt(node, outgoing, incoming, nodeById, excerptText);
    const out = await digest(SUMMARY_SYSTEM_PROMPT, prompt, signal);
    const summary = out?.trim();
    if (!summary) return null;
    await persistNodeSummary(node.id, summary);
    return summary;
  } catch {
    return null;
  }
}

/** How many of the most-connected nodes get a summary proactively generated
 *  right after a build, before the user has clicked anything. Deliberately
 *  small and sequential (one digest() call at a time, same VRAM-protecting
 *  reasoning as buildGraph's batch loop) — this runs in the background while
 *  the user is already looking at the freshly-built graph, so it shouldn't
 *  compete hard for the local model. */
const HIGH_VALUE_NODE_COUNT = 12;

/**
 * Best-effort, fire-and-forget: generate summaries for the highest-degree
 * (most-connected) nodes in a freshly built graph, skipping any that already
 * have one. Meant to be called right after `buildGraph` resolves, WITHOUT
 * awaiting it from the build-progress UI — see the module doc comment above.
 * Swallows all errors per-node (one failure shouldn't stop the rest) and
 * respects `signal` between nodes (checked, not passed into a still-running
 * digest() call, mirroring buildGraph's own cancellation contract).
 */
export async function pregenerateHighValueSummaries(
  collectionId: string,
  nodes: KbNode[],
  edges: KbEdge[],
  signal?: AbortSignal,
): Promise<void> {
  if (nodes.length === 0) return;
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.sourceId, (degree.get(e.sourceId) ?? 0) + 1);
    degree.set(e.targetId, (degree.get(e.targetId) ?? 0) + 1);
  }
  const highValue = [...nodes]
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .slice(0, HIGH_VALUE_NODE_COUNT);

  const existing = await getNodeSummaries(collectionId);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  for (const node of highValue) {
    if (signal?.aborted) return;
    if (existing.has(node.id)) continue; // already generated — never regenerate
    await generateNodeSummary(collectionId, node, edges, nodeById, signal);
  }
}
