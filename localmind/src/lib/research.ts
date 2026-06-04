import { streamChat } from "./ollama";
import { searchWeb } from "./search";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ResearchSection {
  title: string;
  content: string;
}

export interface ResearchChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ResearchReport {
  id: string;
  topic: string;
  createdAt: number;
  htmlOutput: string;
  sections: ResearchSection[];
  sources: string[];
  /** Plain-text summary of all research data — used as chat context. */
  researchContext: string;
  chatMessages: ResearchChatMessage[];
  status: "generating" | "done" | "error";
  error?: string;
  phase: string;
  queriesCompleted: number;
  queriesTotal: number;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface SearchPlan { query: string; angle: string; }
interface RichSearchResult { query: string; angle: string; content: string; urls: string[]; }

// ─── LLM helpers ──────────────────────────────────────────────────────────────

async function collectFull(model: string, prompt: string, signal: AbortSignal): Promise<string> {
  let out = "";
  for await (const chunk of streamChat(model, [{ role: "user", content: prompt }], signal)) {
    out += chunk;
  }
  return out;
}

function parseJSON<T>(raw: string, fallback: T): T {
  try {
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]") + 1;
    if (start === -1 || end === 0) throw new Error("no array");
    return JSON.parse(raw.slice(start, end)) as T;
  } catch {
    return fallback;
  }
}

// ─── Wikipedia enrichment ─────────────────────────────────────────────────────

/**
 * Fetch up to 8 000 characters of a Wikipedia article's plain text via the
 * MediaWiki API. Significantly richer than the REST summary endpoint.
 */
async function fetchWikipediaFullContent(url: string): Promise<string | null> {
  if (!url.includes("wikipedia.org/wiki/")) return null;
  try {
    const title = decodeURIComponent(url.split("/wiki/")[1].split(/[#?]/)[0]);
    const params = new URLSearchParams({
      action: "query",
      titles: title,
      prop: "extracts",
      explaintext: "true",
      exsectionformat: "plain",
      format: "json",
      origin: "*",
      exchars: "8000",
    });
    const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`);
    if (!res.ok) return null;
    const data = await res.json() as { query?: { pages?: Record<string, { extract?: string }> } };
    const pages = data.query?.pages;
    if (!pages) return null;
    const page = Object.values(pages)[0];
    return page?.extract?.slice(0, 8000) ?? null;
  } catch {
    return null;
  }
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

const PLAN_PROMPT = (topic: string) => `You are a research strategist. For the topic below, generate exactly 12 specific search queries covering comprehensive angles.

Topic: "${topic}"

Required angles:
1. Core definition, mechanism, and fundamentals
2. Current state and latest developments (2024–2025)
3. Key statistics, data, and quantitative metrics
4. Leading researchers / organisations / proponents and their strongest claims
5. Critics, sceptics, and opposing arguments with evidence
6. Real-world applications and documented case studies
7. Historical background and evolution over time
8. Technical or scientific underpinnings (deep dive)
9. Policy, regulatory, or societal implications
10. Economic dimensions (cost, funding, market size)
11. Ethical dimensions or controversies
12. Future outlook, predictions, and open research questions

Respond ONLY with a JSON array of exactly 12 objects:
[{"query": "specific search query", "angle": "angle label from the list above"}]`;

const GAP_PROMPT = (topic: string, summaries: string) => `You are a senior research analyst reviewing initial findings on "${topic}".

What has been collected so far:
${summaries}

Identify 5 specific research GAPS — missing perspectives, unresolved contradictions, underrepresented evidence, or critical context not yet found.

Respond ONLY with a JSON array of 5 objects:
[{"query": "targeted follow-up search query", "reason": "what specific gap this fills"}]`;

const NOTES_PROMPT = (topic: string, allData: string) => `You are a meticulous research analyst. Read ALL of the search data below on "${topic}" and extract a comprehensive set of structured research notes.

SEARCH DATA (${allData.length} characters from ${allData.split("═══").length} sources):
${allData}

Extract and organise EVERYTHING of substance into these categories:

## DEFINITIONS & CORE CONCEPTS
(exact definitions, key terms, fundamental mechanisms)

## KEY CLAIMS & FINDINGS
(specific claims with their sources — quote important phrases directly)

## STATISTICS & DATA POINTS
(every number, percentage, date, metric you find — be exhaustive)

## PROPONENT ARGUMENTS
(strongest arguments FOR this topic, with specific reasoning)

## CRITIC / OPPOSING ARGUMENTS
(strongest arguments AGAINST or concerns, with specific reasoning)

## CASE STUDIES & EXAMPLES
(specific real-world examples with details)

## HISTORICAL CONTEXT
(timeline, evolution, key milestones)

## TECHNICAL DETAILS
(mechanisms, processes, methods — be specific)

## IMPLICATIONS & CONTROVERSIES
(societal, ethical, economic, policy implications)

## FUTURE OUTLOOK
(predictions, trends, open questions)

Be exhaustive. Extract EVERY meaningful piece of information. Do not summarise away detail — preserve specific facts, figures, and quotes.`;

const HTML_REPORT_PROMPT = (topic: string, date: string, totalSearches: number, notes: string) =>
  `You are writing a comprehensive academic research report as a self-contained interactive HTML page.

TOPIC: "${topic}"
DATE: ${date}
BASIS: ${totalSearches} web searches, Wikipedia articles, and gap-analysis follow-ups

RESEARCH NOTES (exhaustive extraction):
${notes}

Write a COMPLETE, SELF-CONTAINED HTML research report with NO external dependencies (all CSS and JS inline). The report should read like an academic paper combined with a professional intelligence brief.

━━━ REQUIRED SECTIONS (expand each one thoroughly) ━━━

1. EXECUTIVE SUMMARY — 5–7 specific bullet points of the most important findings (not vague — actual claims with numbers/names)
2. BACKGROUND & CONTEXT — Full historical background, why this matters, who are the key actors. Minimum 400 words.
3. KEY FINDINGS — 5–7 numbered findings, each with:
   - A clear thesis sentence
   - Supporting evidence and specific examples
   - Data/statistics if available
   - Why it matters
   Each finding: 200+ words minimum.
4. MULTIPLE PERSPECTIVES — This section MUST include:
   - At least 3 distinct viewpoints (proponent / critic / neutral/academic)
   - Side-by-side layout showing genuine disagreement
   - Specific arguments for each perspective with named sources where available
   - What evidence each side marshals
   400 words minimum per perspective.
5. DATA & EVIDENCE — A dedicated section with:
   - All statistics and metrics surfaced in the research
   - SVG charts (bar charts, comparison charts) for any numerical data
   - Tables for comparative information
6. TECHNICAL ANALYSIS — Deep dive into mechanisms, processes, or methodologies
7. IMPLICATIONS — Social, economic, ethical, policy implications — be specific about who is affected and how
8. FUTURE OUTLOOK — Predictions, trends, open research questions
9. CRITICAL ASSESSMENT — Synthesise: what do we know with confidence vs. what is uncertain or contested?
10. SOURCES & METHODOLOGY — Cards for all source URLs, plus note on research methodology

━━━ DESIGN (ALL INLINE CSS) ━━━
- Font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif
- Sticky nav: background #0f172a, white text, smooth-scroll links
- Body background: #f8fafc
- Cards: white, border-radius: 12px, box-shadow: 0 2px 16px rgba(0,0,0,0.07)
- Left sidebar nav listing all sections (visible on desktop)
- Key stat callouts: huge (52px) bold numbers on coloured backgrounds (#3b82f6, #8b5cf6, #10b981, #f59e0b)
- Perspectives: distinctly coloured cards — blue for proponent, amber for critic, purple for neutral
- Section headers: 22px bold, left border 4px solid accent
- Quote blocks: left border, light background, italic text
- Data tables: striped rows, proper headers
- SVG charts: inline, properly labelled
- External links: target="_blank" rel="noopener noreferrer"
- Footer: research methodology note, generation date, "AI-synthesised from ${totalSearches} sources"

━━━ QUALITY BAR ━━━
- This should feel like a 3000–5000 word academic report, not a blog post
- Every section must contain specific facts, names, numbers — no vague generalities
- Clearly distinguish between established facts and contested claims
- Do NOT pad with filler — every sentence must add information

Output ONLY the complete HTML starting with <!DOCTYPE html> and ending with </html>.`;

// ─── Search execution ─────────────────────────────────────────────────────────

async function runSearchBatch(plans: SearchPlan[]): Promise<RichSearchResult[]> {
  return Promise.all(
    plans.map(async ({ query, angle }) => {
      try {
        const ctx = await searchWeb(query);
        const urls: string[] = (ctx.formatted.match(/https?:\/\/[^\s\]]+/g) ?? []).slice(0, 4);
        let content = ctx.formatted;

        // Enrich with full Wikipedia article (up to 8 000 chars) — huge content boost
        for (const url of urls) {
          if (url.includes("wikipedia.org/wiki/")) {
            const wiki = await fetchWikipediaFullContent(url).catch(() => null);
            if (wiki && wiki.length > 300) {
              content += `\n\n[Full Wikipedia article on ${url}]:\n${wiki}`;
            }
            break;
          }
        }

        return { query, angle, content, urls } satisfies RichSearchResult;
      } catch {
        return { query, angle, content: `(search unavailable: ${query})`, urls: [] };
      }
    })
  );
}

/** Strip HTML tags and collapse whitespace for use as LLM context. */
export function extractPlainText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s{3,}/g, "\n\n")
    .trim();
}

// ─── Main research loop ───────────────────────────────────────────────────────

export async function* runResearch(
  topic: string,
  model: string,
  signal: AbortSignal
): AsyncGenerator<Partial<ResearchReport>> {
  const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  // Phase 1 — Plan
  yield { status: "generating", phase: "Planning research strategy…", queriesCompleted: 0, queriesTotal: 0, sections: [{ title: "Planning", content: "" }] };
  const planRaw = await collectFull(model, PLAN_PROMPT(topic), signal);
  const plan = parseJSON<SearchPlan[]>(planRaw, [{ query: topic, angle: "overview" }]).slice(0, 12);

  yield { phase: `Searching ${plan.length} angles (parallel)…`, queriesTotal: plan.length + 5, queriesCompleted: 0 };

  // Phase 2 — Initial search burst (all parallel, with Wikipedia enrichment)
  const initialResults = await runSearchBatch(plan);
  const allSourceUrls = initialResults.flatMap((r) => r.urls);

  yield { phase: "Analysing gaps in initial findings…", queriesCompleted: plan.length };

  // Phase 3 — Gap analysis
  const initialSummary = initialResults
    .map((r) => `[${r.angle}]\n${r.content.slice(0, 500)}`)
    .join("\n\n---\n\n");
  const gapRaw = await collectFull(model, GAP_PROMPT(topic, initialSummary), signal);
  const gaps = parseJSON<{ query: string; reason: string }[]>(gapRaw, []).slice(0, 5);

  yield { phase: `Running ${gaps.length} follow-up searches…`, queriesCompleted: plan.length, queriesTotal: plan.length + gaps.length };

  // Phase 4 — Follow-up searches
  const followUpResults = await runSearchBatch(gaps.map((g) => ({ query: g.query, angle: `gap: ${g.reason}` })));
  allSourceUrls.push(...followUpResults.flatMap((r) => r.urls));

  const allResults = [...initialResults, ...followUpResults];
  const totalSearches = allResults.length;

  // Build the raw data block for the notes pass
  const rawDataBlock = allResults
    .map((r, i) => `\n${"═".repeat(60)}\nSOURCE ${i + 1} | Angle: ${r.angle}\nQuery: "${r.query}"\n${"─".repeat(40)}\n${r.content}`)
    .join("\n");

  yield { phase: "Extracting facts, claims, and evidence…", queriesCompleted: totalSearches, queriesTotal: totalSearches };

  // Phase 5 — Notes extraction pass (ensures depth in synthesis)
  const notes = await collectFull(model, NOTES_PROMPT(topic, rawDataBlock), signal);

  yield { phase: "Writing academic report (this takes 2–3 minutes)…" };

  // Phase 6 — HTML synthesis (streamed)
  let htmlOutput = "";
  for await (const chunk of streamChat(
    model,
    [{ role: "user", content: HTML_REPORT_PROMPT(topic, date, totalSearches, notes) }],
    signal
  )) {
    htmlOutput += chunk;
    if (htmlOutput.length % 800 < chunk.length) {
      yield { htmlOutput, phase: `Writing report… (${Math.round(htmlOutput.length / 1000)}KB)` };
    }
  }

  // Clean any markdown fences
  const cleaned = htmlOutput
    .replace(/^```html\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```\s*$/, "").trim();

  // Build plain-text context for the post-research chat
  const researchContext = `# Research Report: ${topic}\n\n## Research Notes (${totalSearches} sources)\n\n${notes}\n\n## Report Content\n\n${extractPlainText(cleaned).slice(0, 12000)}`;

  const sources = [...new Set(allSourceUrls)].filter((u) => u.startsWith("http")).slice(0, 40);

  yield {
    htmlOutput: cleaned,
    researchContext,
    sources,
    status: "done",
    phase: "Done",
    queriesCompleted: totalSearches,
    queriesTotal: totalSearches,
    sections: [{ title: "Report", content: "HTML report generated." }],
    chatMessages: [],
  };
}
