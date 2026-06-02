export interface SearchContext {
  query: string;
  formatted: string; // ready to inject into a system prompt
}

// DuckDuckGo JSON API — no API key required.
// In dev (browser) we route through a Vite proxy to avoid CORS.
// In production Tauri the native webview fetches directly.
function searchUrl(query: string): string {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    no_redirect: "1",
    no_html: "1",
    skip_disambig: "1",
  });
  const base = import.meta.env.DEV
    ? "/ddg-search"
    : "https://api.duckduckgo.com";
  return `${base}/?${params}`;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

export async function searchWeb(query: string): Promise<SearchContext> {
  const res = await fetch(searchUrl(query));
  if (!res.ok) throw new Error(`Search request failed (${res.status})`);

  // DuckDuckGo can return non-JSON for some queries; guard against it
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Search returned unexpected response");
  }

  const lines: string[] = [];
  const ts = new Date().toLocaleString();
  lines.push(`[Web search for "${query}" — ${ts}]`);

  const answer = data.Answer as string | undefined;
  if (answer) lines.push(`Instant answer: ${stripHtml(answer)}`);

  const abstractText = data.AbstractText as string | undefined;
  const abstractURL = data.AbstractURL as string | undefined;
  if (abstractText) {
    lines.push(`\nSummary: ${stripHtml(abstractText)}`);
    if (abstractURL) lines.push(`Source: ${abstractURL}`);
  }

  const definition = data.Definition as string | undefined;
  const definitionURL = data.DefinitionURL as string | undefined;
  if (definition) {
    lines.push(`\nDefinition: ${stripHtml(definition)}`);
    if (definitionURL) lines.push(`Source: ${definitionURL}`);
  }

  // Direct web results (often empty but grab them if present)
  const results = (data.Results as Array<{ Text?: string; FirstURL?: string }> | undefined) ?? [];
  if (results.length > 0) {
    lines.push("\nWeb results:");
    results.slice(0, 4).forEach((r, i) => {
      if (r.Text) lines.push(`  ${i + 1}. ${stripHtml(r.Text)} — ${r.FirstURL ?? ""}`);
    });
  }

  // Related topics as fallback context
  const related = (data.RelatedTopics as Array<{ Text?: string; FirstURL?: string }> | undefined) ?? [];
  const flatRelated = related.filter((t) => t.Text);
  if (flatRelated.length > 0 && lines.length < 4) {
    lines.push("\nRelated:");
    flatRelated.slice(0, 5).forEach((t, i) => {
      lines.push(`  ${i + 1}. ${stripHtml(t.Text!)} — ${t.FirstURL ?? ""}`);
    });
  }

  lines.push("[End of search results]");

  return { query, formatted: lines.join("\n") };
}
