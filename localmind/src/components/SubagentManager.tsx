import { useRef, useState } from "react";
import { Plus, Square, Trash2, ChevronDown, ChevronUp, Cpu, Bot, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { cn } from "./ui/utils";
import { useModelStore } from "../store/models";
import { useChatStore } from "../store/chat";
import { useAgentStore } from "../store/agent";
import { useSessionResultsStore } from "../store/sessionResults";
import { runHeadlessTask, HEADLESS_DEFAULT_ALLOWLIST } from "../lib/headlessRunner";
import { MODEL_LIBRARY } from "../lib/modelLibrary";
import type { ModelSpec } from "../lib/modelLibrary";

// ─── Types ────────────────────────────────────────────────────────────────────

type AgentStatus = "queued" | "running" | "done" | "error" | "idle";

interface Subagent {
  id: string;
  model: string;
  task: string;
  status: AgentStatus;
  output: string;
  vramGb: number;
  createdAt: number;
  expanded: boolean;
  /** SessionResult.id once the run has been persisted to useSessionResultsStore. */
  resultId?: string;
}

/** Real subagents run as headless agent sessions with tools, capped at this
 * many concurrent runs (VRAM contention — see SubagentManager audit). Extra
 * spawns wait in a queue and start as running slots free up. */
const MAX_CONCURRENT = 2;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function vramForModel(modelId: string): number {
  const spec = MODEL_LIBRARY.find((m) => m.id === modelId);
  if (spec) return spec.minVramGb;
  // Rough heuristic from model name suffix
  const lower = modelId.toLowerCase();
  if (lower.includes(":70b") || lower.includes(":65b")) return 40;
  if (lower.includes(":34b") || lower.includes(":30b")) return 20;
  if (lower.includes(":13b")) return 8;
  if (lower.includes(":8b") || lower.includes(":7b")) return 6;
  if (lower.includes(":3b")) return 3;
  if (lower.includes(":1b")) return 2;
  return 4;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

// VRAM budget bar segment
function VramBar({ total, used, pending }: { total: number; used: number; pending: number }) {
  const usedPct = total > 0 ? Math.min((used / total) * 100, 100) : 0;
  const pendingPct = total > 0 ? Math.min((pending / total) * 100, 100 - usedPct) : 0;
  const free = Math.max(total - used - pending, 0);

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>VRAM budget</span>
        <span>{free.toFixed(1)} / {total} GB free</span>
      </div>
      <div className="h-3 rounded-full bg-muted overflow-hidden flex">
        {usedPct > 0 && (
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${usedPct}%` }}
            title={`Running: ${used} GB`}
          />
        )}
        {pendingPct > 0 && (
          <div
            className="h-full bg-amber-400/60 transition-all"
            style={{ width: `${pendingPct}%` }}
            title={`Selected model: ${pending} GB`}
          />
        )}
      </div>
      <div className="flex gap-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-primary inline-block" /> Running</span>
        <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-amber-400/60 inline-block" /> Selected</span>
        <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-muted-foreground/30 inline-block" /> Free</span>
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SubagentManager() {
  const { hardware, vramOverride } = useModelStore();
  const { availableModels } = useChatStore();
  const workspacePath = useAgentStore((s) => s.workspacePath);
  const sessionResultCount = useSessionResultsStore(
    (s) => s.results.filter((r) => r.origin === "subagent").length
  );

  const totalVram = vramOverride ?? hardware?.vramGb ?? 0;

  const [agents, setAgents] = useState<Subagent[]>([]);
  const [selectedModel, setSelectedModel] = useState(availableModels[0] ?? "");
  const [task, setTask] = useState("");

  const abortRefs = useRef<Record<string, AbortController>>({});
  // Params for queued agents that haven't started yet (looked up when a slot frees up).
  const paramsRef = useRef<Record<string, { model: string; task: string }>>({});
  const queueRef = useRef<string[]>([]);
  const runningCountRef = useRef(0);

  const runningVram = agents
    .filter((a) => a.status === "running")
    .reduce((sum, a) => sum + a.vramGb, 0);

  const selectedVram = vramForModel(selectedModel);
  const freeVram = Math.max(totalVram - runningVram, 0);
  const canFit = totalVram === 0 || selectedVram <= freeVram;

  // Recommend models that fit in remaining VRAM
  const recommendations = MODEL_LIBRARY.filter((spec) => {
    if (!availableModels.includes(spec.id)) return false;
    if (totalVram === 0) return true;
    return spec.minVramGb <= freeVram;
  }).slice(0, 6);

  function updateAgent(id: string, patch: Partial<Subagent>) {
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }

  function pumpQueue() {
    while (runningCountRef.current < MAX_CONCURRENT && queueRef.current.length > 0) {
      const id = queueRef.current.shift()!;
      const params = paramsRef.current[id];
      if (!params) continue;
      runningCountRef.current++;
      updateAgent(id, { status: "running" });
      void runOne(id, params).finally(() => {
        runningCountRef.current--;
        delete paramsRef.current[id];
        pumpQueue();
      });
    }
  }

  async function runOne(id: string, params: { model: string; task: string }) {
    const abort = new AbortController();
    abortRefs.current[id] = abort;
    try {
      const { record, transcript } = await runHeadlessTask({
        workspacePath: workspacePath!,
        modelRef: params.model,
        task: params.task,
        hardware,
        origin: "subagent",
        agentBuildMode: true,
        // Read-only by default — parallel subagents writing files concurrently
        // is footgun-prone, so fan-out subagents get analysis tools only
        // (read_file, list_directory, grep_files, find_files, web_search,
        // web_fetch, get_system_info, git_status/diff/log, list_skills,
        // calculator). See HEADLESS_DEFAULT_ALLOWLIST in headlessRunner.ts.
        toolAllowlist: HEADLESS_DEFAULT_ALLOWLIST,
        signal: abort.signal,
      });

      const finalOutput = transcript.trim().length > 0 ? transcript.trim() : record.summary;

      if (record.outcome === "aborted") {
        updateAgent(id, { status: "idle", output: finalOutput, resultId: record.id });
      } else if (record.outcome === "error") {
        updateAgent(id, { status: "error", output: finalOutput || "Error running subagent.", resultId: record.id });
        toast.error(`Subagent error (${params.model})`);
      } else {
        updateAgent(id, { status: "done", output: finalOutput, resultId: record.id });
        toast.success(`Subagent (${params.model}) finished`);
      }
    } catch (err) {
      const e = err as Error;
      if (e.name === "AbortError") {
        updateAgent(id, { status: "idle" });
      } else {
        updateAgent(id, { status: "error", output: `Error: ${e.message}` });
        toast.error(`Subagent error: ${e.message}`);
      }
    } finally {
      delete abortRefs.current[id];
    }
  }

  function spawnAgent() {
    if (!selectedModel || !task.trim()) {
      toast.error("Select a model and enter a task.");
      return;
    }
    if (!workspacePath) {
      toast.error("Subagents need an open workspace — open a project folder first.");
      return;
    }

    const id = uid();
    const vramGb = vramForModel(selectedModel);
    const newAgent: Subagent = {
      id,
      model: selectedModel,
      task: task.trim(),
      status: "queued",
      output: "",
      vramGb,
      createdAt: Date.now(),
      expanded: true,
    };

    setAgents((prev) => [newAgent, ...prev]);
    paramsRef.current[id] = { model: selectedModel, task: task.trim() };
    queueRef.current.push(id);
    setTask("");
    pumpQueue();
  }

  function stopAgent(id: string) {
    if (abortRefs.current[id]) {
      abortRefs.current[id].abort();
      return;
    }
    // Not started yet — just drop it from the queue.
    queueRef.current = queueRef.current.filter((qid) => qid !== id);
    delete paramsRef.current[id];
    updateAgent(id, { status: "idle" });
  }

  function removeAgent(id: string) {
    stopAgent(id);
    setAgents((prev) => prev.filter((a) => a.id !== id));
  }

  function combineOutputs() {
    const done = agents.filter((a) => a.status === "done" && a.output);
    if (done.length === 0) { toast.error("No completed agents to combine."); return; }
    const combined = done
      .map((a) => `### Agent: ${a.model}\n**Task:** ${a.task}\n\n${a.output}`)
      .join("\n\n---\n\n");
    void navigator.clipboard.writeText(combined);
    toast.success(`Copied ${done.length} agent outputs to clipboard`);
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="h-14 border-b bg-card px-4 flex items-center gap-3 shrink-0">
        <Bot className="size-5 text-primary" />
        <div>
          <h2 className="text-sm font-medium">Subagent Manager</h2>
          <p className="text-[11px] text-muted-foreground">
            Delegate tasks to real, tool-using agent sessions (read-only, max {MAX_CONCURRENT} at once)
          </p>
        </div>
        <div className="flex-1" />
        {sessionResultCount > 0 && (
          <span className="text-[11px] text-muted-foreground" title="Subagent runs persist in Session Results even after this view unmounts">
            {sessionResultCount} persisted in Session Results
          </span>
        )}
        {agents.some((a) => a.status === "done") && (
          <Button size="sm" variant="outline" className="text-xs h-7" onClick={combineOutputs}>
            Copy All Results
          </Button>
        )}
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left panel: spawn controls */}
        <div className="w-72 shrink-0 border-r bg-card flex flex-col p-4 gap-4 overflow-y-auto">
          {!workspacePath && (
            <div className="text-[11px] text-destructive bg-destructive/10 border border-destructive/30 rounded p-2">
              No workspace open — subagents need an open project folder to run (they read files from it). Open a folder first.
            </div>
          )}

          {/* VRAM budget */}
          {totalVram > 0 ? (
            <VramBar total={totalVram} used={runningVram} pending={canFit ? selectedVram : 0} />
          ) : (
            <div className="text-[11px] text-muted-foreground bg-muted rounded p-2">
              VRAM unknown — scan hardware in Model Library for budget tracking.
            </div>
          )}

          {/* Model picker */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Model</label>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="w-full text-xs h-8 px-2 rounded border border-border bg-background text-foreground"
            >
              {availableModels.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-muted-foreground">
                Est. VRAM: {selectedVram} GB
              </span>
              <span className={cn(
                "font-medium",
                canFit ? "text-green-600" : "text-red-500"
              )}>
                {totalVram === 0 ? "budget unknown" : canFit ? "fits" : "may not fit"}
              </span>
            </div>
          </div>

          {/* VRAM-based recommendations */}
          {recommendations.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-foreground flex items-center gap-1">
                <Zap className="size-3 text-amber-500" />
                Fits in free VRAM
              </div>
              <div className="flex flex-wrap gap-1">
                {recommendations.map((spec) => (
                  <button
                    key={spec.id}
                    type="button"
                    onClick={() => setSelectedModel(spec.id)}
                    className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded border transition-colors",
                      selectedModel === spec.id
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-foreground border-border hover:bg-accent"
                    )}
                    title={`${spec.name} — ${spec.minVramGb} GB VRAM`}
                  >
                    {spec.id} ({spec.minVramGb}G)
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Task input */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">Task</label>
            <Textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="Describe what this agent should do…"
              rows={4}
              className="text-xs min-h-[80px]"
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); spawnAgent(); }
              }}
            />
            <p className="text-[10px] text-muted-foreground">Ctrl+Enter to spawn · read-only tools (no writes, no shell)</p>
          </div>

          <Button
            onClick={spawnAgent}
            disabled={!selectedModel || !task.trim() || !workspacePath}
            className="w-full gap-2"
          >
            <Plus className="size-4" />
            Spawn Agent
          </Button>

          {/* Running summary */}
          {agents.length > 0 && (
            <div className="text-[11px] text-muted-foreground space-y-0.5 border-t pt-3">
              <div className="font-medium text-foreground mb-1">Active agents</div>
              {agents.map((a) => (
                <div key={a.id} className="flex items-center justify-between">
                  <span className="truncate max-w-[140px]" title={a.model}>{a.model}</span>
                  <StatusBadge status={a.status} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right panel: agent cards */}
        <div className="flex-1 min-w-0 overflow-hidden">
          {agents.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
              <Cpu className="size-10 opacity-20" />
              <p className="text-sm">No agents spawned yet</p>
              <p className="text-xs max-w-xs text-center">
                Select a model, enter a task, and click Spawn Agent to run parallel, tool-using agent sessions against the current workspace.
              </p>
            </div>
          ) : (
            <ScrollArea className="h-full">
              <div className="p-4 space-y-3">
                {agents.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    onToggle={() => updateAgent(agent.id, { expanded: !agent.expanded })}
                    onStop={() => stopAgent(agent.id)}
                    onRemove={() => removeAgent(agent.id)}
                  />
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Agent card ───────────────────────────────────────────────────────────────

function AgentCard({
  agent,
  onToggle,
  onStop,
  onRemove,
}: {
  agent: Subagent;
  onToggle: () => void;
  onStop: () => void;
  onRemove: () => void;
}) {
  return (
    <div className={cn(
      "border rounded-lg bg-card overflow-hidden transition-all",
      agent.status === "error" && "border-destructive/40",
      agent.status === "done" && "border-green-500/30",
      agent.status === "running" && "border-primary/40",
      agent.status === "queued" && "border-amber-400/40",
    )}>
      {/* Card header */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-accent/50 select-none"
        onClick={onToggle}
      >
        <StatusBadge status={agent.status} />
        <span className="text-xs font-medium text-foreground truncate max-w-[160px]" title={agent.model}>
          {agent.model}
        </span>
        <span className="text-[11px] text-muted-foreground truncate flex-1" title={agent.task}>
          {agent.task.slice(0, 80)}{agent.task.length > 80 ? "…" : ""}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          {(agent.status === "running" || agent.status === "queued") && (
            <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs" onClick={(e) => { e.stopPropagation(); onStop(); }}>
              <Square className="size-3" />
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs text-muted-foreground hover:text-destructive"
            onClick={(e) => { e.stopPropagation(); onRemove(); }}>
            <Trash2 className="size-3" />
          </Button>
          {agent.expanded ? <ChevronUp className="size-3 text-muted-foreground" /> : <ChevronDown className="size-3 text-muted-foreground" />}
        </div>
      </div>

      {/* Expanded output */}
      {agent.expanded && (
        <div className="border-t">
          <div className="px-3 py-1.5 bg-muted/30 border-b">
            <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Task</span>
            <p className="text-xs text-foreground mt-0.5">{agent.task}</p>
          </div>
          <div className="px-3 py-2 max-h-64 overflow-y-auto">
            {agent.output ? (
              <pre className="text-xs whitespace-pre-wrap font-mono text-foreground leading-5">
                {agent.output}
              </pre>
            ) : (
              <span className="text-xs text-muted-foreground italic">
                {agent.status === "running"
                  ? "Working… (headless agent session — output appears when it finishes)"
                  : agent.status === "queued"
                  ? "Waiting for a free slot (max 2 concurrent subagents)…"
                  : "No output"}
              </span>
            )}
          </div>
          {(agent.status === "done" || agent.status === "error") && agent.output && (
            <div className="px-3 py-2 border-t flex gap-2 items-center flex-wrap">
              <Button
                size="sm" variant="outline" className="text-xs h-6 px-2"
                onClick={() => {
                  void navigator.clipboard.writeText(agent.output);
                  toast.success("Output copied");
                }}
              >
                Copy
              </Button>
              <span className="text-[10px] text-muted-foreground self-center">
                {agent.vramGb} GB VRAM · {new Date(agent.createdAt).toLocaleTimeString()}
              </span>
              {agent.resultId && (
                <span className="text-[10px] text-muted-foreground self-center" title="Persisted in Session Results — survives this view unmounting">
                  · saved (session result {agent.resultId.slice(0, 8)})
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: AgentStatus }) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "text-[10px] px-1.5 py-0 h-4 shrink-0",
        status === "running" && "bg-primary/20 text-primary animate-pulse",
        status === "queued" && "bg-amber-100 text-amber-700",
        status === "done" && "bg-green-100 text-green-700",
        status === "error" && "bg-red-100 text-red-700",
        status === "idle" && "bg-muted text-muted-foreground",
      )}
    >
      {status === "running" ? "running" : status}
    </Badge>
  );
}

// Re-export model spec type for use elsewhere
export type { ModelSpec };
