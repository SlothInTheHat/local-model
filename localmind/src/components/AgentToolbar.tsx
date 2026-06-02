import { FolderOpen, Pencil, Trash2, List, Calculator, Globe, TerminalSquare, Info } from "lucide-react";
import { cn } from "./ui/utils";
import type { ToolName } from "../lib/tools";

interface Props {
  enabled: Record<ToolName, boolean>;
  onToggle: (name: ToolName) => void;
  dirHandle: FileSystemDirectoryHandle | null;
  onOpenDir: () => void;
}

interface ToolButton {
  name: ToolName;
  label: string;
  icon: React.ReactNode;
}

export function AgentToolbar({ enabled, onToggle, dirHandle, onOpenDir }: Props) {
  const tools: ToolButton[] = [
    { name: "read_file", label: "Read File", icon: <FolderOpen className="size-3.5" /> },
    { name: "write_file", label: "Write File", icon: <Pencil className="size-3.5" /> },
    { name: "delete_file", label: "Delete File", icon: <Trash2 className="size-3.5" /> },
    { name: "list_directory", label: "List Dir", icon: <List className="size-3.5" /> },
    { name: "calculator", label: "Calc", icon: <Calculator className="size-3.5" /> },
    { name: "web_search", label: "Search", icon: <Globe className="size-3.5" /> },
    { name: "run_command", label: "Terminal", icon: <TerminalSquare className="size-3.5" /> },
    { name: "get_system_info", label: "Sys Info", icon: <Info className="size-3.5" /> },
  ];

  const dirName = dirHandle?.name ?? null;

  return (
    <div className="flex items-center gap-1 px-4 py-1.5 border-b bg-muted/40 flex-wrap">
      <span className="text-xs text-muted-foreground mr-1 shrink-0">Tools:</span>

      {tools.map((t) => (
        <button
          key={t.name}
          type="button"
          onClick={() => onToggle(t.name)}
          title={`${enabled[t.name] ? "Disable" : "Enable"} ${t.label}`}
          className={cn(
            "flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors",
            enabled[t.name]
              ? "bg-primary text-primary-foreground"
              : "bg-background text-muted-foreground border border-border hover:text-foreground"
          )}
        >
          {t.icon}
          {t.label}
        </button>
      ))}

      <div className="ml-auto">
        <button
          type="button"
          onClick={onOpenDir}
          title={dirName ? `Workspace: ${dirName}` : "Open workspace folder"}
          className={cn(
            "flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors border",
            dirName
              ? "bg-primary/10 text-primary border-primary/30"
              : "bg-background text-muted-foreground border-border hover:text-foreground"
          )}
        >
          <FolderOpen className="size-3.5" />
          {dirName ?? "Open folder"}
        </button>
      </div>
    </div>
  );
}
