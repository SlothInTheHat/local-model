import { embedText, cosineSimilarity } from "./vectorMemory";
import { useMemoryStore } from "../store/memory";

export interface Skill {
  name: string;
  tags: string[];
  content: string;
  filename: string;
}

/** Parse simple YAML-ish frontmatter (--- key: value --- lines). */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return { meta: {}, body: raw };
  const endIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (endIdx === -1) return { meta: {}, body: raw };
  const metaLines = lines.slice(1, endIdx);
  const meta: Record<string, string> = {};
  for (const line of metaLines) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    meta[key] = val;
  }
  return { meta, body: lines.slice(endIdx + 1).join("\n").trimStart() };
}

function parseSkillFile(filename: string, raw: string): Skill {
  const { meta, body } = parseFrontmatter(raw);
  const name = meta["name"] ?? filename.replace(/\.md$/i, "").replace(/-/g, " ");
  const tagsRaw = meta["tags"] ?? "";
  const tags = tagsRaw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return { name, tags, content: body.trim(), filename };
}

/** Load all *.md files from .localmind/skills/ within the given workspace handle. */
export async function loadSkills(
  dirHandle: FileSystemDirectoryHandle,
): Promise<Skill[]> {
  const skills: Skill[] = [];
  try {
    let lmDir: FileSystemDirectoryHandle;
    try {
      lmDir = await dirHandle.getDirectoryHandle(".localmind", { create: false });
    } catch {
      return [];
    }
    let skillsDir: FileSystemDirectoryHandle;
    try {
      skillsDir = await lmDir.getDirectoryHandle("skills", { create: false });
    } catch {
      return [];
    }
    for await (const [name, entry] of skillsDir.entries()) {
      if (entry.kind !== "file" || !name.endsWith(".md")) continue;
      try {
        const file = await (entry as FileSystemFileHandle).getFile();
        const text = await file.text();
        skills.push(parseSkillFile(name, text));
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // workspace doesn't support iteration
  }
  return skills;
}

/** Score a skill against a user query. Higher = more relevant. */
function scoreSkill(skill: Skill, query: string): number {
  const q = query.toLowerCase();
  const words = q.split(/\s+/);
  let score = 0;
  for (const tag of skill.tags) {
    if (q.includes(tag)) score += 3;
    for (const word of words) {
      if (tag.includes(word) || word.includes(tag)) score += 1;
    }
  }
  const nameLower = skill.name.toLowerCase();
  if (q.includes(nameLower)) score += 4;
  for (const word of words) {
    if (nameLower.includes(word)) score += 1;
  }
  // keyword match in content (lower weight)
  for (const word of words) {
    if (word.length > 3 && skill.content.toLowerCase().includes(word)) score += 0.5;
  }
  return score;
}

// ─── Embedding-based matching ──────────────────────────────────────────────
//
// matchSkills must stay a SYNCHRONOUS function returning Skill[] — its only
// call site (agentRuntime.ts's buildCurrentStateBlock) is outside this WP's
// edit scope and does `const matched = matchSkills(...); matched.length`
// with no `await`. Embedding via Ollama's /api/embed is inherently async, so
// true embedding-based matching can only use whatever is ALREADY cached at
// call time; a cache miss (cold start, or a brand-new query text) falls back
// to the original substring/tag scoring for THIS call while a fire-and-forget
// warm-up populates the cache for the next call with the same skill set/query
// (e.g. the next round of the same multi-round task, since state.taskQuery in
// agentRuntime.ts only changes when the underlying user message changes).
// This mirrors toolFilter.ts's toolEmbedCache pattern (module-level Map, keyed
// by the text that was embedded, silently degrades when the embed model is
// unavailable since the cache then just never populates).

/** Keyed by "name::content" (cheap identity key, not a real hash — content is
 *  bounded in size so the full string is fine as a Map key). */
function skillCacheKey(skill: Skill): string {
  return `${skill.name}::${skill.content}`;
}

const skillEmbedCache = new Map<string, number[]>();
const QUERY_CACHE_MAX = 20;
const queryEmbedCache = new Map<string, number[]>();

/** Cosine threshold for the embedding path — independent of the `threshold`
 *  param, which only applies to the substring/tag fallback below. */
const EMBED_MATCH_THRESHOLD = 0.5;

function skillEmbedText(skill: Skill): string {
  return `${skill.name}: ${skill.content.slice(0, 300)}`;
}

/** Fire-and-forget: fills the caches for the NEXT call. Never awaited, never
 *  throws into the caller — failures (embed model unavailable) just leave the
 *  caches empty, which keeps matchSkills on the substring fallback forever. */
function warmSkillEmbeddings(skills: Skill[], query: string, model: string): void {
  for (const skill of skills) {
    const key = skillCacheKey(skill);
    if (skillEmbedCache.has(key)) continue;
    embedText(skillEmbedText(skill), model)
      .then((e) => skillEmbedCache.set(key, e))
      .catch(() => { /* leave uncached — falls back to substring match */ });
  }
  if (query && !queryEmbedCache.has(query)) {
    embedText(query, model)
      .then((e) => {
        if (queryEmbedCache.size >= QUERY_CACHE_MAX) {
          const oldest = queryEmbedCache.keys().next().value;
          if (oldest !== undefined) queryEmbedCache.delete(oldest);
        }
        queryEmbedCache.set(query, e);
      })
      .catch(() => { /* leave uncached */ });
  }
}

function substringMatch(skills: Skill[], query: string, maxResults: number, threshold: number): Skill[] {
  return skills
    .map((s) => ({ skill: s, score: scoreSkill(s, query) }))
    .filter(({ score }) => score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ skill }) => skill);
}

/** Return up to maxResults most-relevant skills for a query. Uses cached
 *  embeddings when available (cosine >= ~0.5), else falls back to the
 *  substring/tag heuristic (threshold filters noise there). Signature is
 *  unchanged from the pre-embedding version — see the module doc above. */
export function matchSkills(
  skills: Skill[],
  query: string,
  maxResults = 3,
  threshold = 1,
): Skill[] {
  const model = useMemoryStore.getState().embedModel;
  const queryEmb = queryEmbedCache.get(query);

  if (queryEmb) {
    const scored = skills
      .map((s) => {
        const emb = skillEmbedCache.get(skillCacheKey(s));
        return emb ? { skill: s, score: cosineSimilarity(queryEmb, emb) } : null;
      })
      .filter((x): x is { skill: Skill; score: number } => x !== null);

    // Only trust the embedding path once every skill in the set has a cached
    // embedding — otherwise a not-yet-warm skill would be silently invisible
    // to matching. Falls through to substring scoring below until fully warm.
    if (scored.length === skills.length) {
      warmSkillEmbeddings(skills, query, model);
      return scored
        .filter(({ score }) => score >= EMBED_MATCH_THRESHOLD)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults)
        .map(({ skill }) => skill);
    }
  }

  warmSkillEmbeddings(skills, query, model);
  return substringMatch(skills, query, maxResults, threshold);
}

/** Format matched skills for injection into an agent system prompt. */
export function formatSkillsForContext(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const blocks = skills.map(
    (s) => `### Skill: ${s.name}\nTags: ${s.tags.join(", ")}\n\n${s.content}`,
  );
  return `## Relevant Skills (inject these into your approach)\n\n${blocks.join("\n\n---\n\n")}`;
}

/** Write a new skill file to .localmind/skills/. Creates directories if needed. */
export async function saveSkill(
  dirHandle: FileSystemDirectoryHandle,
  skill: { name: string; tags: string[]; content: string },
): Promise<string> {
  const lmDir = await dirHandle.getDirectoryHandle(".localmind", { create: true });
  const skillsDir = await lmDir.getDirectoryHandle("skills", { create: true });
  const slug = skill.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const filename = `${slug}.md`;
  const raw =
    `---\nname: ${skill.name}\ntags: ${skill.tags.join(", ")}\n---\n\n${skill.content.trim()}\n`;
  const fileHandle = await skillsDir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(raw);
  await writable.close();
  return filename;
}

/** Delete a skill file. */
export async function deleteSkill(
  dirHandle: FileSystemDirectoryHandle,
  filename: string,
): Promise<void> {
  const lmDir = await dirHandle.getDirectoryHandle(".localmind", { create: false });
  const skillsDir = await lmDir.getDirectoryHandle("skills", { create: false });
  await skillsDir.removeEntry(filename);
}
