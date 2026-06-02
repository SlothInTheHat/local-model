import { useRef, useState } from "react";
import { Plus, Square, Trash2, ChevronDown, ChevronUp, Cpu, Bot, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";
import { cn } from "./ui/utils";
import { streamChat } from "../lib/ollama";
import { useModelStore } from "../store/models";
import { useChatStore } from "../store/chat";
import { MODEL_LIBRARY } from "../lib/modelLibrary";
import type { ModelSpec } from "../lib/modelLibrary";

// ─── Types ────────────────────────────────────────────────────────────────────

type AgentStatus = "idle" | "running" | "done" | "error";

interface Subagent {
  id: string;
  model: string;
  task: string;
  status: AgentStatus;
  output: string;
  vramGb: number;
  createdAt: number;
  expanded: boolean;
}

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

  const totalVram = vramOverride ?? hardware?.vramGb ?? 0;

  const [agents, setAgents] = useState<Subagent[]>([]);
  const [selectedModel, setSelectedModel] = useState(availableModels[0] ?? "");
  const [task, setTask] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(
    "You are a focused AI subagent. Complete the assigned task concisely and return your result."
  );
  const [showSysPrompt, setShowSysPrompt] = useState(false);

  const abortRefs = useRef<Record<string, AbortController>>({});

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

  async function spawnAgent() {
    if (!selectedModel || !task.trim()) {
      toast.error("Select a model and enter a task.");
      return;
    }

    const id = uid();
    const vramGb = vramForModel(selectedModel);
    const newAgent: Subagent = {
      id,
      model: selectedModel,
      task: task.trim(),
      status: "running",
      output: "",
      vramGb,
      createdAt: Date.now(),
      expanded: true,
    };

    setAgents((prev) => [newAgent, ...prev]);
    setTask("");

    const abort = new AbortController();
    abortRefs.current[id] = abort;

    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: task.trim() },
    ];

    try {
      for await (const chunk of streamChat(selectedModel, messages, abort.signal)) {
        setAgents((prev) =>
          prev.map((a) => (a.id === id ? { ...a, output: a.output + chunk } : a))
        );
      }
      updateAgent(id, { status: "done" });
      toast.success(`Subagent (${selectedModel}) finished`);
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

  function stopAgent(id: string) {
    abortRefs.current[id]?.abort();
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
            Delegate tasks to multiple parallel AI agents
          </p>
        </div>
        <div className="flex-1" />
        {agents.some((a) => a.status === "done") && (
          <Button size="sm" variant="outline" className="text-xs h-7" onClick={combineOutputs}>
            Copy All Results
          </Button>
        )}
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left panel: spawn controls */}
        <div className="w-72 shrink-0 border-r bg-card flex flex-col p-4 gap-4 overflow-y-auto">
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
                if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); void spawnAgent(); }
              }}
            />
            <p className="text-[10px] text-muted-foreground">Ctrl+Enter to spawn</p>
          </div>

          {/* System prompt (collapsible) */}
          <div className="space-y-1">
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground w-full"
              onClick={() => setShowSysPrompt((v) => !v)}
            >
              {showSysPrompt ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              System prompt
            </button>
            {showSysPrompt && (
              <Textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={3}
                className="text-xs min-h-[60px]"
              />
            )}
          </div>

          <Button
            onClick={() => void spawnAgent()}
            disabled={!selectedModel || !task.trim()}
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
                Select a model, enter a task, and click Spawn Agent to run parallel AI workers.
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
          {agent.status === "running" && (
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
                {agent.status === "running" && <span className="animate-pulse">▌</span>}
              </pre>
            ) : (
              <span className="text-xs text-muted-foreground italic">
                {agent.status === "running" ? "Working…" : "No output"}
              </span>
            )}
          </div>
          {agent.status === "done" && agent.output && (
            <div className="px-3 py-2 border-t flex gap-2">
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
