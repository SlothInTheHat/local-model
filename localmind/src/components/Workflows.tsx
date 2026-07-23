import { useState } from "react";
import {
  Workflow as WorkflowIcon, Play, Trash2, ChevronDown, ChevronRight, Clock, CheckCircle2, XCircle, AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { useWorkflowStore } from "../store/workflows";
import type { Workflow } from "../store/workflows";
import { useSessionResultsStore } from "../store/sessionResults";
import { describeSchedule } from "../lib/scheduler";
import { runWorkflow, deleteWorkflow } from "../lib/workflowRunner";

function outcomeIcon(outcome: Workflow["lastRunOutcome"]) {
  if (outcome === "completed") return <CheckCircle2 className="size-3.5 text-success shrink-0" />;
  if (outcome === "error") return <XCircle className="size-3.5 text-destructive shrink-0" />;
  if (outcome === "aborted" || outcome === "hit_round_limit") return <AlertTriangle className="size-3.5 text-warning shrink-0" />;
  return null;
}

function WorkflowCard({ workflow }: { workflow: Workflow }) {
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);
  const results = useSessionResultsStore((s) => s.results)
    .filter((r) => r.workflowId === workflow.id)
    .slice()
    .reverse();

  async function handleRun() {
    setRunning(true);
    try {
      const { record } = await runWorkflow(workflow, { origin: "workflow" });
      if (record.outcome === "completed") {
        toast.success(`"${workflow.name}" finished`);
      } else {
        toast.error(`"${workflow.name}" failed`, { description: record.summary.slice(0, 150) });
      }
    } catch (err) {
      toast.error(`"${workflow.name}" failed`, { description: (err as Error).message });
    } finally {
      setRunning(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete workflow "${workflow.name}"? Its output file will be left in place.`)) return;
    try {
      await deleteWorkflow(workflow.id);
      toast.success(`Deleted "${workflow.name}"`);
    } catch (err) {
      toast.error(`Delete failed: ${(err as Error).message}`);
    }
  }

  return (
    <div className="border rounded-lg bg-card overflow-hidden">
      <div className="p-3 flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold truncate">{workflow.name}</p>
            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
              <Clock className="size-2.5" />
              {workflow.schedule ? describeSchedule(workflow.schedule) : "Manual"}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{workflow.description}</p>
          <div className="flex items-center gap-1.5 mt-1.5 text-[10px] text-muted-foreground">
            {outcomeIcon(workflow.lastRunOutcome)}
            {workflow.lastRunAt
              ? `Last run: ${new Date(workflow.lastRunAt).toLocaleString()} (${workflow.runCount} total)`
              : "Never run"}
          </div>
          <p className="text-[10px] text-muted-foreground font-mono mt-1 truncate" title={workflow.outputFile}>
            {workflow.outputFile}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            onClick={() => void handleRun()}
            disabled={running}
          >
            <Play className="size-3" /> {running ? "Running…" : "Run now"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1 text-destructive border-destructive/30 hover:bg-destructive/10"
            onClick={() => void handleDelete()}
            title="Delete workflow"
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>
      {results.length > 0 && (
        <div className="border-t">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="w-full flex items-center gap-1 px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-muted/50"
          >
            {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            Run history ({results.length})
          </button>
          {expanded && (
            <div className="px-3 pb-2 space-y-1.5">
              {results.slice(0, 10).map((r) => (
                <div key={r.id} className="text-[11px] border rounded p-2 bg-muted/20">
                  <div className="flex items-center gap-1.5">
                    {outcomeIcon(r.outcome)}
                    <span className="font-medium">{r.outcome}</span>
                    <span className="text-muted-foreground">· {new Date(r.startedAt).toLocaleString()}</span>
                  </div>
                  <p className="text-muted-foreground mt-1 line-clamp-2">{r.summary}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function Workflows() {
  const workflows = useWorkflowStore((s) => s.workflows);

  return (
    <div className="h-full w-full overflow-y-auto p-4">
      <div className="max-w-2xl mx-auto space-y-3">
        <div className="flex items-center gap-2 mb-2">
          <WorkflowIcon className="size-4 text-primary" />
          <span className="text-sm font-semibold">Workflows</span>
        </div>
        {workflows.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center p-8 space-y-4 border rounded-lg bg-card mt-8">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
              <WorkflowIcon className="size-8 text-primary/60" />
            </div>
            <div>
              <p className="text-base font-medium">No workflows yet</p>
              <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                Describe what you want automated in chat — e.g. "watch these internship sites and keep a running
                list" — and the agent will save it here as a workflow you can re-run or schedule.
              </p>
            </div>
          </div>
        ) : (
          workflows
            .slice()
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((w) => <WorkflowCard key={w.id} workflow={w} />)
        )}
      </div>
    </div>
  );
}
