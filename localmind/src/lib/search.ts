export interface SearchContext {
  query: string;
  formatted: string; // ready to inject into a system prompt
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

// ── Transport ──────────────────────────────────────────────────────────────────
// In the packaged Tauri app, direct fetches to duckduckgo.com are CORS-blocked
// by the native webview and the Vite dev proxy (`/ddg-*`) does not exist outside
// `npm run dev` / `npm run tauri dev`. When running inside Tauri we route through
// the Rust `http_fetch` command (no CORS there) against the real DDG endpoints.
// Outside Tauri (plain browser dev mode) we keep using the dev-only proxy paths.

function isTauri(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as Record<string, unknown>).__TAURI__;
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__;
  const core = (tauri as Record<string, unknown>).core as { invoke?: (cmd: string, args?: unknown) => Promise<T> };
  if (typeof core?.invoke !== "function") throw new Error("Tauri core.invoke unavailable");
  return core.invoke(cmd, args);
}

/** Fetch `nativeUrl` via the Rust http_fetch command when in Tauri, otherwise
 *  fetch `proxyUrl` (the Vite dev-server proxy path) directly. Returns null on
 *  any failure so callers can treat it the same as an empty/failed response. */
async function fetchBody(proxyUrl: string, nativeUrl: string): Promise<string | null> {
  if (isTauri()) {
    try {
      return await tauriInvoke<string>("http_fetch", { url: nativeUrl, method: "GET" });
    } catch {
      return null;
    }
  }
  try {
    const res = await fetch(proxyUrl);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ── DDG Instant Answer API ────────────────────────────────────────────────────
// Good for: Wikipedia abstracts, math answers, direct lookups.
// BAD for: general queries — returns empty for most topics.

async function fetchInstantAnswer(query: string): Promise<string[]> {
  const params = new URLSearchParams({ q: query, format: "json", no_redirect: "1", no_html: "1", skip_disambig: "1" });
  try {
    const text = await fetchBody(`/ddg-search/?${params}`, `https://api.duckduckgo.com/?${params}`);
    if (!text) return [];
    const data = JSON.parse(text) as Record<string, unknown>;
    const lines: string[] = [];
    const answer = data.Answer as string | undefined;
    if (answer) lines.push(`Instant answer: ${stripHtml(answer)}`);
    const abstractText = data.AbstractText as string | undefined;
    const abstractURL = data.AbstractURL as string | undefined;
    if (abstractText) { lines.push(`Summary: ${stripHtml(abstractText)}`); if (abstractURL) lines.push(`Source: ${abstractURL}`); }
    const related = (data.RelatedTopics as Array<{ Text?: string; FirstURL?: string }> | undefined) ?? [];
    related.filter((t) => t.Text).slice(0, 3).forEach((t) => lines.push(`• ${stripHtml(t.Text!)} — ${t.FirstURL ?? ""}`));
    return lines;
  } catch { return []; }
}

// ── DDG Lite scraper ──────────────────────────────────────────────────────────
// lite.duckduckgo.com — minimal HTML table layout

async function fetchLiteResults(query: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const q = encodeURIComponent(query);
  try {
    const html = await fetchBody(`/ddg-lite/lite/?q=${q}`, `https://lite.duckduckgo.com/lite/?q=${q}`);
    if (!html) return [];

    // Title links: <td class="result-link"><a href="...">Title</a>
    const titleRe = /class="result-link"[^>]*>[\s\S]*?<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const titles: Array<{ title: string; url: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = titleRe.exec(html)) !== null) {
      const url = m[1].trim();
      const title = stripHtml(m[2]);
      if (title && title !== "Next Page" && !title.startsWith("Ad ")) titles.push({ title, url });
    }

    // Snippets: <td class="result-snippet">...</td>
    const snippetRe = /class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
    const snippets: string[] = [];
    while ((m = snippetRe.exec(html)) !== null) {
      const s = stripHtml(m[1]);
      if (s) snippets.push(s);
    }

    return titles.slice(0, 6).map((t, i) => ({ ...t, snippet: snippets[i] ?? "" }));
  } catch { return []; }
}

// ── DDG HTML scraper ──────────────────────────────────────────────────────────
// html.duckduckgo.com/html/ — full HTML results page, different bot detection

async function fetchHtmlResults(query: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const q = encodeURIComponent(query);
  try {
    const html = await fetchBody(`/ddg-html/html/?q=${q}`, `https://html.duckduckgo.com/html/?q=${q}`);
    if (!html) return [];

    // Result titles: <a class="result__a" href="...">Title</a>
    const titleRe = /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    const titles: Array<{ title: string; url: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = titleRe.exec(html)) !== null) {
      const url = m[1].startsWith("//duckduckgo.com/l/") || m[1].startsWith("//") ? m[1] : m[1];
      const title = stripHtml(m[2]);
      if (title) titles.push({ title, url });
    }

    // Snippets: <a class="result__snippet" ...>...</a>  OR  <div class="result__snippet">...</div>
    const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/gi;
    const snippets: string[] = [];
    while ((m = snippetRe.exec(html)) !== null) {
      const s = stripHtml(m[1]);
      if (s) snippets.push(s);
    }

    return titles.slice(0, 6).map((t, i) => ({ ...t, snippet: snippets[i] ?? "" }));
  } catch { return []; }
}

// ── Wikimedia Commons image search ──────────────────────────────────────────
// Purpose-built for search_images (src/lib/tools.ts): the model has no other
// path from "find a picture of X" to an actual downloadable file — web_search
// only returns page URLs/snippets, never a direct image URL, so a
// find-image-then-download_file chain had no real second step (confirmed
// failure: repeated live sessions where the model got search-result TEXT
// back and then just stopped, asking the user to pick/paste a URL itself).
// Chose Commons over scraping DuckDuckGo's image search specifically because
// Commons has a real, documented, stable JSON API returning genuine direct
// file URLs (imageinfo.url) — no undocumented per-request token dance, no
// HTML scraping to keep in sync with a redesign.

export interface ImageResult {
  title: string;
  /** Direct, downloadable file URL — this is what download_file should be
   *  called with, not the Commons page URL. */
  url: string;
  mime: string;
  width: number;
  height: number;
}

export async function searchImages(query: string, limit = 8): Promise<ImageResult[]> {
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: `${query} filetype:bitmap`, // excludes SVG/vector — most tools expect raster
    gsrnamespace: "6", // the File: namespace
    gsrlimit: String(Math.min(limit, 20)),
    prop: "imageinfo",
    iiprop: "url|size|mime",
    format: "json",
    origin: "*",
  });
  try {
    const text = await fetchBody(
      `/commons-search/w/api.php?${params}`,
      `https://commons.wikimedia.org/w/api.php?${params}`,
    );
    if (!text) return [];
    const data = JSON.parse(text) as {
      query?: { pages?: Record<string, { title?: string; imageinfo?: Array<{ url?: string; mime?: string; width?: number; height?: number }> }> };
    };
    const pages = data.query?.pages ?? {};
    const results: ImageResult[] = [];
    for (const page of Object.values(pages)) {
      const info = page.imageinfo?.[0];
      if (!info?.url) continue;
      results.push({
        title: (page.title ?? "").replace(/^File:/, ""),
        url: info.url,
        mime: info.mime ?? "",
        width: info.width ?? 0,
        height: info.height ?? 0,
      });
    }
    return results;
  } catch {
    return [];
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function searchWeb(query: string): Promise<SearchContext> {
  const ts = new Date().toLocaleString();
  const lines: string[] = [`[Web search for "${query}" — ${ts}]`];

  // Run all three sources in parallel
  const [instantResult, liteResult, htmlResult] = await Promise.allSettled([
    fetchInstantAnswer(query),
    fetchLiteResults(query),
    fetchHtmlResults(query),
  ]);

  const instant = instantResult.status === "fulfilled" ? instantResult.value : [];
  const liteItems = liteResult.status === "fulfilled" ? liteResult.value : [];
  const htmlItems = htmlResult.status === "fulfilled" ? htmlResult.value : [];

  // Merge lite + html, deduplicate by title
  const seenTitles = new Set<string>();
  const webItems: Array<{ title: string; url: string; snippet: string }> = [];
  for (const item of [...liteItems, ...htmlItems]) {
    const key = item.title.slice(0, 40).toLowerCase();
    if (!seenTitles.has(key)) { seenTitles.add(key); webItems.push(item); }
    if (webItems.length >= 6) break;
  }

  if (instant.length > 0) lines.push(...instant);

  if (webItems.length > 0) {
    if (instant.length > 0) lines.push("");
    lines.push("Web results:");
    webItems.forEach((r, i) => {
      lines.push(`  ${i + 1}. ${r.title}`);
      if (r.snippet) lines.push(`     ${r.snippet}`);
      if (r.url && !r.url.includes("duckduckgo.com/l/")) lines.push(`     ${r.url}`);
    });
  }

  if (instant.length === 0 && webItems.length === 0) {
    lines.push(
      "NO RESULTS FOUND. All search endpoints returned empty.",
      "→ Use web_fetch with a direct URL instead. Examples:",
      "→   web_fetch('https://developer.mozilla.org/en-US/search?q=" + encodeURIComponent(query.slice(0, 50)) + "')",
      "→   web_fetch('https://stackoverflow.com/search?q=" + encodeURIComponent(query.slice(0, 50)) + "')",
      "→ Or try a shorter, more specific query keyword.",
    );
  }

  lines.push("[End of search results]");
  return { query, formatted: lines.join("\n") };
}
