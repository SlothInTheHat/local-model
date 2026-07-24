import { useEffect, useRef, useState } from "react";
import {
  Workflow as WorkflowIcon, Play, Trash2, ChevronDown, ChevronRight, Clock, CheckCircle2, XCircle, AlertTriangle, X, Plus,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { useWorkflowStore, compileInstruction } from "../store/workflows";
import type { Workflow } from "../store/workflows";
import { useSessionResultsStore } from "../store/sessionResults";
import { useAgentStore } from "../store/agent";
import { describeSchedule } from "../lib/scheduler";
import { runWorkflow, deleteWorkflow } from "../lib/workflowRunner";
import { readFileFromHandle } from "../lib/fileSystem";
import { inlineHtmlResources } from "../lib/htmlPreview";

function outcomeIcon(outcome: Workflow["lastRunOutcome"]) {
  if (outcome === "completed") return <CheckCircle2 className="size-3.5 text-success shrink-0" />;
  if (outcome === "error") return <XCircle className="size-3.5 text-destructive shrink-0" />;
  if (outcome === "aborted" || outcome === "hit_round_limit") return <AlertTriangle className="size-3.5 text-warning shrink-0" />;
  return null;
}

/**
 * Visual, editable breakdown of what a workflow actually does — a numbered
 * flow (box + connecting line per step) rather than a diagramming library,
 * matching this app's existing visual language. Editing a step recompiles
 * `instruction` immediately (compileInstruction, store/workflows.ts), and
 * since workflowRunner.ts's runWorkflow always reads the live Workflow object
 * (both for manual "Run now" and scheduled runs looked up by id), an edit
 * here takes effect on the very next run with no separate re-sync needed.
 */
function StepsEditor({ workflow }: { workflow: Workflow }) {
  const updateWorkflow = useWorkflowStore((s) => s.updateWorkflow);
  // Defensive fallback for workflows persisted before `steps` existed.
  const steps = workflow.steps && workflow.steps.length > 0 ? workflow.steps : [workflow.instruction];
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  function commit(nextSteps: string[]) {
    updateWorkflow(workflow.id, { steps: nextSteps, instruction: compileInstruction(nextSteps) });
  }

  function startEdit(i: number) {
    setEditingIndex(i);
    setDraft(steps[i]);
  }

  function commitEdit(i: number) {
    const trimmed = draft.trim();
    setEditingIndex(null);
    if (!trimmed || trimmed === steps[i]) return;
    commit(steps.map((s, idx) => (idx === i ? trimmed : s)));
  }

  function removeStep(i: number) {
    if (steps.length <= 1) return;
    commit(steps.filter((_, idx) => idx !== i));
  }

  function addStep() {
    const nextSteps = [...steps, "New step"];
    commit(nextSteps);
    setEditingIndex(nextSteps.length - 1);
    setDraft("New step");
  }

  return (
    <div className="space-y-0.5">
      {steps.map((step, i) => (
        <div key={i} className="flex items-start gap-2 group/step">
          <div className="flex flex-col items-center pt-0.5 shrink-0">
            <span className="size-4 rounded-full bg-primary/15 text-primary text-[10px] font-semibold flex items-center justify-center">
              {i + 1}
            </span>
            {i < steps.length - 1 && <span className="w-px flex-1 bg-border" style={{ minHeight: 8 }} />}
          </div>
          <div className="flex-1 min-w-0 pb-1.5">
            {editingIndex === i ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commitEdit(i)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitEdit(i);
                  }
                  if (e.key === "Escape") setEditingIndex(null);
                }}
                className="w-full text-xs px-1.5 py-0.5 rounded border border-ring bg-background text-foreground outline-none focus:ring-1 focus:ring-ring"
              />
            ) : (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => startEdit(i)}
                  className="flex-1 text-left text-xs text-foreground hover:bg-accent rounded px-1.5 py-0.5 -mx-1.5 transition-colors"
                  title="Click to edit this step"
                >
                  {step}
                </button>
                {steps.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeStep(i)}
                    className="opacity-0 group-hover/step:opacity-100 size-4 flex items-center justify-center rounded text-muted-foreground hover:text-destructive shrink-0 transition-opacity"
                    title="Remove step"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={addStep}
        className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1 pl-6"
      >
        <Plus className="size-3" /> Add step
      </button>
    </div>
  );
}

/**
 * Live preview for HTML-output workflows ("applets") — reads outputFile fresh
 * whenever the workflow reruns (keyed off lastRunAt/runCount), inlines local
 * CSS/JS/images via htmlPreview.ts (the same mechanism CodeEditor.tsx's HTML
 * preview uses) so the blob-URL iframe renders standalone, then swaps in a
 * simple sandboxed iframe. No nav-interception script here (unlike
 * CodeEditor.tsx's buildPreviewBlobUrl) — a workflow dashboard is a single
 * self-contained page with no internal links to intercept.
 */
function WorkflowHtmlPreview({ workflow }: { workflow: Workflow }) {
  const { dirHandle, workspacePath } = useAgentStore();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prevUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!dirHandle) {
      setError("No workspace open");
      return;
    }
    (async () => {
      try {
        const raw = await readFileFromHandle(dirHandle, workflow.outputFile);
        const inlined = await inlineHtmlResources(raw, dirHandle, workflow.outputFile, workspacePath);
        if (cancelled) return;
        if (prevUrlRef.current) URL.revokeObjectURL(prevUrlRef.current);
        const url = URL.createObjectURL(new Blob([inlined], { type: "text/html" }));
        prevUrlRef.current = url;
        setBlobUrl(url);
        setError(null);
      } catch {
        if (!cancelled) setError("Hasn't produced output yet — run it once to see the preview here.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirHandle, workspacePath, workflow.outputFile, workflow.lastRunAt, workflow.runCount]);

  useEffect(() => {
    return () => {
      if (prevUrlRef.current) URL.revokeObjectURL(prevUrlRef.current);
    };
  }, []);

  if (error) {
    return <p className="text-[11px] text-muted-foreground italic px-1 py-2">{error}</p>;
  }
  if (!blobUrl) {
    return <p className="text-[11px] text-muted-foreground italic px-1 py-2">Loading preview…</p>;
  }
  return (
    <iframe
      src={blobUrl}
      sandbox="allow-scripts"
      className="w-full h-80 rounded border bg-white"
      title={`${workflow.name} preview`}
    />
  );
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
          <div className="mt-2 mb-1">
            <StepsEditor workflow={workflow} />
          </div>
          <div className="flex items-center gap-1.5 mt-1.5 text-[10px] text-muted-foreground">
            {outcomeIcon(workflow.lastRunOutcome)}
            {workflow.lastRunAt
              ? `Last run: ${new Date(workflow.lastRunAt).toLocaleString()} (${workflow.runCount} total)`
              : "Never run"}
          </div>
          <p className="text-[10px] text-muted-foreground font-mono mt-1 truncate" title={workflow.outputFile}>
            {workflow.outputFile}
          </p>
          {workflow.outputFile.toLowerCase().endsWith(".html") && (
            <div className="mt-2">
              <WorkflowHtmlPreview workflow={workflow} />
            </div>
          )}
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
