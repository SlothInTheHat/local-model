import { FolderOpen, Pencil, Trash2, List, Calculator, Globe, TerminalSquare, Info, GitBranch, Plug } from "lucide-react";
import { cn } from "./ui/utils";
import type { ToolName } from "../lib/tools";
import { useMcpStore } from "../store/mcp";

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
  group?: "git";
}

export function AgentToolbar({ enabled, onToggle, dirHandle, onOpenDir }: Props) {
  const allServers = useMcpStore((s) => s.servers);
  const mcpServers = allServers.filter((sv) => sv.enabled && sv.status === "connected");

  const tools: ToolButton[] = [
    { name: "read_file", label: "Read", icon: <FolderOpen className="size-3.5" /> },
    { name: "write_file", label: "Write", icon: <Pencil className="size-3.5" /> },
    { name: "delete_file", label: "Delete", icon: <Trash2 className="size-3.5" /> },
    { name: "list_directory", label: "List", icon: <List className="size-3.5" /> },
    { name: "calculator", label: "Calc", icon: <Calculator className="size-3.5" /> },
    { name: "web_search", label: "Search", icon: <Globe className="size-3.5" /> },
    { name: "run_command", label: "Shell", icon: <TerminalSquare className="size-3.5" /> },
    { name: "get_system_info", label: "Sys", icon: <Info className="size-3.5" /> },
    // Git tools (grouped)
    { name: "git_status", label: "git status", icon: <GitBranch className="size-3.5" />, group: "git" },
    { name: "git_diff", label: "git diff", icon: <GitBranch className="size-3.5" />, group: "git" },
    { name: "git_log", label: "git log", icon: <GitBranch className="size-3.5" />, group: "git" },
    { name: "git_add", label: "git add", icon: <GitBranch className="size-3.5" />, group: "git" },
    { name: "git_commit", label: "git commit", icon: <GitBranch className="size-3.5" />, group: "git" },
  ];

  const coreTools = tools.filter((t) => !t.group);
  const gitTools = tools.filter((t) => t.group === "git");

  const dirName = dirHandle?.name ?? null;

  return (
    <div className="flex items-center gap-1 px-4 py-1.5 border-b bg-muted/40 flex-wrap">
      <span className="text-xs text-muted-foreground mr-1 shrink-0">Tools:</span>

      {coreTools.map((t) => (
        <ToolBtn key={t.name} tool={t} enabled={enabled[t.name]} onToggle={onToggle} />
      ))}

      {/* Git group separator */}
      <span className="text-xs text-muted-foreground mx-0.5">|</span>
      {gitTools.map((t) => (
        <ToolBtn key={t.name} tool={t} enabled={enabled[t.name]} onToggle={onToggle} />
      ))}

      {/* Connected MCP server tools */}
      {mcpServers.length > 0 && (
        <>
          <span className="text-xs text-muted-foreground mx-0.5">|</span>
          {mcpServers.map((srv) => (
            <span
              key={srv.id}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-violet-100 text-violet-700 border border-violet-200"
              title={`${srv.tools.length} tools from ${srv.label}`}
            >
              <Plug className="size-3" />
              {srv.label} ({srv.tools.length})
            </span>
          ))}
        </>
      )}

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

function ToolBtn({
  tool,
  enabled,
  onToggle,
}: {
  tool: ToolButton;
  enabled: boolean;
  onToggle: (name: ToolName) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(tool.name)}
      title={`${enabled ? "Disable" : "Enable"} ${tool.name}`}
      className={cn(
        "flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors",
        enabled
          ? "bg-primary text-primary-foreground"
          : "bg-background text-muted-foreground border border-border hover:text-foreground"
      )}
    >
      {tool.icon}
      {tool.label}
    </button>
  );
}
