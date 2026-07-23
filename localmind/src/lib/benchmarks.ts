/**
 * Shared `.localmind/benchmarks/*.yaml` read/write, factored out of
 * BenchmarkRunner.tsx so Compare.tsx can also save a prompt as a benchmark
 * (the "save this compare prompt as a benchmark" bridge between the two
 * tabs — they duplicate model-selection/streaming UI but historically
 * shared no code or storage at all).
 */

export interface BenchmarkDef {
  name: string;
  prompt: string;
  keywords: string[];
  min_matches: number;
  timeout_seconds: number;
  filename: string;
}

/** Minimal hand-rolled YAML parser — adequate for the flat schema this module itself generates. */
export function parseBenchmarkYaml(raw: string, filename: string): BenchmarkDef | null {
  try {
    const lines = raw.split("\n");
    const get = (key: string): string => {
      const line = lines.find((l) => l.trimStart().startsWith(`${key}:`));
      return line ? line.split(":").slice(1).join(":").trim().replace(/^["']|["']$/g, "") : "";
    };
    const name = get("name") || filename.replace(/\.yaml$/i, "");
    const prompt = get("prompt");
    const minMatches = parseInt(get("min_matches") || "1", 10);
    const timeout = parseInt(get("timeout_seconds") || "60", 10);
    const kStart = lines.findIndex((l) => l.trimStart().startsWith("keywords:"));
    const keywords: string[] = [];
    if (kStart !== -1) {
      for (let i = kStart + 1; i < lines.length; i++) {
        const l = lines[i];
        if (!l.trimStart().startsWith("-")) break;
        keywords.push(l.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, ""));
      }
    }
    if (!prompt) return null;
    return { name, prompt, keywords, min_matches: minMatches, timeout_seconds: timeout, filename };
  } catch {
    return null;
  }
}

export async function loadBenchmarks(dirHandle: FileSystemDirectoryHandle): Promise<BenchmarkDef[]> {
  const defs: BenchmarkDef[] = [];
  try {
    const lmDir = await dirHandle.getDirectoryHandle(".localmind", { create: false });
    const bmDir = await lmDir.getDirectoryHandle("benchmarks", { create: false });
    for await (const [name, entry] of bmDir.entries()) {
      if (entry.kind !== "file" || !name.endsWith(".yaml")) continue;
      try {
        const file = await (entry as FileSystemFileHandle).getFile();
        const text = await file.text();
        const def = parseBenchmarkYaml(text, name);
        if (def) defs.push(def);
      } catch { /* skip */ }
    }
  } catch { /* no benchmarks dir */ }
  return defs;
}

export async function saveBenchmark(
  dirHandle: FileSystemDirectoryHandle,
  def: BenchmarkDef,
): Promise<void> {
  const lmDir = await dirHandle.getDirectoryHandle(".localmind", { create: true });
  const bmDir = await lmDir.getDirectoryHandle("benchmarks", { create: true });
  const yaml = `name: "${def.name}"\nprompt: "${def.prompt.replace(/"/g, '\\"')}"\nkeywords:\n${
    def.keywords.map((k) => `  - "${k}"`).join("\n")
  }\nmin_matches: ${def.min_matches}\ntimeout_seconds: ${def.timeout_seconds}\n`;
  const fh = await bmDir.getFileHandle(def.filename, { create: true });
  const w = await fh.createWritable(); await w.write(yaml); await w.close();
}

/** Turns a display name into a filesystem-safe `.yaml` filename, deduped
 *  against whatever's already on disk (name.yaml, name-2.yaml, ...). */
export function slugifyBenchmarkFilename(name: string, existing: BenchmarkDef[]): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "benchmark";
  const taken = new Set(existing.map((d) => d.filename));
  let filename = `${base}.yaml`;
  let n = 2;
  while (taken.has(filename)) {
    filename = `${base}-${n}.yaml`;
    n += 1;
  }
  return filename;
}
