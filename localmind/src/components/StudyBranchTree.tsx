import { ChevronRight } from "lucide-react";
import { cn } from "./ui/utils";
import type { StudyBranch } from "../store/study";

interface Props {
  branches: StudyBranch[];
  activeBranchId: string;
  onSelect: (branchId: string) => void;
  rootId: string;
}

export function StudyBranchTree({ branches, activeBranchId, onSelect, rootId }: Props) {
  return (
    <div className="p-2">
      <TreeNode
        branchId={rootId}
        branches={branches}
        activeBranchId={activeBranchId}
        onSelect={onSelect}
        depth={0}
      />
    </div>
  );
}

function TreeNode({
  branchId,
  branches,
  activeBranchId,
  onSelect,
  depth,
}: {
  branchId: string;
  branches: StudyBranch[];
  activeBranchId: string;
  onSelect: (id: string) => void;
  depth: number;
}) {
  const branch = branches.find((b) => b.id === branchId);
  if (!branch) return null;

  const children = branches.filter((b) => b.parentBranchId === branchId);
  const isActive = branchId === activeBranchId;

  return (
    <div>
      <button
        onClick={() => onSelect(branchId)}
        className={cn(
          "w-full text-left flex items-center gap-1 px-2 py-1.5 rounded-md text-xs transition-colors",
          isActive
            ? "bg-primary/10 text-primary font-medium"
            : "text-foreground/70 hover:bg-accent hover:text-foreground"
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {children.length > 0 && <ChevronRight className="size-3 shrink-0" />}
        {children.length === 0 && <span className="size-3 shrink-0" />}
        <span className="truncate">{branch.topic}</span>
        {branch.messages.length > 0 && (
          <span className="ml-auto text-[10px] text-muted-foreground shrink-0">
            {branch.messages.filter((m) => m.role === "user").length}
          </span>
        )}
      </button>
      {children.map((child) => (
        <TreeNode
          key={child.id}
          branchId={child.id}
          branches={branches}
          activeBranchId={activeBranchId}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}
