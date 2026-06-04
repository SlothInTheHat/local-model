import { useState, useEffect } from "react";
import { History, RotateCcw, ChevronDown, ChevronUp, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";

interface Checkpoint {
  path: string;       // full relative path inside .localmind-backups/
  filename: string;   // original file path reconstructed
  timestamp: string;  // ISO-ish from the directory name
  displayTime: string;
}

interface Props {
  dirHandle: FileSystemDirectoryHandle | null;
  currentPath: string;
  onRestore: (content: string) => void;
}

async function listCheckpoints(
  dirHandle: FileSystemDirectoryHandle,
  currentPath: string,
): Promise<Checkpoint[]> {
  const results: Checkpoint[] = [];
  try {
    const backupsDir = await dirHandle.getDirectoryHandle(".localmind-backups", { create: false });
    for await (const [tsFolder, tsEntry] of backupsDir.entries()) {
      if (tsEntry.kind !== "directory") continue;
      const tsHandle = tsEntry as FileSystemDirectoryHandle;
      // Each timestamp folder mirrors the workspace structure
      try {
        await getNestedFile(tsHandle, currentPath);
        // If the file exists under this timestamp, record it
        const displayTime = formatTimestamp(tsFolder);
        results.push({
          path: `.localmind-backups/${tsFolder}/${currentPath}`,
          filename: currentPath,
          timestamp: tsFolder,
          displayTime,
        });
      } catch {
        // file not in this checkpoint
      }
    }
  } catch {
    // .localmind-backups doesn't exist
  }
  // Newest first
  return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

async function getNestedFile(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemFileHandle> {
  const parts = path.split("/").filter(Boolean);
  const fileName = parts.pop()!;
  let cur: FileSystemDirectoryHandle = root;
  for (const part of parts) {
    cur = await cur.getDirectoryHandle(part, { create: false });
  }
  return cur.getFileHandle(fileName, { create: false });
}

function formatTimestamp(raw: string): string {
  // raw looks like "2026-06-01T14-30-22_abc4"
  try {
    const iso = raw.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3").split("_")[0];
    return new Date(iso).toLocaleString(undefined, {
      month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch {
    return raw.slice(0, 19).replace("T", " ");
  }
}

export function CheckpointBrowser({ dirHandle, currentPath, onRestore }: Props) {
  const [open, setOpen] = useState(false);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState<{ cp: Checkpoint; content: string } | null>(null);

  useEffect(() => {
    if (!open || !dirHandle || !currentPath) {
      setCheckpoints([]);
      return;
    }
    setLoading(true);
    listCheckpoints(dirHandle, currentPath)
      .then(setCheckpoints)
      .catch(() => setCheckpoints([]))
      .finally(() => setLoading(false));
  }, [open, dirHandle, currentPath]);

  async function handlePreview(cp: Checkpoint) {
    if (!dirHandle) return;
    try {
      const parts = cp.path.split("/").filter(Boolean);
      const fileName = parts.pop()!;
      let cur: FileSystemDirectoryHandle = dirHandle;
      for (const part of parts) {
        cur = await cur.getDirectoryHandle(part, { create: false });
      }
      const fh = await cur.getFileHandle(fileName, { create: false });
      const file = await fh.getFile();
      const content = await file.text();
      setPreviewing({ cp, content });
    } catch (err) {
      toast.error(`Cannot read checkpoint: ${(err as Error).message}`);
    }
  }

  function handleRestore() {
    if (!previewing) return;
    onRestore(previewing.content);
    setPreviewing(null);
    setOpen(false);
    toast.success("Checkpoint restored — save the file to persist changes");
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
              No checkpoints for this file yet. The agent auto-backs up files before writing them.
            </p>
          ) : (
            <div className="overflow-y-auto" style={{ maxHeight: 240 }}>
              {checkpoints.map((cp) => (
                <div
                  key={cp.timestamp}
                  className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/50 border-b text-xs"
                >
                  <span className="flex-1 tabular-nums text-muted-foreground">{cp.displayTime}</span>
                  <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2"
                    onClick={() => void handlePreview(cp)}>
                    Preview
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Preview pane */}
          {previewing && (
            <div className="border-t bg-zinc-950 text-zinc-100">
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-700">
                <span className="text-[10px] text-zinc-400 flex-1 truncate">
                  Checkpoint: {previewing.cp.displayTime}
                </span>
                <Button size="sm" className="h-6 text-[10px] px-2 gap-1 bg-green-600 hover:bg-green-700 text-white border-0"
                  onClick={handleRestore}>
                  <RotateCcw className="size-2.5" /> Restore
                </Button>
                <button onClick={() => setPreviewing(null)} className="text-zinc-400 hover:text-zinc-100">
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
