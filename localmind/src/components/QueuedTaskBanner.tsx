import { Inbox, X, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { useTaskQueueStore } from "../store/taskQueue";
import type { QueuedTask } from "../store/taskQueue";
import { useSessionResultsStore } from "../store/sessionResults";
import type { AppView } from "../types/app";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";

interface Props {
  view: AppView;
  onStart: (task: string) => void;
}

const STATUS_CARD_CLASS: Record<QueuedTask["status"], string> = {
  pending: "border-blue-200 bg-blue-50/50",
  in_progress: "border-blue-200 bg-blue-50/50",
  running: "border-amber-200 bg-amber-50/50",
  done: "border-green-200 bg-green-50/50",
  error: "border-red-200 bg-red-50/50",
};

const STATUS_LABEL: Record<QueuedTask["status"], string> = {
  pending: "waiting to run",
  in_progress: "running in this tab…",
  running: "running unattended…",
  done: "done",
  error: "failed",
};

function StatusIcon({ status }: { status: QueuedTask["status"] }) {
  if (status === "running" || status === "in_progress") {
    return <Loader2 className="size-4 shrink-0 text-amber-600 animate-spin" />;
  }
  if (status === "done") return <CheckCircle2 className="size-4 shrink-0 text-green-600" />;
  if (status === "error") return <AlertCircle className="size-4 shrink-0 text-red-600" />;
  return <Inbox className="size-4 shrink-0 text-blue-600" />;
}

export function QueuedTaskBanner({ view, onStart }: Props) {
  const allTasks = useTaskQueueStore((s) => s.tasks);
  const deferReason = useTaskQueueStore((s) => s.deferReason);
  const setStatus = useTaskQueueStore((s) => s.setStatus);
  const remove = useTaskQueueStore((s) => s.remove);
  const results = useSessionResultsStore((s) => s.results);

  // "in_progress" is the transient state for the existing interactive
  // Start-button path — it's already visible as the live chat response, so
  // it's excluded here the same way the original banner only showed "pending".
  const tasks = allTasks
    .filter((t) => t.targetView === view && t.status !== "in_progress")
    .sort((a, b) => a.createdAt - b.createdAt);

  if (tasks.length === 0) return null;

  function viewResult(resultId: string | undefined) {
    const record = resultId ? results.find((r) => r.id === resultId) : undefined;
    if (!record) {
      toast.info("No result recorded for this task.");
      return;
    }
    toast(record.outcome === "error" ? "Task result — error" : "Task result", {
      description: record.summary,
      duration: 15000,
    });
  }

  return (
    <div className="space-y-2 px-4 pt-2">
      {tasks.map((t) => (
        <Card key={t.id} className={STATUS_CARD_CLASS[t.status]}>
          <CardContent className="p-3 flex items-center gap-3">
            <StatusIcon status={t.status} />
            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground">
                Queued from {t.sourceView} · {STATUS_LABEL[t.status]}
              </p>
              <p className="text-sm text-foreground truncate">{t.task}</p>
              {/* A pending task used to sit here indefinitely with no hint as
                  to why. The runner now publishes the reason it declined to
                  start (no workspace / model busy); if it's null while a task
                  is still pending, the runner isn't being reached at all,
                  which is itself the most useful thing to say. */}
              {t.status === "pending" && (
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {deferReason ?? "Runner hasn't reported in — press Start to run it here instead."}
                </p>
              )}
            </div>
            {t.status === "pending" && (
              <Button
                size="sm"
                onClick={() => {
                  setStatus(t.id, "in_progress");
                  onStart(t.task);
                }}
              >
                Start
              </Button>
            )}
            {(t.status === "done" || t.status === "error") && (
              <Button size="sm" variant="outline" onClick={() => viewResult(t.resultId)}>
                View result
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => remove(t.id)}>
              <X className="size-4" />
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
