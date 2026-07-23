import { useEffect, useState } from "react";
import { ScrollText, Trash2, Download, Copy, ChevronDown, ChevronRight, Clock } from "lucide-react";
import { Button } from "./ui/button";
import { toast } from "sonner";
import { getAllSessions, deleteSession, formatSessionForAnalysis } from "../lib/agentLogger";
import type { AgentSession, LoggedEvent } from "../lib/agentLogger";
import { useSessionResultsStore } from "../store/sessionResults";
import type { SessionResult } from "../store/sessionResults";
import { useAppViewStore } from "../store/appView";

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return "just now";
}

// Categorical per-tool-type coloring (not a status), so these stay literal
// palette colors with dark: pairings rather than the semantic status tokens.
function toolColor(name: string): string {
  if (name === "read_file") return "text-blue-600 dark:text-blue-400";
  if (name === "write_file") return "text-green-600 dark:text-green-400";
  if (name === "delete_file") return "text-red-600 dark:text-red-400";
  if (name === "list_directory") return "text-slate-500 dark:text-slate-400";
  if (name === "grep_files" || name === "find_files") return "text-indigo-600 dark:text-indigo-400";
  if (name === "web_search") return "text-violet-600 dark:text-violet-400";
  if (name === "run_command") return "text-orange-600 dark:text-orange-400";
  if (name?.startsWith("git_")) return "text-yellow-600 dark:text-yellow-400";
  return "text-muted-foreground";
}

function EventLine({ ev }: { ev: LoggedEvent }) {
  const d = ev.data;
  if (d.type === "round") {
    return <div className="text-[10px] font-semibold text-muted-foreground mt-2">─── Round {d.round} ───</div>;
  }
  if (d.type === "agent_text" && d.content.trim()) {
    return (
      <div className="text-[10px] text-foreground/80 pl-1 italic line-clamp-2">
        {d.content.trim().slice(0, 300)}
      </div>
    );
  }
  if (d.type === "tool_call") {
    const argStr = Object.entries(d.args)
      .map(([k, v]) => `${k}: ${JSON.stringify(v).slice(0, 60)}`)
      .join(", ");
    return (
      <div className={`text-[10px] font-mono ${toolColor(d.name)}`}>
        ▶ {d.name}({argStr})
      </div>
    );
  }
  if (d.type === "tool_result") {
    if (d.error) {
      return (
        <div className="text-[10px] font-mono text-destructive pl-3">
          ✗ error: {d.error} [{d.durationMs}ms]
        </div>
      );
    }
    const preview = d.output.slice(0, 120).replace(/\n/g, " ↵ ");
    return (
      <div className="text-[10px] font-mono text-muted-foreground pl-3">
        ✓ {preview}{d.output.length > 120 ? "…" : ""} [{d.durationMs}ms]
      </div>
    );
  }
  return null;
}

function SessionRow({ session, onDelete }: { session: AgentSession; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(false);

  const toolCallCount = session.events.filter((e) => e.data.type === "tool_call").length;
  const errorCount = session.events.filter(
    (e) => e.data.type === "tool_result" && (e.data as { error?: string }).error
  ).length;
  const dur = session.endTime
    ? `${Math.round((session.endTime - session.startTime) / 1000)}s`
    : "running";

  function copyAnalysis() {
    const text = formatSessionForAnalysis(session);
    void navigator.clipboard.writeText(text);
    toast.success("Analysis prompt copied — paste into Claude");
  }

  function downloadAnalysis() {
    const text = formatSessionForAnalysis(session);
    const blob = new Blob([text], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `agent-session-${session.id.slice(0, 8)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        className="w-full flex items-start gap-2 px-4 py-3 hover:bg-muted/30 transition-colors text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="mt-0.5 text-muted-foreground shrink-0">
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-foreground truncate">{session.prompt}</p>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="text-[10px] text-muted-foreground">{relativeTime(session.startTime)}</span>
            <span className="text-[10px] text-muted-foreground">{session.model.split("::").pop()}</span>
            <span className="text-[10px] text-muted-foreground">{dur}</span>
            <span className="text-[10px] text-muted-foreground">{toolCallCount} tool{toolCallCount !== 1 ? "s" : ""}</span>
            {errorCount > 0 && (
              <span className="text-[10px] text-destructive">{errorCount} error{errorCount !== 1 ? "s" : ""}</span>
            )}
            {session.workspace && (
              <span className="text-[10px] text-muted-foreground">📁 {session.workspace}</span>
            )}
            <span className={`text-[10px] font-medium ${session.completed ? "text-success" : "text-warning"}`}>
              {session.completed ? "✓ done" : "◌ incomplete"}
            </span>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-0.5 border-t bg-muted/10">
          <div className="flex items-center gap-2 py-2">
            <Button size="sm" variant="outline" className="h-6 text-[10px] gap-1" onClick={copyAnalysis}>
              <Copy className="size-2.5" /> Copy analysis prompt
            </Button>
            <Button size="sm" variant="outline" className="h-6 text-[10px] gap-1" onClick={downloadAnalysis}>
              <Download className="size-2.5" /> Download .md
            </Button>
            <button
              type="button"
              className="ml-auto text-muted-foreground hover:text-destructive transition-colors"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
          <div className="space-y-0.5 max-h-72 overflow-y-auto py-1">
            {session.events.map((ev, i) => (
              <EventLine key={i} ev={ev} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function outcomeBadge(outcome: SessionResult["outcome"]): { label: string; className: string } {
  switch (outcome) {
    case "completed": return { label: "✓ done", className: "text-success" };
    case "error": return { label: "✗ failed", className: "text-destructive" };
    case "aborted": return { label: "aborted", className: "text-muted-foreground" };
    case "hit_round_limit": return { label: "round limit", className: "text-warning" };
  }
}

/**
 * Unattended runs (scheduler / task-queue / subagents) go through
 * runHeadlessTask and record into useSessionResultsStore — a completely
 * different path from the interactive Code-tab sessions above (which log via
 * agentLogger.ts). There was previously NO way to see what one of these runs
 * actually did: the toast is a one-line, auto-dismissing summary. This is the
 * only place to see the real per-tool-call steps and the real timestamp a
 * scheduled job fired, e.g. to check it's actually firing on the interval you
 * expect rather than guessing from the schedule's "next run" display.
 */
function UnattendedRunRow({ result }: { result: SessionResult }) {
  const [expanded, setExpanded] = useState(false);
  const badge = outcomeBadge(result.outcome);
  const durSecs = Math.round((result.finishedAt - result.startedAt) / 1000);

  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        className="w-full flex items-start gap-2 px-4 py-3 hover:bg-muted/30 transition-colors text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="mt-0.5 text-muted-foreground shrink-0">
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-foreground truncate">{result.task}</p>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="text-[10px] text-muted-foreground font-mono">{result.origin}</span>
            <span className="text-[10px] text-muted-foreground" title={new Date(result.startedAt).toString()}>
              {new Date(result.startedAt).toLocaleString()}
            </span>
            <span className="text-[10px] text-muted-foreground">{durSecs}s · {result.roundsUsed} round{result.roundsUsed !== 1 ? "s" : ""}</span>
            <span className={`text-[10px] font-medium ${badge.className}`}>{badge.label}</span>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-1 border-t bg-muted/10">
          <p className="text-[10px] text-muted-foreground pt-2">{result.summary}</p>
          {result.steps.length > 0 && (
            <div className="space-y-0.5 max-h-72 overflow-y-auto py-1">
              {result.steps.map((s, i) => (
                <div key={i} className="text-[10px] font-mono text-foreground/80 pl-1">▶ {s}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function UnattendedRunsSection() {
  const { results, clear } = useSessionResultsStore();
  const setView = useAppViewStore((s) => s.setView);
  const sorted = [...results].sort((a, b) => b.startedAt - a.startedAt);

  return (
    <div className="border-b shrink-0">
      <div className="px-4 py-2 flex items-center gap-2 bg-muted/20 border-b">
        <Clock className="size-3.5 text-muted-foreground" />
        <h3 className="text-xs font-medium">Unattended runs</h3>
        <span className="text-[10px] text-muted-foreground">{sorted.length} (scheduler / task queue / subagents)</span>
        <button
          type="button"
          onClick={() => setView("agents")}
          className="text-[10px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline transition-colors"
        >
          Spawn a subagent →
        </button>
        {sorted.length > 0 && (
          <Button size="sm" variant="outline" className="ml-auto h-6 text-[10px] text-destructive hover:bg-destructive/10" onClick={clear}>
            Clear
          </Button>
        )}
      </div>
      {sorted.length === 0 ? (
        <p className="text-[11px] text-muted-foreground px-4 py-3">No scheduled/queued/subagent runs yet.</p>
      ) : (
        <div className="max-h-64 overflow-y-auto divide-y">
          {sorted.map((r) => <UnattendedRunRow key={r.id} result={r} />)}
        </div>
      )}
    </div>
  );
}

export function AgentLogs() {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setSessions(await getAllSessions());
    setLoading(false);
  }

  useEffect(() => { void load(); }, []);

  async function handleDelete(id: string) {
    await deleteSession(id);
    setSessions((s) => s.filter((x) => x.id !== id));
  }

  async function handleDeleteAll() {
    for (const s of sessions) await deleteSession(s.id);
    setSessions([]);
  }

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="border-b bg-card px-4 py-3 flex items-center gap-3 shrink-0">
        <ScrollText className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Agent Logs</h2>
        <span className="text-xs text-muted-foreground">{sessions.length} session{sessions.length !== 1 ? "s" : ""}</span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void load()}>
            Refresh
          </Button>
          {sessions.length > 0 && (
            <Button size="sm" variant="outline" className="h-7 text-xs text-destructive hover:bg-destructive/10" onClick={() => void handleDeleteAll()}>
              Clear all
            </Button>
          )}
        </div>
      </div>

      <UnattendedRunsSection />

      <div className="border-b bg-muted/20 px-4 py-2 shrink-0">
        <p className="text-xs text-muted-foreground">
          Every coding agent session is logged here. Click a session to expand it, then use{" "}
          <strong>Copy analysis prompt</strong> to get a structured prompt you can paste into Claude
          to find weaknesses and improve the agent's behavior.
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <p className="text-xs text-muted-foreground p-4">Loading…</p>
        ) : sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-8">
            <ScrollText className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No sessions yet</p>
            <p className="text-xs text-muted-foreground">
              Sessions are recorded automatically every time you use the Code Editor agent.
            </p>
          </div>
        ) : (
          <div className="divide-y">
            {sessions.map((s) => (
              <SessionRow key={s.id} session={s} onDelete={() => void handleDelete(s.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
