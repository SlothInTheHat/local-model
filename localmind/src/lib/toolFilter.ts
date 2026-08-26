import type { ToolDef } from "./tools";
import { embedText } from "./vectorMemory";
import { useMemoryStore } from "../store/memory";
import { buildToolIndex, bm25Score, normalizeScores, isRankingAmbiguous } from "./toolBm25";
import { effectiveAliases } from "./tools";

/**
 * Relevance-based MCP/dynamic-tool gating (isair/jarvis-style "context-rot"
 * prevention), redesigned around a hard rule learned from live failures:
 *
 *   ALWAYS keep every built-in LocalMind tool; gate only the EXTERNAL tools
 *   (MCP `serverId__tool` + dynamic `group:"external"` tools) by relevance.
 *
 * Why: the built-ins are few (~30), bounded, and include the action tools the
 * agent needs to actually DO things (schedule_task, register_tool, write_file…).
 * When a large MCP server is connected (Gmail+Calendar+Drive ≈ 28 tools), an
 * undifferentiated top-N filter would rank calendar/email tools above
 * schedule_task for "schedule a task…", drop schedule_task from the list, and
 * leave the model fixating on Google Calendar or improvising a cron script.
 *
 * The gate: an external tool is surfaced only when it out-scores LocalMind's
 * OWN best-matching tool for this request (minus a small margin) — i.e. the
 * user is clearly asking for that integration. Measured against nomic-embed-text
 * this cleanly separates real cases:
 *   "schedule a task … notes.md"  → best built-in schedule_task 0.70; top
 *        calendar tool 0.58 < gate → NO calendar tools surface.
 *   "add a meeting tomorrow 3pm"  → cal_suggest 0.64 > best built-in 0.50 →
 *        calendar tools surface.
 *   "draft an email to my prof"   → gmail_draft 0.61 → gmail surfaces.
 *   "find my thesis in drive"     → drive_search 0.52 > best built-in → drive.
 *
 * Ranking uses embeddings when the embed model is available, else keyword
 * overlap. It NEVER drops a built-in and NEVER fails to a smaller built-in set.
 */

/** An MCP (`__`) or dynamic (`group:"external"`) tool — everything else is a built-in. */
export function isExternalTool(t: ToolDef): boolean {
  return t.name.includes("__") || t.group === "external";
}

/**
 * Generic tokens in an MCP server id that don't identify the SERVICE — dropped
 * when deriving the service keywords the user might name (e.g. "google").
 */
const SERVICE_STOPWORDS = new Set([
  "google", "claude", "ai", "mcp", "server", "api", "com", "io", "app", "the", "my", "local", "cloud",
]);

/** Extra words that should count as naming a service (service token → synonyms). */
const SERVICE_SYNONYMS: Record<string, string[]> = {
  gmail: ["email", "emails", "mail"],
  calendar: ["meeting", "meetings"],
  drive: ["gdrive"],
};

/**
 * Distinctive service keywords for an external tool, taken from its server
 * prefix (the part before "__"), e.g. "Google_Calendar__list_events" →
 * ["calendar"], "Gmail__create_draft" → ["gmail","email","emails","mail"].
 * Used so a tool surfaces whenever the user NAMES its service, even if a
 * built-in coincidentally out-scores it ("what's on my calendar", "find X in
 * my google drive"). Only the server prefix is used — never generic tool verbs
 * like create/list/delete — so "create a file" can't drag in calendar tools.
 */
function serviceTokens(t: ToolDef): string[] {
  const prefix = t.name.includes("__") ? t.name.split("__")[0] : t.name;
  const base = prefix
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !SERVICE_STOPWORDS.has(w));
  const out = new Set(base);
  for (const b of base) for (const syn of SERVICE_SYNONYMS[b] ?? []) out.add(syn);
  return [...out];
}

/**
 * An external tool must score at least (bestBuiltinScore - MARGIN) to surface,
 * and never below MIN_FLOOR. MARGIN is a small slack so a genuinely-relevant
 * integration at the boundary (e.g. cal_list vs schedule_task on a calendar
 * query) isn't dropped by embedding noise. MIN_FLOOR stops junk from surfacing
 * when every score is uniformly low.
 */
const MARGIN = 0.03;
const MIN_FLOOR = 0.45;
/** Absolute cap on how many external tools can surface at once. */
const MAX_EXTERNAL = 8;

const toolEmbedCache = new Map<string, number[]>();

function toolText(t: ToolDef): string {
  return `${t.name}: ${String(t.description ?? "").slice(0, 300)}`;
}

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i]; }
  const denom = Math.sqrt(ma) * Math.sqrt(mb);
  return denom === 0 ? 0 : dot / denom;
}

async function embedTool(t: ToolDef, model: string): Promise<number[] | null> {
  const key = toolText(t);
  const cached = toolEmbedCache.get(key);
  if (cached) return cached;
  try {
    const e = await embedText(key, model);
    toolEmbedCache.set(key, e);
    return e;
  } catch {
    return null;
  }
}

function keywordScore(t: ToolDef, words: string[]): number {
  const text = toolText(t).toLowerCase();
  if (words.length === 0) return 0;
  let hits = 0;
  for (const w of words) if (text.includes(w)) hits++;
  return hits / words.length; // normalized 0..1 so it's comparable to cosine
}

interface Scored { t: ToolDef; s: number; }

/**
 * Score every tool against the query with a SINGLE method (all-embedding or
 * all-keyword) so built-in and external scores are directly comparable — the
 * gate compares external scores to the best built-in score. Returns null only
 * if scoring is impossible (caller then keeps everything).
 */
async function scoreAll(tools: ToolDef[], query: string): Promise<Scored[] | null> {
  const model = useMemoryStore.getState().embedModel;
  try {
    const queryEmb = await embedText(query.slice(0, 500), model);
    const scored = await Promise.all(
      tools.map(async (t) => {
        const e = await embedTool(t, model);
        return { t, s: e ? cosine(queryEmb, e) : NaN };
      }),
    );
    if (scored.some((x) => !Number.isNaN(x.s))) {
      // Any tool that failed to embed gets the lowest score, not a free pass.
      return scored.map((x) => ({ t: x.t, s: Number.isNaN(x.s) ? -1 : x.s }));
    }
  } catch {
    // embed model unavailable — keyword fallback below
  }
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  if (words.length === 0) return null;
  return tools.map((t) => ({ t, s: keywordScore(t, words) }));
}

/**
 * Keep all built-in tools; surface an external (MCP/dynamic) tool only when it
 * is more relevant to this request than LocalMind's own best-matching tool.
 * Returns the list unchanged when there are no external tools or the query is
 * empty. Preserves original ordering.
 */
export async function filterToolsByRelevance(
  tools: ToolDef[],
  query: string,
): Promise<ToolDef[]> {
  const external = tools.filter(isExternalTool);
  // Nothing to gate (no MCP/dynamic tools) — or no query to rank against.
  if (external.length === 0 || !query.trim()) return tools;

  const scored = await scoreAll(tools, query);
  if (!scored) return tools; // couldn't score — keep everything rather than guess

  const scoreOf = new Map(scored.map((x) => [x.t.name, x.s]));
  const bestBuiltin = Math.max(
    0,
    ...scored.filter((x) => !isExternalTool(x.t)).map((x) => x.s),
  );
  const gate = Math.max(MIN_FLOOR, bestBuiltin - MARGIN);

  // Words in the user's request, for the service-name signal below.
  const queryTokens = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

  const keptExternal = new Set(
    external
      .map((t) => ({ t, s: scoreOf.get(t.name) ?? -1 }))
      // Surface an external tool when EITHER it out-scores LocalMind's best
      // built-in (the user's intent clearly needs it), OR the user explicitly
      // named its service (so an integration is never hidden just because a
      // built-in shares vocabulary — "what's on my calendar", "find X in drive").
      .filter((x) => x.s >= gate || serviceTokens(x.t).some((tok) => queryTokens.has(tok)))
      .sort((a, b) => b.s - a.s)
      .slice(0, MAX_EXTERNAL)
      .map((x) => x.t.name),
  );

  // Built-ins always pass; external tools only if they cleared the gate.
  return tools.filter((t) => !isExternalTool(t) || keptExternal.has(t.name));
}

// ─── Per-step retrieval (built-ins) ─────────────────────────────────────────
//
// Everything above this line is the ORIGINAL, unchanged external-tool hard
// gate (still embedding-first — left untouched since it's already cheap in
// the common case: it short-circuits entirely when no MCP/dynamic tools are
// connected, and its documented MIN_FLOOR/MARGIN tuning is calibrated
// specifically to cosine-similarity score ranges, not something to disturb
// by swapping its scoring method).
//
// What follows is NEW: applying a *soft* rank+cap to the ~86 built-ins,
// which previously always passed through this module untouched regardless
// of relevance. Two safety nets bound the risk of a noisy per-round
// objective signal starving the model of something essential mid-task:
//   - a small protected CORE tier, never scored out;
//   - a recency pin — whatever fired last round stays this round too.
// Ranking itself is BM25-first (in-process, instant, every round) with
// embedding as a conditional fallback (only when BM25 is ambiguous) —
// unlike the external gate above, this DOES run every round (retrieval is
// keyed to the current in-progress todo, which changes far more often per
// session than "is an MCP server connected"), so it has to stay cheap by
// default. See agentRuntime.ts for the memoization that additionally
// collapses "every round" down to "every todo change" in practice.

/** Tools kept regardless of score — fundamental I/O + planning + the
 *  general command-execution escape hatch. Deliberately small: anything not
 *  in this list is expected to genuinely vary in relevance by objective.
 *
 *  list_workflows/run_workflow are here for a different reason than the rest:
 *  saved workflows are USER-DEFINED (a gym tracker, an expense logger,
 *  anything) — their subject matter can't be baked into these two tools'
 *  static descriptions, so BM25 has no keyword signal to rank them on for an
 *  arbitrary incoming request. Confirmed live: a phone message ("log incline
 *  dumbbell press 50lbs 3x6") that matched a real saved workflow by intent
 *  never surfaced list_workflows/run_workflow in retrieval, and the model
 *  fell back to search_past_sessions instead. Keeping both always-visible
 *  costs nothing (list_workflows is a cheap read; run_workflow only acts on
 *  a workflow the user already saved) and means every request gets a chance
 *  to check "is there a saved automation for this" regardless of phrasing. */
const CORE_TOOLS = new Set([
  "read_file", "write_file", "patch_file",
  "list_directory", "grep_files", "find_files",
  "todo_write", "get_current_datetime", "run_command",
  "list_workflows", "run_workflow",
]);

/** Soft cap on ranked (non-core, non-pinned) built-ins — sized for ~86 total
 *  built-ins, not the thousands a fixed top-5-10 would assume. */
const MAX_RANKED_BUILTINS = 25;

/** True if `objective` names a tool directly — by its real name or one of
 *  its effective aliases (hand-authored `useWhen`/`aliases` fields, plus the
 *  free TOOL_ALIASES backfill via effectiveAliases()). Generalizes the
 *  external gate's serviceTokens() service-name override to any tool. */
function objectiveNamesTool(t: ToolDef, objectiveTokens: Set<string>): boolean {
  const names = [t.name, ...effectiveAliases(t)];
  return names.some((n) => {
    const tokens = n.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return tokens.length > 0 && tokens.every((tok) => objectiveTokens.has(tok));
  });
}

/**
 * Soft-ranks the built-in subset of `tools` for the CURRENT objective,
 * returning a reordered/trimmed built-in list — external tools are untouched
 * (caller is expected to have already run them through `filterToolsByRelevance`
 * and to re-merge that result back in; see `retrieveToolsForStep`).
 *
 * `recentToolNames`: tool(s) called in the immediately preceding round —
 * pinned into this round's result regardless of score, so a mid-chain
 * sequence (read_file → patch_file → run_command on the same file) can't
 * have its next expected tool drop out just because the objective text
 * didn't happen to mention it.
 */
export async function rankBuiltinTools(
  builtins: ToolDef[],
  objective: string,
  recentToolNames: ReadonlySet<string> = new Set(),
): Promise<ToolDef[]> {
  if (builtins.length <= MAX_RANKED_BUILTINS || !objective.trim()) return builtins;

  const core: ToolDef[] = [];
  const pinned: ToolDef[] = [];
  const rankable: ToolDef[] = [];
  for (const t of builtins) {
    if (CORE_TOOLS.has(t.name)) core.push(t);
    else if (recentToolNames.has(t.name)) pinned.push(t);
    else rankable.push(t);
  }

  const objectiveTokens = new Set(objective.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const aliasHits: ToolDef[] = [];
  const scorable: ToolDef[] = [];
  for (const t of rankable) {
    if (objectiveNamesTool(t, objectiveTokens)) aliasHits.push(t);
    else scorable.push(t);
  }

  const remainingSlots = Math.max(0, MAX_RANKED_BUILTINS - aliasHits.length);
  if (scorable.length === 0 || remainingSlots === 0) {
    return [...core, ...pinned, ...aliasHits].slice(0, core.length + pinned.length + MAX_RANKED_BUILTINS);
  }

  const index = buildToolIndex(scorable);
  const bm25Raw = bm25Score(index, objective);
  let finalScores = normalizeScores(bm25Raw);

  // Embedding is a conditional fallback, not a default cost — only pay for
  // a live Ollama call when BM25 alone didn't clearly discriminate.
  if (isRankingAmbiguous(bm25Raw)) {
    try {
      const model = useMemoryStore.getState().embedModel;
      const queryEmb = await embedText(objective.slice(0, 500), model);
      const embScores = new Map<string, number>();
      for (const t of scorable) {
        const e = await embedTool(t, model);
        embScores.set(t.name, e ? cosine(queryEmb, e) : 0);
      }
      const blended = new Map<string, number>();
      for (const t of scorable) {
        const bm = finalScores.get(t.name) ?? 0;
        const em = embScores.get(t.name) ?? 0;
        blended.set(t.name, bm * 0.6 + em * 0.4);
      }
      finalScores = blended;
    } catch {
      // embedding unavailable — keep the BM25-only ranking, don't fail the round over it
    }
  }

  const ranked = [...scorable]
    .sort((a, b) => (finalScores.get(b.name) ?? 0) - (finalScores.get(a.name) ?? 0))
    .slice(0, remainingSlots);

  return [...core, ...pinned, ...aliasHits, ...ranked];
}

/**
 * Full per-step retrieval: the existing external hard gate, then the new
 * built-in soft rank+cap layered on top — the single entry point
 * agentRuntime.ts's round loop calls each round.
 */
export async function retrieveToolsForStep(
  tools: ToolDef[],
  objective: string,
  recentToolNames: ReadonlySet<string> = new Set(),
): Promise<ToolDef[]> {
  const afterExternalGate = await filterToolsByRelevance(tools, objective);
  const builtins = afterExternalGate.filter((t) => !isExternalTool(t));
  const externals = afterExternalGate.filter(isExternalTool);
  const rankedBuiltins = await rankBuiltinTools(builtins, objective, recentToolNames);
  // Preserve rankedBuiltins' own order (core/pinned/alias-hits/ranked, in
  // that priority) followed by whatever externals cleared the outer gate.
  return [...rankedBuiltins, ...externals];
}
