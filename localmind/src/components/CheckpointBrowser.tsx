import { useState, useEffect } from "react";
import { History, RotateCcw, ChevronDown, ChevronUp, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { listShadowHistory, showShadowFileAt, restoreShadowFile } from "../lib/shadowGit";
import type { ShadowCommitInfo } from "../lib/shadowGit";

interface Checkpoint {
  oid: string;
  message: string;
  displayTime: string;
}

interface Props {
  workspacePath: string | null;
  currentPath: string;
  onRestore: (content: string) => void;
}

function toCheckpoint(commit: ShadowCommitInfo): Checkpoint {
  return {
    oid: commit.oid,
    message: commit.message,
    displayTime: new Date(commit.timestamp * 1000).toLocaleString(undefined, {
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }),
  };
}

/** Every shadow-git commit that touched `currentPath`, newest first. */
async function listCheckpoints(workspacePath: string, currentPath: string): Promise<Checkpoint[]> {
  try {
    const commits = await listShadowHistory(workspacePath, currentPath, 50);
    return commits.map(toCheckpoint);
  } catch {
    return [];
  }
}

export function CheckpointBrowser({ workspacePath, currentPath, onRestore }: Props) {
  const [open, setOpen] = useState(false);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState<{ cp: Checkpoint; content: string } | null>(null);

  useEffect(() => {
    if (!open || !workspacePath || !currentPath) {
      setCheckpoints([]);
      return;
    }
    setLoading(true);
    listCheckpoints(workspacePath, currentPath)
      .then(setCheckpoints)
      .catch(() => setCheckpoints([]))
      .finally(() => setLoading(false));
  }, [open, workspacePath, currentPath]);

  async function handlePreview(cp: Checkpoint) {
    if (!workspacePath) return;
    try {
      const content = await showShadowFileAt(workspacePath, cp.oid, currentPath);
      setPreviewing({ cp, content });
    } catch (err) {
      toast.error(`Cannot read checkpoint: ${(err as Error).message}`);
    }
  }

  async function handleRestore() {
    if (!previewing || !workspacePath) return;
    try {
      await restoreShadowFile(workspacePath, previewing.cp.oid, currentPath);
      onRestore(previewing.content);
      setPreviewing(null);
      setOpen(false);
      toast.success("Checkpoint restored to disk and reloaded in the editor");
    } catch (err) {
      toast.error(`Restore failed: ${(err as Error).message}`);
    }
  }

  if (!currentPath) return null;

  return (
    <div className="border-t shrink-0">
      {/* Toggle bar */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 h-8 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors"
      >
        <History className="size-3" />
        <span>Checkpoints</span>
        {checkpoints.length > 0 && !loading && (
          <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground border">
            {checkpoints.length}
          </span>
        )}
        <span className="ml-auto">
          {open ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
        </span>
      </button>

      {open && (
        <div className="bg-card border-t" style={{ maxHeight: 280 }}>
          {loading ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
          ) : checkpoints.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No checkpoint history for this file yet — every agent-made change (from any tab) is auto-committed here.
            </p>
          ) : (
            <div className="overflow-y-auto" style={{ maxHeight: 240 }}>
              {checkpoints.map((cp) => (
                <div
                  key={cp.oid}
                  className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/50 border-b text-xs"
                >
                  <div className="flex-1 min-w-0">
                    <p className="tabular-nums text-muted-foreground">{cp.displayTime}</p>
                    <p className="text-[10px] text-muted-foreground/70 truncate" title={cp.message}>{cp.message}</p>
                  </div>
                  <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2 shrink-0"
                    onClick={() => void handlePreview(cp)}>
                    Preview
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Preview pane */}
          {previewing && (
            <div className="border-t bg-muted text-foreground">
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border">
                <span className="text-[10px] text-muted-foreground flex-1 truncate">
                  Checkpoint: {previewing.cp.displayTime}
                </span>
                <Button size="sm" className="h-6 text-[10px] px-2 gap-1 bg-success hover:bg-success/90 text-success-foreground border-0"
                  onClick={() => void handleRestore()}>
                  <RotateCcw className="size-2.5" /> Restore
                </Button>
                <button onClick={() => setPreviewing(null)} className="text-muted-foreground hover:text-foreground">
                  <X className="size-3" />
                </button>
              </div>
              <pre className="px-3 py-2 text-[10px] font-mono overflow-y-auto whitespace-pre-wrap"
                style={{ maxHeight: 160 }}>
                {previewing.content.slice(0, 3000)}
                {previewing.content.length > 3000 ? "\n…(truncated)" : ""}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
