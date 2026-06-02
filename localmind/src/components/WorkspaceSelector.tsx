import { FolderOpen, FolderX, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { cn } from "./ui/utils";
import { openWorkspace } from "../lib/fileSystem";
import { useAgentStore } from "../store/agent";

export function WorkspaceSelector() {
  const { workspaceName, workspacePath, setWorkspace } = useAgentStore();

  async function handleOpen() {
    try {
      const ws = await openWorkspace();
      setWorkspace(ws.handle, ws.path, ws.name);
      toast.success(`Workspace: ${ws.name}`);
    } catch (err) {
      const e = err as Error;
      if (e.name !== "AbortError") toast.error(`Could not open folder: ${e.message}`);
    }
  }

  function handleClose() {
    setWorkspace(null, null, null);
    toast.info("Workspace closed");
  }

  if (!workspaceName) {
    return (
      <button
        type="button"
        onClick={() => void handleOpen()}
        className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg border-2 border-dashed border-border hover:border-primary/50 hover:bg-accent/50 transition-colors group"
      >
        <FolderOpen className="size-4 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
        <div className="text-left min-w-0">
          <div className="text-xs font-medium text-foreground">Open Workspace</div>
          <div className="text-[10px] text-muted-foreground">All tools work within this folder</div>
        </div>
      </button>
    );
  }

  return (
    <div className={cn(
      "rounded-lg border bg-primary/5 border-primary/20 px-3 py-2 space-y-1"
    )}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium text-primary uppercase tracking-wide">Workspace</span>
        <button
          type="button"
          onClick={handleClose}
          title="Close workspace"
          className="text-muted-foreground hover:text-destructive transition-colors"
        >
          <FolderX className="size-3" />
        </button>
      </div>

      <button
        type="button"
        onClick={() => void handleOpen()}
        className="w-full flex items-center gap-1.5 text-left group"
        title={workspacePath ?? workspaceName}
      >
        <FolderOpen className="size-3.5 text-primary shrink-0" />
        <span className="text-xs font-medium text-foreground truncate flex-1">{workspaceName}</span>
        <ChevronRight className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
      </button>

      {workspacePath && (
        <p className="text-[10px] text-muted-foreground truncate" title={workspacePath}>
          {workspacePath}
        </p>
      )}

      {!workspacePath && (
        <p className="text-[10px] text-amber-600">
          Browser mode — terminal sandbox inactive
        </p>
      )}
    </div>
  );
}
