/**
 * WP3.2 — self-improvement queue.
 *
 * The local agent cannot edit LocalMind's own source. When it hits a
 * capability it lacks, it drafts a structured spec via the propose_feature
 * tool (see tools.ts) instead of silently refusing or writing a write-only
 * FEATURE_IDEAS.md. Specs are stored as Markdown files with YAML-ish
 * frontmatter under `.localmind/improvements/<slug>.md` — one file per
 * proposal — so the user (or Claude Code) can browse, approve, and
 * eventually implement them.
 *
 * File format:
 *   ---
 *   title: <string>
 *   motivation: <single-line string>
 *   proposed_files: <comma-separated paths>
 *   acceptance_criteria: <single-line string>
 *   size_guess: S | M | L
 *   status: proposed | approved | done
 *   created_at: <ISO timestamp>
 *   ---
 *
 *   <body — the detailed spec, freeform markdown>
 *
 * This mirrors src/lib/skillEngine.ts's save/load pattern (same frontmatter
 * parser, same slug algorithm, same .localmind/<subdir>/ layout) applied to
 * a different subdirectory and field set.
 */

export type ImprovementStatus = "proposed" | "approved" | "done";
export type SizeGuess = "S" | "M" | "L";

export interface Improvement {
  /** Filename stem (also used as the stable id for status updates / deletion). */
  slug: string;
  filename: string;
  title: string;
  motivation: string;
  proposed_files: string[];
  acceptance_criteria: string;
  size_guess: SizeGuess;
  status: ImprovementStatus;
  created_at: string;
  /** The detailed spec (markdown body after the frontmatter). */
  body: string;
}

export interface SaveImprovementInput {
  title: string;
  motivation: string;
  /** Comma-separated string or a string array — both accepted. */
  proposed_files?: string | string[];
  acceptance_criteria?: string;
  size_guess?: string;
  body?: string;
}

const IMPROVEMENTS_DIR = "improvements";

/** Field order used when (re)serializing frontmatter. */
const FIELD_ORDER = [
  "title",
  "motivation",
  "proposed_files",
  "acceptance_criteria",
  "size_guess",
  "status",
  "created_at",
] as const;

/** Parse simple YAML-ish frontmatter (--- key: value --- lines). Mirrors skillEngine.ts. */
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

/** Collapse a value to a single line so it survives the simple frontmatter format. */
function oneLine(s: string): string {
  return s.replace(/\r?\n+/g, " ").trim();
}

function normalizeSizeGuess(val: string | undefined): SizeGuess {
  const v = (val ?? "").trim().toUpperCase();
  return v === "S" || v === "M" || v === "L" ? (v as SizeGuess) : "M";
}

function normalizeStatus(val: string | undefined): ImprovementStatus {
  const v = (val ?? "").trim().toLowerCase();
  return v === "approved" || v === "done" ? v : "proposed";
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "untitled";
}

function parseImprovementFile(filename: string, raw: string): Improvement {
  const { meta, body } = parseFrontmatter(raw);
  const slug = filename.replace(/\.md$/i, "");
  const proposed_files = (meta["proposed_files"] ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  return {
    slug,
    filename,
    title: meta["title"] ?? slug.replace(/-/g, " "),
    motivation: meta["motivation"] ?? "",
    proposed_files,
    acceptance_criteria: meta["acceptance_criteria"] ?? "",
    size_guess: normalizeSizeGuess(meta["size_guess"]),
    status: normalizeStatus(meta["status"]),
    created_at: meta["created_at"] ?? "",
    body: body.trim(),
  };
}

async function getImprovementsDir(
  dirHandle: FileSystemDirectoryHandle,
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    const lmDir = await dirHandle.getDirectoryHandle(".localmind", { create });
    return await lmDir.getDirectoryHandle(IMPROVEMENTS_DIR, { create });
  } catch {
    return null;
  }
}

/** Load all improvement specs from .localmind/improvements/ within the given workspace handle. */
export async function loadImprovements(
  dirHandle: FileSystemDirectoryHandle,
): Promise<Improvement[]> {
  const improvements: Improvement[] = [];
  try {
    const improvementsDir = await getImprovementsDir(dirHandle, false);
    if (!improvementsDir) return [];
    for await (const [name, entry] of improvementsDir.entries()) {
      if (entry.kind !== "file" || !name.endsWith(".md")) continue;
      try {
        const file = await (entry as FileSystemFileHandle).getFile();
        const text = await file.text();
        improvements.push(parseImprovementFile(name, text));
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // workspace doesn't support iteration
  }
  return improvements;
}

/** Write a new improvement spec file to .localmind/improvements/. Creates directories if needed. */
export async function saveImprovement(
  dirHandle: FileSystemDirectoryHandle,
  spec: SaveImprovementInput,
): Promise<string> {
  const lmDir = await dirHandle.getDirectoryHandle(".localmind", { create: true });
  const improvementsDir = await lmDir.getDirectoryHandle(IMPROVEMENTS_DIR, { create: true });

  const slug = slugify(spec.title);
  const filename = `${slug}.md`;
  const proposedFiles = Array.isArray(spec.proposed_files)
    ? spec.proposed_files.map((f) => f.trim()).filter(Boolean).join(", ")
    : oneLine(spec.proposed_files ?? "");

  const meta: Record<string, string> = {
    title: oneLine(spec.title),
    motivation: oneLine(spec.motivation ?? ""),
    proposed_files: proposedFiles,
    acceptance_criteria: oneLine(spec.acceptance_criteria ?? ""),
    size_guess: normalizeSizeGuess(spec.size_guess),
    status: "proposed",
    created_at: new Date().toISOString(),
  };
  const metaLines = FIELD_ORDER.map((k) => `${k}: ${meta[k]}`);
  const raw = `---\n${metaLines.join("\n")}\n---\n\n${(spec.body ?? "").trim()}\n`;

  const fileHandle = await improvementsDir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(raw);
  await writable.close();
  return `.localmind/${IMPROVEMENTS_DIR}/${filename}`;
}

/** Update the status field of an existing improvement spec, preserving all other fields/body. */
export async function setImprovementStatus(
  dirHandle: FileSystemDirectoryHandle,
  slug: string,
  status: ImprovementStatus,
): Promise<void> {
  const improvementsDir = await getImprovementsDir(dirHandle, false);
  if (!improvementsDir) throw new Error("No .localmind/improvements directory found");
  const filename = `${slug}.md`;
  const fileHandle = await improvementsDir.getFileHandle(filename, { create: false });
  const file = await fileHandle.getFile();
  const raw = await file.text();
  const { meta, body } = parseFrontmatter(raw);
  meta["status"] = status;
  const metaLines = FIELD_ORDER.filter((k) => meta[k] !== undefined).map((k) => `${k}: ${meta[k]}`);
  const updated = `---\n${metaLines.join("\n")}\n---\n\n${body.trim()}\n`;
  const writable = await fileHandle.createWritable();
  await writable.write(updated);
  await writable.close();
}

/** Delete an improvement spec file. */
export async function deleteImprovement(
  dirHandle: FileSystemDirectoryHandle,
  slug: string,
): Promise<void> {
  const improvementsDir = await getImprovementsDir(dirHandle, false);
  if (!improvementsDir) throw new Error("No .localmind/improvements directory found");
  await improvementsDir.removeEntry(`${slug}.md`);
}
