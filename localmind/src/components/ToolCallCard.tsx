import { FolderOpen, Calculator, Globe, Pencil, List, Search, FileSearch, TerminalSquare, Info, Trash2, GitBranch, Plug } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { cn } from "./ui/utils";
import type { ToolCall } from "../lib/tools";

interface Props {
  call: ToolCall;
  onApprove: () => void;
  onDeny: () => void;
}

function ToolIcon({ name, className }: { name: string; className?: string }) {
  const cls = cn("size-4 shrink-0", className);
  if (name.includes("__")) return <Plug className={cls} />;
  switch (name) {
    case "read_file": return <FolderOpen className={cls} />;
    case "write_file": return <Pencil className={cls} />;
    case "delete_file": return <Trash2 className={cls} />;
    case "list_directory": return <List className={cls} />;
    case "grep_files": return <Search className={cls} />;
    case "find_files": return <FileSearch className={cls} />;
    case "calculator": return <Calculator className={cls} />;
    case "web_search": return <Globe className={cls} />;
    case "run_command": return <TerminalSquare className={cls} />;
    case "get_system_info": return <Info className={cls} />;
    case "git_status":
    case "git_diff":
    case "git_log":
    case "git_add":
    case "git_commit": return <GitBranch className={cls} />;
    default: return <Plug className={cls} />;
  }
}

const TOOL_LABELS: Record<string, string> = {
  read_file: "Read File",
  write_file: "Write File",
  delete_file: "Delete File",
  list_directory: "List Directory",
  grep_files: "Grep Files",
  find_files: "Find Files",
  calculator: "Calculator",
  web_search: "Web Search",
  run_command: "Run Command",
  get_system_info: "Get System Info",
  git_status: "Git Status",
  git_diff: "Git Diff",
  git_log: "Git Log",
  git_add: "Git Add",
  git_commit: "Git Commit",
};

export function ToolCallCard({ call, onApprove, onDeny }: Props) {
  const label = TOOL_LABELS[call.name] ?? call.name.replace(/__/g, " › ");

  return (
    <Card className="border-amber-200 bg-amber-50/50">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center gap-2">
          <div className="size-6 rounded bg-amber-100 flex items-center justify-center shrink-0">
            <ToolIcon name={call.name} className="size-3.5 text-amber-700" />
          </div>
          <span className="text-sm font-medium text-foreground">{label}</span>
          <span className="text-xs text-muted-foreground font-mono ml-auto truncate max-w-[120px]">
            {call.id.slice(0, 8)}
          </span>
        </div>

        <pre className="text-xs bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-muted-foreground">
          {JSON.stringify(call.args, null, 2)}
        </pre>

        <div className="flex gap-2">
          <Button size="sm" className="flex-1 bg-green-600 hover:bg-green-700 text-white" onClick={onApprove}>
            Approve
          </Button>
          <Button size="sm" variant="outline" className="flex-1 border-destructive text-destructive hover:bg-destructive/10" onClick={onDeny}>
            Deny
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
