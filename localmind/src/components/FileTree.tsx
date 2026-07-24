import { useState, useEffect, useCallback, useRef } from "react";
import {
  ChevronRight, ChevronDown, Folder, FileText, FolderOpen,
  FilePlus, FolderPlus, Pencil, Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "./ui/utils";
import { Button } from "./ui/button";
import {
  listDirectory, writeFileToHandle, deleteEntry, createDirectory,
  readFileFromHandle,
  type FileEntry,
} from "../lib/fileSystem";

interface Props {
  dirHandle: FileSystemDirectoryHandle | null;
  onOpenFile: (handle: FileSystemFileHandle, path: string) => void;
  onOpenDir?: () => void;
  refreshKey?: number;
  onRefresh?: () => void;
  /** Paths the agent has written to — their parent directories auto-expand */
  autoExpandPaths?: ReadonlySet<string>;
}

interface PendingCreate {
  parentPath: string;
  kind: "file" | "directory";
}

/**
 * Writes OS files dragged from outside the app into the given workspace
 * folder (empty targetPath = workspace root). Each dropped File is a Blob,
 * so writeFileToHandle takes it directly — no text/binary detection needed,
 * exact bytes are preserved either way (images, PDFs, etc. work same as .ts/.md).
 */
async function dropFilesInto(
  dirHandle: FileSystemDirectoryHandle,
  targetPath: string,
  dataTransfer: DataTransfer,
  onDone: () => void
): Promise<void> {
  const files = Array.from(dataTransfer.files);
  if (files.length === 0) return;

  let succeeded = 0;
  const failures: string[] = [];
  for (const file of files) {
    const destPath = targetPath ? `${targetPath}/${file.name}` : file.name;
    try {
      await writeFileToHandle(dirHandle, destPath, file);
      succeeded++;
    } catch (err) {
      failures.push(`${file.name}: ${(err as Error).message}`);
    }
  }

  if (succeeded > 0) {
    toast.success(`Added ${succeeded} file${succeeded !== 1 ? "s" : ""}${targetPath ? ` to ${targetPath}` : ""}`);
  }
  if (failures.length > 0) {
    toast.error(`Failed to add ${failures.length} file${failures.length !== 1 ? "s" : ""}: ${failures.join("; ")}`);
  }
  onDone();
}

// ─── Inline create input ──────────────────────────────────────────────────────

function InlineCreateInput({
  dirHandle,
  parentPath,
  kind,
  depth,
  onDone,
}: {
  dirHandle: FileSystemDirectoryHandle;
  parentPath: string;
  kind: "file" | "directory";
  depth: number;
  onDone: () => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const paddingLeft = depth * 12 + 8;

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  async function commit() {
    const name = value.trim();
    if (!name || name.includes("/") || name === "." || name === "..") {
      onDone();
      return;
    }
    const fullPath = parentPath ? `${parentPath}/${name}` : name;
    try {
      if (kind === "file") {
        await writeFileToHandle(dirHandle, fullPath, "");
      } else {
        await createDirectory(dirHandle, fullPath);
      }
      onDone();
    } catch (err) {
      toast.error(`Could not create ${kind}: ${(err as Error).message}`);
      onDone();
    }
  }

  return (
    <div style={{ paddingLeft }} className="flex items-center gap-1.5 py-0.5 pr-2">
      {kind === "file"
        ? <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        : <Folder className="size-3.5 shrink-0 text-amber-500" />
      }
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void commit(); }
          if (e.key === "Escape") onDone();
        }}
        className="flex-1 text-xs px-1 py-0.5 rounded border border-ring bg-background text-foreground outline-none focus:ring-1 focus:ring-ring"
        placeholder={kind === "file" ? "filename.ts" : "folder-name"}
      />
    </div>
  );
}

// ─── Tree node ────────────────────────────────────────────────────────────────

interface TreeNodeProps {
  entry: FileEntry;
  dirHandle: FileSystemDirectoryHandle;
  onOpenFile: (handle: FileSystemFileHandle, path: string) => void;
  depth: number;
  pendingCreate: PendingCreate | null;
  onPendingCreate: (p: PendingCreate | null) => void;
  onRefresh: () => void;
  autoExpandPaths?: ReadonlySet<string>;
}

function TreeNode({
  entry, dirHandle, onOpenFile, depth,
  pendingCreate, onPendingCreate, onRefresh, autoExpandPaths,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(entry.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const paddingLeft = depth * 12 + 8;

  const canReceiveDrop = entry.kind === "directory";

  // Auto-expand when a create is pending inside this folder
  useEffect(() => {
    if (pendingCreate?.parentPath === entry.path) setExpanded(true);
  }, [pendingCreate, entry.path]);

  // Auto-expand when the agent has written a file inside this directory
  useEffect(() => {
    if (entry.kind === "directory" && autoExpandPaths?.has(entry.path)) {
      setExpanded(true);
    }
  }, [autoExpandPaths, entry.path, entry.kind]);

  async function handleClick() {
    if (renaming) return;
    if (entry.kind === "directory") {
      setExpanded((v) => !v);
    } else {
      try {
        const parts = entry.path.split("/").filter(Boolean);
        const fileName = parts.pop()!;
        let parent: FileSystemDirectoryHandle = dirHandle;
        for (const part of parts) {
          parent = await parent.getDirectoryHandle(part, { create: false });
        }
        const fileHandle = await parent.getFileHandle(fileName, { create: false });
        onOpenFile(fileHandle, entry.path);
      } catch (err) {
        toast.error(`Could not open file: ${(err as Error).message}`);
      }
    }
  }

  function startRename() {
    setRenameValue(entry.name);
    setRenaming(true);
    setTimeout(() => renameInputRef.current?.select(), 0);
  }

  async function commitRename() {
    const newName = renameValue.trim();
    setRenaming(false);
    if (!newName || newName === entry.name) return;
    if (entry.kind === "directory") {
      toast.error("Directory rename not supported — move files manually");
      return;
    }
    const parts = entry.path.split("/");
    parts[parts.length - 1] = newName;
    const newPath = parts.join("/");
    try {
      const content = await readFileFromHandle(dirHandle, entry.path);
      await writeFileToHandle(dirHandle, newPath, content);
      await deleteEntry(dirHandle, entry.path);
      onRefresh();
    } catch (err) {
      toast.error(`Rename failed: ${(err as Error).message}`);
    }
  }

  async function handleDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    try {
      await deleteEntry(dirHandle, entry.path);
      onRefresh();
      toast.success(`Deleted ${entry.name}`);
    } catch (err) {
      toast.error(`Delete failed: ${(err as Error).message}`);
    }
  }

  const showCreateInside = entry.kind === "directory" && expanded
    && pendingCreate?.parentPath === entry.path;

  return (
    <div>
      {/* Row */}
      <div
        className={cn(
          "group relative flex items-center",
          isDragOver && "bg-accent ring-1 ring-ring rounded"
        )}
        onMouseLeave={() => setConfirmDelete(false)}
        onDragOver={(e) => {
          if (!canReceiveDrop) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = "copy";
          setIsDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!canReceiveDrop) return;
          e.stopPropagation();
          setIsDragOver(false);
        }}
        onDrop={(e) => {
          if (!canReceiveDrop) return;
          e.preventDefault();
          e.stopPropagation();
          setIsDragOver(false);
          setExpanded(true);
          void dropFilesInto(dirHandle, entry.path, e.dataTransfer, onRefresh);
        }}
      >
        <button
          type="button"
          onClick={handleClick}
          style={{ paddingLeft }}
          className={cn(
            "flex-1 flex items-center gap-1.5 py-0.5 pr-1 text-xs rounded hover:bg-accent text-foreground/80 hover:text-foreground transition-colors text-left min-w-0"
          )}
        >
          {entry.kind === "directory" ? (
            <>
              {expanded
                ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                : <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
              }
              {expanded
                ? <FolderOpen className="size-3.5 shrink-0 text-amber-500" />
                : <Folder className="size-3.5 shrink-0 text-amber-500" />
              }
            </>
          ) : (
            <>
              <span className="size-3 shrink-0" />
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            </>
          )}

          {renaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); void commitRename(); }
                if (e.key === "Escape") setRenaming(false);
              }}
              className="flex-1 text-xs px-1 py-0 rounded border border-ring bg-background text-foreground outline-none focus:ring-1 focus:ring-ring"
            />
          ) : (
            <span className="truncate">{entry.name}</span>
          )}
        </button>

        {/* Hover actions */}
        {!renaming && (
          <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 pr-1 shrink-0">
            {entry.kind === "directory" && (
              <>
                <button
                  type="button"
                  title="New file inside"
                  onClick={(e) => { e.stopPropagation(); setExpanded(true); onPendingCreate({ parentPath: entry.path, kind: "file" }); }}
                  className="size-4 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent"
                >
                  <FilePlus className="size-3" />
                </button>
                <button
                  type="button"
                  title="New folder inside"
                  onClick={(e) => { e.stopPropagation(); setExpanded(true); onPendingCreate({ parentPath: entry.path, kind: "directory" }); }}
                  className="size-4 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent"
                >
                  <FolderPlus className="size-3" />
                </button>
              </>
            )}
            <button
              type="button"
              title="Rename"
              onClick={(e) => { e.stopPropagation(); startRename(); }}
              className="size-4 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              <Pencil className="size-3" />
            </button>
            <button
              type="button"
              title={confirmDelete ? "Click again to confirm" : "Delete"}
              onClick={(e) => { e.stopPropagation(); void handleDelete(); }}
              className={cn(
                "size-4 flex items-center justify-center rounded hover:bg-accent",
                confirmDelete ? "text-destructive" : "text-muted-foreground hover:text-destructive"
              )}
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        )}
      </div>

      {/* Children */}
      {entry.kind === "directory" && expanded && (
        <div>
          {showCreateInside && (
            <InlineCreateInput
              dirHandle={dirHandle}
              parentPath={entry.path}
              kind={pendingCreate!.kind}
              depth={depth + 1}
              onDone={() => { onPendingCreate(null); onRefresh(); }}
            />
          )}
          {entry.children?.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              dirHandle={dirHandle}
              onOpenFile={onOpenFile}
              depth={depth + 1}
              pendingCreate={pendingCreate}
              onPendingCreate={onPendingCreate}
              onRefresh={onRefresh}
              autoExpandPaths={autoExpandPaths}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── FileTree root ────────────────────────────────────────────────────────────

export function FileTree({ dirHandle, onOpenFile, onOpenDir, refreshKey, onRefresh, autoExpandPaths }: Props) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [isRootDragOver, setIsRootDragOver] = useState(false);

  const refresh = useCallback(() => {
    if (!dirHandle) { setEntries([]); return; }
    setLoading(true);
    setError(null);
    // Depth 5 so nested project structures (src/components/ui/…) are fully visible
    listDirectory(dirHandle, 5)
      .then(setEntries)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [dirHandle]);

  useEffect(() => { refresh(); }, [refresh, refreshKey]);

  function handleMutationDone() {
    refresh();
    onRefresh?.();
    setPendingCreate(null);
  }

  if (!dirHandle) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 p-4 text-center">
        <FolderOpen className="size-8 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">No workspace open</p>
        {onOpenDir && (
          <Button size="sm" variant="outline" onClick={onOpenDir} className="text-xs">
            Open workspace
          </Button>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn("h-full overflow-y-auto", isRootDragOver && "bg-accent/40")}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setIsRootDragOver(true);
      }}
      onDragLeave={() => setIsRootDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsRootDragOver(false);
        void dropFilesInto(dirHandle, "", e.dataTransfer, handleMutationDone);
      }}
    >
      {/* Header */}
      <div className="px-2 py-2 border-b flex items-center gap-1">
        <FolderOpen className="size-3.5 text-amber-500 shrink-0" />
        <span className="text-xs font-medium truncate text-foreground flex-1">{dirHandle.name}</span>
        <button
          type="button"
          title="New file"
          onClick={() => setPendingCreate({ parentPath: "", kind: "file" })}
          className="size-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent shrink-0"
        >
          <FilePlus className="size-3.5" />
        </button>
        <button
          type="button"
          title="New folder"
          onClick={() => setPendingCreate({ parentPath: "", kind: "directory" })}
          className="size-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent shrink-0"
        >
          <FolderPlus className="size-3.5" />
        </button>
      </div>

      {loading && <p className="text-xs text-muted-foreground p-3">Loading...</p>}
      {error && <p className="text-xs text-destructive p-3">{error}</p>}

      <div className="py-1">
        {/* Root-level inline create */}
        {pendingCreate?.parentPath === "" && (
          <InlineCreateInput
            dirHandle={dirHandle}
            parentPath=""
            kind={pendingCreate.kind}
            depth={0}
            onDone={handleMutationDone}
          />
        )}
        {!loading && !error && entries.length === 0 && !pendingCreate && (
          <p className="text-xs text-muted-foreground p-3">Empty directory</p>
        )}
        {entries.map((entry) => (
          <TreeNode
            key={entry.path}
            entry={entry}
            dirHandle={dirHandle}
            onOpenFile={onOpenFile}
            depth={0}
            pendingCreate={pendingCreate}
            onPendingCreate={setPendingCreate}
            onRefresh={handleMutationDone}
            autoExpandPaths={autoExpandPaths}
          />
        ))}
      </div>
    </div>
  );
}
