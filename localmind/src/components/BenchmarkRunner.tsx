import { useState, useEffect, useRef } from "react";
import {
  BarChart2, Play, RefreshCw, CheckCircle, XCircle, Clock,
  Plus, FolderOpen, Save, X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { streamChatForModel } from "../lib/chatProvider";
import { openWorkspace } from "../lib/fileSystem";
import { useAgentStore } from "../store/agent";
import { type BenchmarkDef, loadBenchmarks, saveBenchmark } from "../lib/benchmarks";

interface BenchmarkResult {
  name: string;
  passed: boolean;
  score: number;       // matched / required
  latencyMs: number;
  response: string;
  error?: string;
  ranAt: string;
}

interface Props { selectedModel: string; }

const EXAMPLE_YAML = `name: "Read App.tsx summary"
prompt: "Read src/App.tsx and give a one-sentence summary"
keywords:
  - App
  - component
  - view
min_matches: 2
timeout_seconds: 60`;

async function saveResults(
  dirHandle: FileSystemDirectoryHandle,
  results: BenchmarkResult[],
): Promise<void> {
  const lmDir = await dirHandle.getDirectoryHandle(".localmind", { create: true });
  const fh = await lmDir.getFileHandle("benchmark-results.json", { create: true });
  const w = await fh.createWritable(); await w.write(JSON.stringify(results, null, 2)); await w.close();
}

export function BenchmarkRunner({ selectedModel }: Props) {
  const { dirHandle, setWorkspace } = useAgentStore();
  const [benchmarks, setBenchmarks] = useState<BenchmarkDef[]>([]);
  const [results, setResults] = useState<Map<string, BenchmarkResult>>(new Map());
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  // Editor
  const [editorOpen, setEditorOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [editKeywords, setEditKeywords] = useState("");
  const [editMinMatches, setEditMinMatches] = useState("2");
  const [editTimeout, setEditTimeout] = useState("60");
  const [savingDef, setSavingDef] = useState(false);

  const abortRefs = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    if (!dirHandle) { setBenchmarks([]); return; }
    setLoading(true);
    loadBenchmarks(dirHandle).then(setBenchmarks).finally(() => setLoading(false));
  }, [dirHandle]);

  async function handleOpenWorkspace() {
    try {
      const ws = await openWorkspace();
      setWorkspace(ws.handle, ws.path, ws.name);
      toast.success(`Workspace: ${ws.name}`);
    } catch (err) {
      const e = err as Error;
      if (e.name !== "AbortError") toast.error(e.message);
    }
  }

  async function runBenchmark(def: BenchmarkDef) {
    if (!selectedModel) { toast.error("No model selected"); return; }
    const ctrl = new AbortController();
    abortRefs.current.set(def.name, ctrl);
    setRunning((prev) => new Set(prev).add(def.name));

    const start = Date.now();
    let response = "";
    let errorMsg: string | undefined;

    try {
      const timer = setTimeout(() => ctrl.abort(), def.timeout_seconds * 1000);
      for await (const chunk of streamChatForModel(
        selectedModel,
        [{ role: "user", content: def.prompt }],
        ctrl.signal,
      )) {
        response += chunk;
      }
      clearTimeout(timer);
    } catch (err) {
      const e = err as Error;
      if (e.name === "AbortError") {
        errorMsg = `Timed out after ${def.timeout_seconds}s`;
      } else {
        errorMsg = e.message;
      }
    }

    const latency = Date.now() - start;
    const matched = def.keywords.filter((kw) =>
      response.toLowerCase().includes(kw.toLowerCase()),
    ).length;
    const passed = !errorMsg && matched >= def.min_matches;

    const result: BenchmarkResult = {
      name: def.name,
      passed,
      score: matched,
      latencyMs: latency,
      response: response.slice(0, 2000),
      error: errorMsg,
      ranAt: new Date().toISOString(),
    };

    setResults((prev) => new Map(prev).set(def.name, result));
    setRunning((prev) => { const n = new Set(prev); n.delete(def.name); return n; });
    abortRefs.current.delete(def.name);

    if (dirHandle) {
      const all = [...results.values(), result];
      saveResults(dirHandle, all).catch(() => {});
    }
  }

  async function runAll() {
    for (const def of benchmarks) {
      if (!running.has(def.name)) await runBenchmark(def);
    }
  }

  async function handleSaveDef() {
    if (!dirHandle) return;
    if (!editName.trim() || !editPrompt.trim()) { toast.error("Name and prompt required"); return; }
    setSavingDef(true);
    try {
      const slug = editName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const def: BenchmarkDef = {
        name: editName.trim(),
        prompt: editPrompt.trim(),
        keywords: editKeywords.split(",").map((k) => k.trim()).filter(Boolean),
        min_matches: parseInt(editMinMatches, 10) || 1,
        timeout_seconds: parseInt(editTimeout, 10) || 60,
        filename: `${slug}.yaml`,
      };
      await saveBenchmark(dirHandle, def);
      const updated = await loadBenchmarks(dirHandle);
      setBenchmarks(updated);
      setEditorOpen(false);
      toast.success(`Benchmark saved: ${def.name}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSavingDef(false);
    }
  }

  const passCount = [...results.values()].filter((r) => r.passed).length;
  const totalRan = results.size;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="h-12 border-b bg-card px-4 flex items-center gap-3 shrink-0">
        <BarChart2 className="size-4 text-primary" />
        <span className="font-semibold text-sm">Benchmark Runner</span>
        {totalRan > 0 && (
          <span className="text-xs text-muted-foreground">
            {passCount}/{totalRan} passed
          </span>
        )}
        <div className="ml-auto flex gap-2">
          {!dirHandle ? (
            <Button size="sm" variant="outline" className="h-8 text-xs gap-1" onClick={() => void handleOpenWorkspace()}>
              <FolderOpen className="size-3" /> Open workspace
            </Button>
          ) : (
            <>
              <Button size="sm" variant="outline" className="h-8 text-xs gap-1"
                onClick={() => { setEditorOpen(true); setEditName(""); setEditPrompt(""); setEditKeywords(""); setEditMinMatches("2"); setEditTimeout("60"); }}>
                <Plus className="size-3" /> New benchmark
              </Button>
              <Button size="sm" className="h-8 text-xs gap-1"
                onClick={() => void runAll()}
                disabled={benchmarks.length === 0 || running.size > 0}>
                <Play className="size-3" /> Run all
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Editor drawer */}
      {editorOpen && (
        <div className="border-b bg-muted/30 p-4 space-y-3 shrink-0">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">New benchmark</p>
            <button onClick={() => setEditorOpen(false)} className="text-muted-foreground hover:text-foreground">
              <X className="size-4" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium">Name</label>
              <input value={editName} onChange={(e) => setEditName(e.target.value)}
                placeholder="e.g. Summarize App.tsx"
                className="w-full text-xs h-8 px-2 rounded border border-border bg-background" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Keywords (comma-separated)</label>
              <input value={editKeywords} onChange={(e) => setEditKeywords(e.target.value)}
                placeholder="App, component, view"
                className="w-full text-xs h-8 px-2 rounded border border-border bg-background" />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium">Prompt</label>
            <Textarea value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)}
              placeholder={EXAMPLE_YAML.split("\n")[1].replace('prompt: "', "").replace('"', "")}
              rows={2} className="text-xs min-h-[48px]" />
          </div>
          <div className="flex items-center gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium">Min keyword matches</label>
              <input type="number" value={editMinMatches} onChange={(e) => setEditMinMatches(e.target.value)}
                min={1} className="w-20 text-xs h-8 px-2 rounded border border-border bg-background" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Timeout (seconds)</label>
              <input type="number" value={editTimeout} onChange={(e) => setEditTimeout(e.target.value)}
                min={5} className="w-20 text-xs h-8 px-2 rounded border border-border bg-background" />
            </div>
            <Button size="sm" className="mt-4 gap-1 h-8 text-xs" onClick={() => void handleSaveDef()} disabled={savingDef}>
              <Save className="size-3" /> {savingDef ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}

      {/* Benchmark table */}
      <div className="flex-1 overflow-y-auto">
        {!dirHandle && (
          <div className="flex flex-col items-center justify-center h-full text-center p-8 space-y-3">
            <BarChart2 className="size-10 text-muted-foreground/30" />
            <p className="text-sm font-medium">Open a workspace to load benchmarks</p>
            <p className="text-xs text-muted-foreground">
              Benchmark files live at <code>.localmind/benchmarks/*.yaml</code>
            </p>
          </div>
        )}

        {dirHandle && !loading && benchmarks.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center p-8 space-y-4">
            <BarChart2 className="size-10 text-muted-foreground/30" />
            <div>
              <p className="text-sm font-medium">No benchmarks yet</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                Create benchmark tasks to objectively measure how well models perform on your specific workload.
              </p>
            </div>
            <pre className="text-left text-[10px] font-mono bg-muted rounded p-3 border max-w-sm w-full">
              {EXAMPLE_YAML}
            </pre>
            <Button size="sm" className="gap-1" onClick={() => setEditorOpen(true)}>
              <Plus className="size-4" /> Create first benchmark
            </Button>
          </div>
        )}

        {loading && <p className="p-4 text-xs text-muted-foreground">Loading benchmarks…</p>}

        {benchmarks.length > 0 && (
          <table className="w-full text-xs">
            <thead className="border-b bg-muted/30">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-muted-foreground">Benchmark</th>
                <th className="text-left px-4 py-2 font-medium text-muted-foreground">Keywords</th>
                <th className="text-center px-4 py-2 font-medium text-muted-foreground">Result</th>
                <th className="text-center px-4 py-2 font-medium text-muted-foreground">Latency</th>
                <th className="text-center px-4 py-2 font-medium text-muted-foreground">Action</th>
              </tr>
            </thead>
            <tbody>
              {benchmarks.map((def) => {
                const result = results.get(def.name);
                const isRunning = running.has(def.name);
                return (
                  <tr key={def.name} className="border-b hover:bg-muted/20">
                    <td className="px-4 py-3">
                      <p className="font-medium">{def.name}</p>
                      <p className="text-muted-foreground text-[10px] mt-0.5 max-w-[240px] truncate">{def.prompt}</p>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {def.keywords.slice(0, 4).map((kw) => (
                          <span key={kw} className={`text-[10px] px-1.5 py-0.5 rounded border ${
                            result
                              ? result.response.toLowerCase().includes(kw.toLowerCase())
                                ? "bg-success/10 border-success/30 text-success"
                                : "bg-destructive/10 border-destructive/30 text-destructive"
                              : "bg-muted border-border text-muted-foreground"
                          }`}>{kw}</span>
                        ))}
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        Need {def.min_matches}/{def.keywords.length}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-center">
                      {isRunning ? (
                        <span className="inline-flex items-center gap-1 text-[10px] text-info">
                          <RefreshCw className="size-3 animate-spin" /> Running
                        </span>
                      ) : result ? (
                        <span className={`inline-flex items-center gap-1 text-[10px] font-medium ${result.passed ? "text-success" : "text-destructive"}`}>
                          {result.passed ? <CheckCircle className="size-3" /> : <XCircle className="size-3" />}
                          {result.passed ? "PASS" : "FAIL"}
                          <span className="text-muted-foreground font-normal ml-1">{result.score}/{def.keywords.length}</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-[10px]">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center text-muted-foreground tabular-nums">
                      {result ? (
                        <span className="inline-flex items-center gap-1 text-[10px]">
                          <Clock className="size-3" />
                          {(result.latencyMs / 1000).toFixed(1)}s
                        </span>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {isRunning ? (
                        <Button size="sm" variant="outline" className="h-6 text-[10px] px-2"
                          onClick={() => abortRefs.current.get(def.name)?.abort()}>
                          Stop
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline" className="h-6 text-[10px] px-2 gap-1"
                          onClick={() => void runBenchmark(def)}>
                          <Play className="size-2.5" /> Run
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Results summary bar */}
      {totalRan > 0 && (
        <div className="border-t px-4 py-2 bg-card flex items-center gap-4 shrink-0">
          <span className="text-xs font-medium">{passCount}/{totalRan} passed</span>
          <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-success rounded-full transition-all"
              style={{ width: `${(passCount / totalRan) * 100}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground">
            Model: {selectedModel || "none"}
          </span>
        </div>
      )}
    </div>
  );
}
