import { FolderOpen, FolderX, ChevronRight, History } from "lucide-react";
import { toast } from "sonner";
import { cn } from "./ui/utils";
import { openWorkspace, openWorkspaceByPath, isTauriEnv } from "../lib/fileSystem";
import { useAgentStore } from "../store/agent";
import { useWorkspacesStore } from "../store/workspaces";

export function WorkspaceSelector() {
  const { workspaceName, workspacePath, setWorkspace } = useAgentStore();
  const { recent, addRecent, removeRecent } = useWorkspacesStore();

  async function handleOpen() {
    try {
      const ws = await openWorkspace();
      setWorkspace(ws.handle, ws.path, ws.name);
      if (ws.path) addRecent(ws.path, ws.name);
      toast.success(`Workspace: ${ws.name}`);
    } catch (err) {
      const e = err as Error;
      if (e.name !== "AbortError") toast.error(`Could not open folder: ${e.message}`);
    }
  }

  async function handleSwitch(path: string) {
    try {
      const ws = await openWorkspaceByPath(path);
      setWorkspace(ws.handle, ws.path, ws.name);
      addRecent(path, ws.name);
      toast.success(`Switched to ${ws.name}`);
    } catch (err) {
      const e = err as Error;
      toast.error(`Could not open folder: ${e.message}`);
      removeRecent(path);
    }
  }

  function handleClose() {
    setWorkspace(null, null, null);
    toast.info("Workspace closed");
  }

  const otherRecent = recent.filter((w) => w.path !== workspacePath).slice(0, 5);
  const showRecent = isTauriEnv() && otherRecent.length > 0;

  if (!workspaceName) {
    return (
      <div className="space-y-1.5">
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
        {showRecent && (
          <div className="space-y-0.5">
            <div className="flex items-center gap-1 px-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              <History className="size-3" />
              Recent projects
            </div>
            {otherRecent.map((w) => (
              <button
                key={w.path}
                type="button"
                onClick={() => void handleSwitch(w.path)}
                className="w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-left hover:bg-accent/50 transition-colors group"
                title={w.path}
              >
                <FolderOpen className="size-3 text-muted-foreground group-hover:text-primary shrink-0" />
                <span className="text-xs text-foreground truncate flex-1">{w.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
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
          <p className="text-[10px] text-warning">
            Browser mode — terminal sandbox inactive
          </p>
        )}
      </div>

      {showRecent && (
        <div className="space-y-0.5">
          <div className="flex items-center gap-1 px-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
            <History className="size-3" />
            Recent projects
          </div>
          {otherRecent.map((w) => (
            <button
              key={w.path}
              type="button"
              onClick={() => void handleSwitch(w.path)}
              className="w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-left hover:bg-accent/50 transition-colors group"
              title={w.path}
            >
              <FolderOpen className="size-3 text-muted-foreground group-hover:text-primary shrink-0" />
              <span className="text-xs text-foreground truncate flex-1">{w.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
