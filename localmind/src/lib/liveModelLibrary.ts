/**
 * Best-effort LIVE fetch of Ollama's public model catalog (ollama.com/library)
 * to supplement the hand-curated, hardcoded MODEL_LIBRARY (modelLibrary.ts).
 *
 * There is no official Ollama API for "list every model in the registry" —
 * only /api/tags (locally installed models) and /api/pull/show (act on an
 * exact known name). The only place the full catalog is enumerable at all is
 * the ollama.com/library website itself, so this scrapes that page's HTML.
 *
 * This is inherently fragile: if Ollama changes their page markup, parsing
 * silently returns zero entries and callers fall back to the curated list
 * (or a stale cache) — never throws, never blocks the Models tab from
 * working. Confirmed as of writing: the whole catalog (250+ models) renders
 * as one un-paginated page, each entry a `<a href="/library/<name>">`
 * containing a description `<p>` and a flat list of `<span>` chips mixing
 * capability tags ("tools", "vision", "embedding") with parameter-size tags
 * ("8b", "70b", "405b") — distinguished here by a numeric+unit regex.
 */

export interface LiveLibraryEntry {
  /** Family name as used in ollama.com/library/<id> and as an Ollama pull name. */
  id: string;
  description: string;
  /** Parameter-size tag variants shown on the card, e.g. ["8b", "70b", "405b"]. Empty if none shown (e.g. single-size models). */
  sizeTags: string[];
  /** Non-size capability chips shown on the card, e.g. ["tools", "vision", "embedding"]. */
  capabilityTags: string[];
}

const LIBRARY_URL = "https://ollama.com/library";
const CACHE_KEY = "localmind-live-model-library";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

// Direct `fetch()` to an external host is CORS-blocked in the packaged Tauri
// webview (same constraint search.ts documents) — route through the Rust
// `http_fetch` command instead, which has no CORS restriction. Falls back to
// a plain browser fetch outside Tauri (npm run dev without `tauri`), which
// will likely still be CORS-blocked there too since ollama.com doesn't send
// permissive CORS headers — that's fine, it just means this feature only
// really works in the desktop app, same as everything else that calls
// http_fetch.
function isTauri(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as Record<string, unknown>).__TAURI__;
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__;
  const core = (tauri as Record<string, unknown>).core as { invoke?: (cmd: string, args?: unknown) => Promise<T> };
  if (typeof core?.invoke !== "function") throw new Error("Tauri core.invoke unavailable");
  return core.invoke(cmd, args);
}

async function fetchLibraryHtml(): Promise<string> {
  if (isTauri()) {
    return tauriInvoke<string>("http_fetch", { url: LIBRARY_URL, method: "GET" });
  }
  const res = await fetch(LIBRARY_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

interface Cache {
  fetchedAt: number;
  entries: LiveLibraryEntry[];
}

function readCache(): Cache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Cache;
    return Array.isArray(parsed.entries) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(entries: LiveLibraryEntry[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), entries } satisfies Cache));
  } catch {
    // localStorage full/unavailable — the cache is a nice-to-have, not required.
  }
}

/**
 * A tag chip that's a bare parameter-size marker, e.g. "8b", "1.7b", "137m" —
 * deliberately case-SENSITIVE (lowercase only). Confirmed against real markup
 * (see this file's top comment): Ollama renders actual size chips lowercase
 * ("8b", "70b") but formats the separate Pulls-count stat uppercase ("117.6M",
 * "79.6M") — without the case distinction "117.6M" pulls would be mistaken
 * for a 117.6-billion... no, "M"-suffixed size tag. Scoping to the tag-chip
 * container below (not the Pulls/Tags/Updated stats row) is the primary
 * defense; this regex is the second layer.
 */
const SIZE_TAG_RE = /^\d+(\.\d+)?[bmk]$/;

function parseLibraryHtml(html: string): LiveLibraryEntry[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const entries: LiveLibraryEntry[] = [];
  const seen = new Set<string>();

  doc.querySelectorAll('a[href^="/library/"]').forEach((a) => {
    const href = a.getAttribute("href") ?? "";
    const id = href.replace(/^\/library\//, "").split(/[?#]/)[0].trim();
    // Skip non-family links (tag-specific pages like /library/llama3.1:8b,
    // or anything with a nested path) and duplicates (the page can repeat an
    // anchor's structure for hover states in some layouts).
    if (!id || id.includes("/") || id.includes(":") || seen.has(id)) return;
    seen.add(id);

    const description = a.querySelector("p")?.textContent?.trim() ?? "";

    // Tag chips (size + capability) live in their own row, separate from the
    // Pulls/Tags/Updated stats row below it — scope to that row specifically
    // rather than every <span> in the card, which would also pick up nested
    // spans from the stats row (e.g. a "117.6M" pulls count).
    const chipRow = a.querySelector("div.flex-wrap");
    const chips = chipRow
      ? Array.from(chipRow.querySelectorAll("span"))
          .map((s) => s.textContent?.trim() ?? "")
          .filter((t) => t.length > 0 && t.length < 20 && !/\s/.test(t))
      : [];

    const sizeTags: string[] = [];
    const capabilityTags: string[] = [];
    for (const chip of chips) {
      if (SIZE_TAG_RE.test(chip)) sizeTags.push(chip);
      else if (/^[a-z][a-z0-9-]*$/i.test(chip)) capabilityTags.push(chip.toLowerCase());
    }

    entries.push({ id, description, sizeTags, capabilityTags });
  });

  return entries;
}

/**
 * Returns the live catalog, fetching fresh only if the cache is missing or
 * older than a day (or `forceRefresh` is set). Falls back to stale cache (or
 * an empty array, if there's never been a successful fetch) on any network
 * error or parse failure — callers should treat this purely as "extra
 * entries to layer on top of the curated list," never a hard dependency.
 */
export async function getLiveModelLibrary(forceRefresh = false): Promise<LiveLibraryEntry[]> {
  const cached = readCache();
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.entries;
  }
  try {
    const html = await fetchLibraryHtml();
    const entries = parseLibraryHtml(html);
    if (entries.length === 0) throw new Error("Parsed zero entries — ollama.com's page structure may have changed");
    writeCache(entries);
    return entries;
  } catch {
    return cached?.entries ?? [];
  }
}

/** When the live catalog was last successfully fetched, or null if never. */
export function getLiveLibraryFetchedAt(): number | null {
  return readCache()?.fetchedAt ?? null;
}
