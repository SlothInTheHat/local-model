import { useEffect, useState } from "react";
import { History as HistoryIcon, ChevronDown, ChevronRight, RotateCcw, FileText } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { useAgentStore } from "../store/agent";
import {
  listShadowHistory, diffShadowCommit, restoreShadowFile, restoreShadowWorkspace,
} from "../lib/shadowGit";
import type { ShadowCommitInfo } from "../lib/shadowGit";

/** Parses the "[localmind:{surface}] rest of message" convention shadow-git commits use. */
function parseSurface(message: string): { surface: string | null; rest: string } {
  const m = /^\[localmind:([a-z0-9_-]+)\]\s*(.*)$/i.exec(message);
  return m ? { surface: m[1], rest: m[2] } : { surface: null, rest: message };
}

// Categorical per-surface labels (not a status), so these stay literal
// palette colors rather than the success/warning/info/destructive semantic
// tokens — but each needs a dark: pairing since index.css's dark palette
// doesn't cover raw Tailwind colors.
const SURFACE_COLOR: Record<string, string> = {
  chat: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800",
  code: "bg-green-50 text-green-700 border-green-200 dark:bg-green-950 dark:text-green-300 dark:border-green-800",
  scheduler: "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950 dark:text-purple-300 dark:border-purple-800",
  "task-queue": "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-300 dark:border-orange-800",
  subagent: "bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950 dark:text-teal-300 dark:border-teal-800",
  workflow: "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:border-indigo-800",
  manual: "bg-muted text-muted-foreground border-border",
};

function CommitCard({ commit, workspacePath, onRestored }: {
  commit: ShadowCommitInfo;
  workspacePath: string;
  onRestored: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  const [restoringAll, setRestoringAll] = useState(false);
  const { surface, rest } = parseSurface(commit.message);
  const badgeClass = (surface && SURFACE_COLOR[surface]) ?? SURFACE_COLOR.manual;

  async function toggleDiff(path: string) {
    if (diffs[path] !== undefined) {
      setDiffs((prev) => { const next = { ...prev }; delete next[path]; return next; });
      return;
    }
    try {
      const diff = await diffShadowCommit(workspacePath, commit.oid, path);
      setDiffs((prev) => ({ ...prev, [path]: diff || "(no textual diff — binary or unchanged)" }));
    } catch (err) {
      toast.error(`Failed to load diff: ${(err as Error).message}`);
    }
  }

  async function handleRestoreFile(path: string) {
    if (!window.confirm(`Restore "${path}" to its state at this commit? Current content will be overwritten.`)) return;
    try {
      await restoreShadowFile(workspacePath, commit.oid, path);
      toast.success(`Restored ${path}`);
      onRestored();
    } catch (err) {
      toast.error(`Restore failed: ${(err as Error).message}`);
    }
  }

  async function handleRestoreAll() {
    if (!window.confirm(
      `Restore the ENTIRE workspace to this point (${commit.files_changed.length >= 1 ? "all tracked files" : "no changes"})? This overwrites every tracked file with its content at this commit — new files created after this point are left alone.`,
    )) return;
    setRestoringAll(true);
    try {
      const restored = await restoreShadowWorkspace(workspacePath, commit.oid);
      toast.success(`Restored ${restored.length} file${restored.length !== 1 ? "s" : ""} to this point`);
      onRestored();
    } catch (err) {
      toast.error(`Restore failed: ${(err as Error).message}`);
    } finally {
      setRestoringAll(false);
    }
  }

  return (
    <div className="border rounded-lg bg-card overflow-hidden">
      <div className="p-3 flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full border font-medium ${badgeClass}`}>
              {surface ?? "manual"}
            </span>
            <span className="text-xs text-muted-foreground">
              {new Date(commit.timestamp * 1000).toLocaleString()}
            </span>
            <span className="text-[10px] text-muted-foreground/70 font-mono">{commit.oid.slice(0, 8)}</span>
          </div>
          <p className="text-sm mt-1 truncate" title={rest}>{rest || "(no message)"}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            onClick={() => void handleRestoreAll()}
            disabled={restoringAll}
            title="Restore every tracked file to its state at this commit"
          >
            <RotateCcw className="size-3" /> {restoringAll ? "Restoring…" : "Restore all"}
          </Button>
        </div>
      </div>
      {commit.files_changed.length > 0 && (
        <div className="border-t">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="w-full flex items-center gap-1 px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-muted/50"
          >
            {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {commit.files_changed.length} file{commit.files_changed.length !== 1 ? "s" : ""} changed
          </button>
          {expanded && (
            <div className="px-3 pb-2 space-y-1.5">
              {commit.files_changed.map((path) => (
                <div key={path} className="text-[11px]">
                  <div className="flex items-center gap-1.5 py-1">
                    <FileText className="size-3 text-muted-foreground shrink-0" />
                    <span className="flex-1 min-w-0 truncate font-mono" title={path}>{path}</span>
                    <button
                      onClick={() => void toggleDiff(path)}
                      className="text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted shrink-0"
                    >
                      {diffs[path] !== undefined ? "Hide diff" : "Diff"}
                    </button>
                    <button
                      onClick={() => void handleRestoreFile(path)}
                      className="text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted shrink-0"
                    >
                      Restore
                    </button>
                  </div>
                  {diffs[path] !== undefined && (
                    <pre className="bg-muted text-foreground rounded p-2 overflow-x-auto whitespace-pre text-[10px] font-mono max-h-64 overflow-y-auto">
                      {diffs[path]}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function HistoryView() {
  const workspacePath = useAgentStore((s) => s.workspacePath);
  const [commits, setCommits] = useState<ShadowCommitInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!workspacePath) {
      setCommits([]);
      return;
    }
    setLoading(true);
    listShadowHistory(workspacePath, undefined, 100)
      .then(setCommits)
      .catch(() => setCommits([]))
      .finally(() => setLoading(false));
  }, [workspacePath, reloadTick]);

  return (
    <div className="h-full w-full overflow-y-auto p-4">
      <div className="max-w-2xl mx-auto space-y-3">
        <div className="flex items-center gap-2 mb-2">
          <HistoryIcon className="size-4 text-primary" />
          <span className="text-sm font-semibold">History</span>
          <span className="text-xs text-muted-foreground">
            — every agent-made change, from any tab, auto-committed here
          </span>
        </div>
        {!workspacePath ? (
          <div className="flex flex-col items-center justify-center text-center p-8 space-y-2 border rounded-lg bg-card mt-8">
            <p className="text-sm text-muted-foreground">Open a workspace to see its change history.</p>
          </div>
        ) : loading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : commits.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center p-8 space-y-4 border rounded-lg bg-card mt-8">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
              <HistoryIcon className="size-8 text-primary/60" />
            </div>
            <div>
              <p className="text-base font-medium">No history yet</p>
              <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                As soon as the agent writes, patches, or runs something in this workspace — from chat, the Code
                tab, a scheduled job, or a workflow — it shows up here, ready to inspect or restore.
              </p>
            </div>
          </div>
        ) : (
          commits.map((c) => (
            <CommitCard
              key={c.oid}
              commit={c}
              workspacePath={workspacePath}
              onRestored={() => setReloadTick((t) => t + 1)}
            />
          ))
        )}
      </div>
    </div>
  );
}
