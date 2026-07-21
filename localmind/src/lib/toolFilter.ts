import type { ToolDef } from "./tools";
import { embedText } from "./vectorMemory";
import { useMemoryStore } from "../store/memory";

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
function isExternalTool(t: ToolDef): boolean {
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
