/**
 * Shared `.localmind/benchmarks/*.yaml` read/write, factored out of
 * BenchmarkRunner.tsx so Compare.tsx can also save a prompt as a benchmark
 * (the "save this compare prompt as a benchmark" bridge between the two
 * tabs — they duplicate model-selection/streaming UI but historically
 * shared no code or storage at all).
 */

import { streamChatForModel } from "./chatProvider";

export interface BenchmarkDef {
  name: string;
  prompt: string;
  keywords: string[];
  min_matches: number;
  timeout_seconds: number;
  filename: string;
}

export interface BenchmarkResult {
  name: string;
  passed: boolean;
  score: number;       // matched / required
  latencyMs: number;
  response: string;
  error?: string;
  ranAt: string;
}

export interface BenchmarkSuiteSummary {
  total: number;
  passed: number;
  failed: string[];   // names of failed benchmarks
  results: BenchmarkResult[];
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

/**
 * Runs one benchmark def against a model and scores it — the same
 * request/timeout/keyword-match logic BenchmarkRunner.tsx's UI uses, factored
 * out here so it's callable without a React component around it (headless
 * self-improvement passes, propose_feature's regression baseline, etc).
 */
export async function runBenchmarkDef(def: BenchmarkDef, modelRef: string, signal?: AbortSignal): Promise<BenchmarkResult> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);

  const start = Date.now();
  let response = "";
  let errorMsg: string | undefined;
  try {
    const timer = setTimeout(() => ctrl.abort(), def.timeout_seconds * 1000);
    for await (const chunk of streamChatForModel(modelRef, [{ role: "user", content: def.prompt }], ctrl.signal)) {
      response += chunk;
    }
    clearTimeout(timer);
  } catch (err) {
    const e = err as Error;
    errorMsg = e.name === "AbortError" ? `Timed out after ${def.timeout_seconds}s` : e.message;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  const latencyMs = Date.now() - start;
  const matched = def.keywords.filter((kw) => response.toLowerCase().includes(kw.toLowerCase())).length;
  const passed = !errorMsg && matched >= def.min_matches;

  return {
    name: def.name,
    passed,
    score: matched,
    latencyMs,
    response: response.slice(0, 2000),
    error: errorMsg,
    ranAt: new Date().toISOString(),
  };
}

/**
 * Runs every benchmark saved in this workspace against a model, sequentially
 * (benchmarks share the same Ollama server — running them concurrently would
 * just queue on the backend anyway). Returns null if there are no benchmarks
 * to run, so callers can distinguish "nothing to gate against" from "ran and
 * passed everything."
 */
export async function runBenchmarkSuite(
  dirHandle: FileSystemDirectoryHandle,
  modelRef: string,
  signal?: AbortSignal,
): Promise<BenchmarkSuiteSummary | null> {
  const defs = await loadBenchmarks(dirHandle);
  if (defs.length === 0) return null;

  const results: BenchmarkResult[] = [];
  for (const def of defs) {
    results.push(await runBenchmarkDef(def, modelRef, signal));
  }
  const failed = results.filter((r) => !r.passed).map((r) => r.name);
  return { total: results.length, passed: results.length - failed.length, failed, results };
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
