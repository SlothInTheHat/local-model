import type { ChatMessage } from "./ollama";
import type { MemoryEntry } from "../store/memory";
import { useMemoryStore, touchMemories } from "../store/memory";
import { getOllamaBaseUrl } from "./ollama";
import { digest } from "./modelRoles";

export async function embedText(text: string, model: string): Promise<number[]> {
  const res = await fetch(`${getOllamaBaseUrl()}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text }),
  });
  if (!res.ok) throw new Error(`Embed request failed: ${res.status}`);
  const data = await res.json() as { embeddings: number[][] };
  const emb = data.embeddings?.[0];
  if (!emb) throw new Error("No embedding returned");
  return emb;
}

/** Exported so callers that need raw cosine (e.g. skillEngine's embedding-based
 *  matching, and this module's own dedup check) don't duplicate the math. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/** Ensure the in-memory cache is hydrated from the SQLite backend (or, in
 *  browser mode, from the legacy localStorage blob) before it is read/written.
 *  Cheap no-op once hydrated — safe to call on every addMemory/searchMemory. */
async function ensureHydrated(): Promise<void> {
  const { hydrated, loadFromDb } = useMemoryStore.getState();
  if (!hydrated) await loadFromDb();
}

/** Embed text and save it to the persistent memory store (SQLite via
 *  useMemoryStore's addEntry, which writes through to the `memory_upsert`
 *  Tauri command — see src/store/memory.ts). */
export async function addMemory(
  text: string,
  tags: string[] = [],
  source: "user" | "agent" | "session-digest" = "user"
): Promise<MemoryEntry> {
  await ensureHydrated();
  const { embedModel, addEntry } = useMemoryStore.getState();
  const embedding = await embedText(text, embedModel);
  const entry: MemoryEntry = {
    id: crypto.randomUUID(),
    text,
    embedding,
    tags,
    source,
    createdAt: Date.now(),
  };
  addEntry(entry);
  return entry;
}

/** Days in a recency half-life-ish decay window (see recencyDecay below). */
const RECENCY_DECAY_DAYS = 90;
/** recencyDecay never drops below this — an old-but-relevant memory still surfaces. */
const RECENCY_FLOOR = 0.5;
/** Cap on how much repeated use can boost a score. */
const USAGE_BOOST_CAP = 0.3;

/**
 * Find the most relevant memories for a query. Falls back to keyword search
 * when the embed model is unavailable.
 *
 * Returned `score` is cosine similarity adjusted by recency (newer memories
 * rank higher) and usage (memories retrieved often rank higher) — see
 * recencyDecay/usageBoost below. `rawScore` is the unadjusted cosine, kept
 * alongside for callers (e.g. the dedup check in distillAndSaveMemories) that
 * need pure semantic similarity rather than a ranking score. `threshold`
 * filters on `rawScore`, NOT the adjusted score, so the relevance floor stays
 * meaningful regardless of how old/(un)used a memory is.
 *
 * Usage boosting is live: memory_all (src-tauri/src/db.rs) returns
 * last_used_at/use_count (COALESCEd to created_at/0 for pre-existing rows),
 * and each memory returned here gets a fire-and-forget `memory_touch` bump —
 * never awaited in the scoring path, errors swallowed, DB write skipped
 * outside Tauri. Recency stays anchored on createdAt (age of the fact);
 * retrieval frequency is rewarded by usageBoost, not by resetting decay.
 */
export async function searchMemory(
  query: string,
  topK = 5,
  threshold = 0.35
): Promise<Array<{ entry: MemoryEntry; score: number; rawScore: number }>> {
  await ensureHydrated();
  const { entries, embedModel } = useMemoryStore.getState();
  if (entries.length === 0) return [];

  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedText(query, embedModel);
  } catch {
    // Embedding model unavailable — fall back to keyword matching
    const q = query.toLowerCase();
    return entries
      .filter((e) => e.text.toLowerCase().includes(q) || e.tags.some((t) => q.includes(t)))
      .slice(0, topK)
      .map((entry) => ({ entry, score: 0.5, rawScore: 0.5 }));
  }

  const now = Date.now();
  const results = entries
    .map((entry) => ({
      entry,
      rawScore: entry.embedding.length > 0 ? cosineSimilarity(queryEmbedding, entry.embedding) : 0,
    }))
    .filter(({ rawScore }) => rawScore >= threshold)
    .map(({ entry, rawScore }) => {
      const ageDays = Math.max(0, (now - entry.createdAt) / (1000 * 60 * 60 * 24));
      const recencyDecay = Math.max(RECENCY_FLOOR, Math.exp(-ageDays / RECENCY_DECAY_DAYS));
      const usageBoost = 1 + Math.min(USAGE_BOOST_CAP, 0.1 * Math.log1p(entry.useCount ?? 0));
      return { entry, rawScore, score: rawScore * recencyDecay * usageBoost };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  // Fire-and-forget (must not delay or fail the search) — see doc comment.
  touchMemories(results.map((r) => r.entry.id));
  return results;
}

export function formatMemoriesForContext(
  results: Array<{ entry: MemoryEntry; score: number }>
): string {
  if (results.length === 0) return "";
  const lines = results.map(
    ({ entry }) =>
      `- ${entry.text}${entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : ""}`
  );
  return `## Relevant Memories\n${lines.join("\n")}`;
}

/** A fact scores at or above this cosine similarity to something already
 *  stored is treated as a near-duplicate and skipped (dedup). */
const DEDUP_COSINE_THRESHOLD = 0.92;
// DIGEST_MAX_CHARS moved to src/lib/modelRoles.ts alongside the `digest()`
// seam that enforces it. It briefly lived here and was imported by modelRoles,
// which made vectorMemory <-> modelRoles a genuine import cycle. That happened
// to work (both uses were inside function bodies), but this codebase has
// already been bitten once by a cycle's temporal dead zone — see the
// "Cannot access 'TOOL_DEFINITIONS' before initialization" note in
// headlessRunner.ts. Not worth keeping a live cycle for one constant.

/** Pull the largest [...] block out of possibly-fenced model output and parse
 *  it defensively (crib of agentRuntime's parseSkillJson, adapted for an array
 *  of strings instead of an object). Never throws. */
function parseFactsJson(raw: string): string[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((s) => s.trim())
      .slice(0, 3);
  } catch {
    return [];
  }
}

/**
 * Post-session write-back: ask the model to distill 0-3 DURABLE facts
 * (user preferences, project facts, environment quirks — NOT one-off task
 * details) out of the just-finished session, then save whichever aren't
 * near-duplicates of an existing memory. Entirely best-effort — every
 * failure path degrades to a silent no-op; callers should still wrap the call
 * in their own try/catch as a second safety net (this must never affect the
 * session result).
 */
export async function distillAndSaveMemories(
  taskQuery: string,
  finalHistory: ChatMessage[],
  signal: AbortSignal,
): Promise<void> {
  const toolSummaries = finalHistory
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content.slice(0, 160) : ""))
    .filter(Boolean)
    .slice(0, 20);

  const prompt = [
    "Review this just-finished session and extract DURABLE facts worth remembering across FUTURE, UNRELATED sessions — things like user preferences (coding style, tool choices), stable project facts (\"this repo uses pnpm\"), or environment quirks (\"tests need --no-sandbox on this machine\").",
    `Original request: ${taskQuery}`,
    toolSummaries.length ? `Actions taken:\n- ${toolSummaries.join("\n- ")}` : "",
    "",
    "Do NOT include one-off task details, specific file names/paths, or anything only meaningful to this single session.",
    'Respond with ONLY a JSON array of up to 3 short strings, e.g. ["fact one", "fact two"]. If nothing durable came out of this session, respond with [].',
  ].filter(Boolean).join("\n");

  const out = await digest(
    "You extract durable, cross-session facts. Respond with only a JSON array, no prose or fences.",
    prompt,
    signal,
  );
  if (out == null) return; // digest call failed (no digest model / model / network) — degrade silently

  const facts = parseFactsJson(out);
  for (const fact of facts) {
    try {
      const existing = await searchMemory(fact, 3, 0);
      const bestSim = existing.length > 0 ? Math.max(...existing.map((r) => r.rawScore)) : 0;
      if (bestSim > DEDUP_COSINE_THRESHOLD) continue; // near-duplicate — skip
      await addMemory(fact, [], "session-digest");
    } catch {
      // one failed fact shouldn't block the rest
    }
  }
}
