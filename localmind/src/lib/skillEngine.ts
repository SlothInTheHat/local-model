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

/** Return up to maxResults most-relevant skills for a query. Threshold filters noise. */
export function matchSkills(
  skills: Skill[],
  query: string,
  maxResults = 3,
  threshold = 1,
): Skill[] {
  return skills
    .map((s) => ({ skill: s, score: scoreSkill(s, query) }))
    .filter(({ score }) => score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(({ skill }) => skill);
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
