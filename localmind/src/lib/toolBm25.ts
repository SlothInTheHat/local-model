/**
 * In-process Okapi BM25 over the tool catalog — the default, always-on
 * per-round ranking signal for tool retrieval (see toolFilter.ts).
 *
 * Deliberately NOT a SQLite FTS5 table (unlike sessions_fts in db.rs, which
 * this mirrors in spirit): the tool catalog is small (~86 built-ins) and
 * rebuildable instantly from data already in memory, with no need to
 * survive app restarts the way accumulated session transcripts do. Routing
 * every round's ranking through a Tauri IPC round-trip would also silently
 * degrade in browser/dev mode (no Rust backend there — see CLAUDE.md),
 * which this deliberately avoids by staying pure TypeScript.
 */
import type { ToolDef } from "./tools";
import { effectiveAliases } from "./tools";

interface IndexedDoc {
  name: string;
  termFreq: Map<string, number>;
  length: number;
}

export interface ToolBm25Index {
  docs: IndexedDoc[];
  avgDocLength: number;
  docFreq: Map<string, number>; // token -> number of docs containing it
  totalDocs: number;
}

const TOKEN_RE = /[a-z0-9]+/g;

function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_RE) ?? [];
}

/** The indexed text for one tool: name (underscores split into words) +
 *  description + effective aliases (hand-authored + the free TOOL_ALIASES
 *  backfill) + useWhen phrasings. Mirrors toolFilter.ts's existing
 *  name+description convention, extended with the two new ToolDef fields. */
function toolDocument(tool: ToolDef): string {
  const parts = [tool.name.replace(/_/g, " "), tool.description];
  const aliases = effectiveAliases(tool);
  if (aliases.length > 0) parts.push(aliases.join(" ").replace(/_/g, " "));
  if (tool.useWhen && tool.useWhen.length > 0) parts.push(tool.useWhen.join(" "));
  return parts.join(" ");
}

/** Builds a fresh index from the current tool list — cheap enough (~86
 *  short documents) to rebuild every round rather than maintain incremental
 *  update logic; callers wanting to avoid even that should memoize on their
 *  own (see agentRuntime.ts's retrieval-objective memoization). */
export function buildToolIndex(tools: ToolDef[]): ToolBm25Index {
  const docs: IndexedDoc[] = [];
  const docFreq = new Map<string, number>();
  let totalLength = 0;

  for (const tool of tools) {
    const tokens = tokenize(toolDocument(tool));
    const termFreq = new Map<string, number>();
    for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
    for (const t of termFreq.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    docs.push({ name: tool.name, termFreq, length: tokens.length });
    totalLength += tokens.length;
  }

  return {
    docs,
    avgDocLength: docs.length > 0 ? totalLength / docs.length : 0,
    docFreq,
    totalDocs: docs.length,
  };
}

const K1 = 1.5;
const B = 0.75;

/**
 * Standard Okapi BM25 scoring of every indexed tool against `query`. Returns
 * a Map from tool name to RAW (unbounded, higher-is-better, 0 = no match)
 * BM25 score — raw scores aren't comparable across different queries, so
 * callers blending this with another 0..1 signal (e.g. embedding cosine)
 * should run it through `normalizeScores` first. Pure/instant: no network
 * call, safe to run unconditionally every round at this corpus size.
 */
export function bm25Score(index: ToolBm25Index, query: string): Map<string, number> {
  const queryTokens = Array.from(new Set(tokenize(query)));
  const scores = new Map<string, number>();

  if (queryTokens.length === 0 || index.totalDocs === 0) {
    for (const doc of index.docs) scores.set(doc.name, 0);
    return scores;
  }

  for (const doc of index.docs) {
    let score = 0;
    for (const term of queryTokens) {
      const df = index.docFreq.get(term);
      if (!df) continue; // term never appears anywhere in the corpus
      const tf = doc.termFreq.get(term) ?? 0;
      if (tf === 0) continue;
      const idf = Math.log((index.totalDocs - df + 0.5) / (df + 0.5) + 1);
      const denom = tf + K1 * (1 - B + (B * doc.length) / (index.avgDocLength || 1));
      score += idf * ((tf * (K1 + 1)) / denom);
    }
    scores.set(doc.name, score);
  }
  return scores;
}

/** Min-max normalizes a score map to 0..1 so it can be blended with another
 *  0..1 signal. An empty or perfectly-flat map (e.g. every score 0 because
 *  nothing matched) normalizes to all-zero rather than dividing by zero. */
export function normalizeScores(scores: Map<string, number>): Map<string, number> {
  const values = Array.from(scores.values());
  if (values.length === 0) return scores;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range === 0) {
    return new Map(Array.from(scores.keys()).map((k) => [k, 0]));
  }
  return new Map(Array.from(scores.entries()).map(([k, v]) => [k, (v - min) / range]));
}

/** How ambiguous a round's top BM25 results are — the signal that decides
 *  whether the (costly, live-Ollama-call) embedding fallback should run at
 *  all. "Ambiguous" means either nothing scored meaningfully (top score
 *  near the floor) or the top candidates are too close together for BM25
 *  alone to have discriminated well between them. */
export function isRankingAmbiguous(rawScores: Map<string, number>): boolean {
  const sorted = Array.from(rawScores.values()).sort((a, b) => b - a);
  if (sorted.length === 0) return true;
  const top = sorted[0];
  if (top <= 0.01) return true; // nothing lexically matched at all
  const fifth = sorted[Math.min(4, sorted.length - 1)];
  // Top-1 and top-5 bunched together (BM25 isn't discriminating) — a real
  // gap between the best match and the rest is a confident lexical result.
  return top > 0 && (top - fifth) / top < 0.15;
}
