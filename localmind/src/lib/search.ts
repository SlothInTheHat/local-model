export interface SearchContext {
  query: string;
  formatted: string; // ready to inject into a system prompt
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

const DEV = import.meta.env.DEV;

// ── DDG Instant Answer API ────────────────────────────────────────────────────
// Good for: Wikipedia abstracts, math answers, direct lookups.
// BAD for: general queries — returns empty for most topics.

async function fetchInstantAnswer(query: string): Promise<string[]> {
  const params = new URLSearchParams({ q: query, format: "json", no_redirect: "1", no_html: "1", skip_disambig: "1" });
  const base = DEV ? "/ddg-search" : "https://api.duckduckgo.com";
  try {
    const res = await fetch(`${base}/?${params}`);
    if (!res.ok) return [];
    const data = JSON.parse(await res.text()) as Record<string, unknown>;
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
  const base = DEV ? "/ddg-lite" : "https://lite.duckduckgo.com";
  try {
    const res = await fetch(`${base}/lite/?q=${encodeURIComponent(query)}`);
    if (!res.ok) return [];
    const html = await res.text();

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
  const base = DEV ? "/ddg-html" : "https://html.duckduckgo.com";
  try {
    const res = await fetch(`${base}/html/?q=${encodeURIComponent(query)}`);
    if (!res.ok) return [];
    const html = await res.text();

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
