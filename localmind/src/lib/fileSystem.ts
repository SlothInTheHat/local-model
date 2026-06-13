import { TauriDirectoryHandle, tauriPathExists } from "./tauriFs";

export interface FileEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  children?: FileEntry[];
}

export interface WorkspaceResult {
  handle: FileSystemDirectoryHandle;
  path: string | null;  // real OS path, only in Tauri mode
  name: string;
}

// Tauri invoke shim
async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__;
  if (!tauri) throw new Error("not in tauri");
  const core = (tauri as Record<string, unknown>).core as {
    invoke?: (cmd: string, args?: unknown) => Promise<T>;
  };
  if (typeof core?.invoke !== "function") throw new Error("no invoke");
  return core.invoke(cmd, args);
}

export function isTauriEnv(): boolean {
  const w = window as unknown as Record<string, unknown>;
  return !!(w.__TAURI__ || w.__TAURI_INTERNALS__);
}

// File System Access API — not in all TypeScript DOM lib versions
type ShowDirectoryPickerOpts = { mode?: "read" | "readwrite" };
const showDirectoryPicker = (opts?: ShowDirectoryPickerOpts): Promise<FileSystemDirectoryHandle> =>
  (window as unknown as { showDirectoryPicker: (o?: ShowDirectoryPickerOpts) => Promise<FileSystemDirectoryHandle> })
    .showDirectoryPicker(opts);

/**
 * Open a workspace folder.
 *
 * Tauri mode: uses the native OS folder picker via Tauri invoke, then wraps
 * the result in a TauriDirectoryHandle that routes all file I/O through
 * Tauri commands — no showDirectoryPicker call needed (avoids the
 * "Must be handling a user gesture" error that occurs after awaiting a
 * Tauri invoke).
 *
 * Browser mode: falls back to the File System Access API.
 */
export async function openWorkspace(): Promise<WorkspaceResult> {
  if (isTauriEnv()) {
    // Native Tauri path — open_workspace_dialog returns the selected OS path.
    // We do NOT call showDirectoryPicker here; TauriDirectoryHandle handles
    // all file operations through Tauri commands instead.
    const osPath = await tauriInvoke<string | null>("open_workspace_dialog");
    if (!osPath) throw new DOMException("User cancelled", "AbortError");
    const handle = new TauriDirectoryHandle(osPath) as unknown as FileSystemDirectoryHandle;
    const name = osPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "workspace";
    return { handle, path: osPath, name };
  }

  // Browser fallback — uses File System Access API (requires user gesture)
  const handle = await showDirectoryPicker({ mode: "readwrite" });
  return { handle, path: null, name: handle.name };
}

/** @deprecated use openWorkspace() */
export async function openDirectory(): Promise<FileSystemDirectoryHandle> {
  return showDirectoryPicker({ mode: "readwrite" });
}

/**
 * Re-open a remembered workspace by its OS path, skipping the folder picker.
 * Tauri-only — browser mode has no stable path to reopen.
 */
export async function openWorkspaceByPath(path: string): Promise<WorkspaceResult> {
  if (!(await tauriPathExists(path))) throw new Error(`Folder not found: ${path}`);
  const handle = new TauriDirectoryHandle(path) as unknown as FileSystemDirectoryHandle;
  const name = path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "workspace";
  return { handle, path, name };
}

async function resolveDirHandle(
  root: FileSystemDirectoryHandle,
  parts: string[]
): Promise<FileSystemDirectoryHandle | null> {
  let handle: FileSystemDirectoryHandle = root;
  for (const part of parts) {
    try {
      handle = await handle.getDirectoryHandle(part, { create: false });
    } catch {
      return null;
    }
  }
  return handle;
}

export async function readFileFromHandle(
  dirHandle: FileSystemDirectoryHandle,
  path: string
): Promise<string> {
  const parts = path.split("/").filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) throw new Error("Empty file path");

  let parentHandle = dirHandle;
  if (parts.length > 0) {
    const resolved = await resolveDirHandle(dirHandle, parts);
    if (!resolved) throw new Error(`Directory not found: ${parts.join("/")}`);
    parentHandle = resolved;
  }

  const fileHandle = await parentHandle.getFileHandle(fileName, { create: false });
  const file = await fileHandle.getFile();
  return file.text();
}

export async function writeFileToHandle(
  dirHandle: FileSystemDirectoryHandle,
  path: string,
  content: string
): Promise<void> {
  const parts = path.split("/").filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) throw new Error("Empty file path");

  let parentHandle = dirHandle;
  if (parts.length > 0) {
    let cursor: FileSystemDirectoryHandle = dirHandle;
    for (const part of parts) {
      cursor = await cursor.getDirectoryHandle(part, { create: true });
    }
    parentHandle = cursor;
  }

  const fileHandle = await parentHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

const HIDDEN_ENTRIES = new Set([
  ".localmind-backups",
  "node_modules", ".git", "dist", ".next", "__pycache__", ".venv", "build", "coverage",
]);

async function buildEntries(
  handle: FileSystemDirectoryHandle,
  basePath: string,
  depth: number,
  maxDepth: number
): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  for await (const [name, entry] of handle.entries()) {
    if (HIDDEN_ENTRIES.has(name)) continue;
    const entryPath = basePath ? `${basePath}/${name}` : name;
    if (entry.kind === "directory" && depth < maxDepth) {
      const children = await buildEntries(
        entry as FileSystemDirectoryHandle,
        entryPath,
        depth + 1,
        maxDepth
      );
      entries.push({ name, path: entryPath, kind: "directory", children });
    } else {
      entries.push({ name, path: entryPath, kind: entry.kind });
    }
  }
  entries.sort((a, b) => {
    // Directories first, then files
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

export async function listDirectory(
  dirHandle: FileSystemDirectoryHandle,
  maxDepth = 3
): Promise<FileEntry[]> {
  return buildEntries(dirHandle, "", 0, maxDepth);
}

export async function fileExists(
  dirHandle: FileSystemDirectoryHandle,
  path: string
): Promise<boolean> {
  const parts = path.split("/").filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) return false;
  let parentHandle = dirHandle;
  if (parts.length > 0) {
    const resolved = await resolveDirHandle(dirHandle, parts);
    if (!resolved) return false;
    parentHandle = resolved;
  }
  try {
    await parentHandle.getFileHandle(fileName, { create: false });
    return true;
  } catch {
    return false;
  }
}

export async function backupFile(
  dirHandle: FileSystemDirectoryHandle,
  path: string,
  content: string
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    + "_" + Math.random().toString(16).slice(2, 6);
  const backupPath = `.localmind-backups/${timestamp}/${path}`;
  await writeFileToHandle(dirHandle, backupPath, content);
  return backupPath;
}

export async function deleteEntry(
  dirHandle: FileSystemDirectoryHandle,
  path: string
): Promise<void> {
  const parts = path.split("/").filter(Boolean);
  const name = parts.pop();
  if (!name) throw new Error("Empty path");
  let parentHandle = dirHandle;
  if (parts.length > 0) {
    const resolved = await resolveDirHandle(dirHandle, parts);
    if (!resolved) throw new Error(`Parent directory not found: ${parts.join("/")}`);
    parentHandle = resolved;
  }
  await parentHandle.removeEntry(name, { recursive: true });
}

export async function createDirectory(
  dirHandle: FileSystemDirectoryHandle,
  path: string
): Promise<void> {
  const parts = path.split("/").filter(Boolean);
  let cursor: FileSystemDirectoryHandle = dirHandle;
  for (const part of parts) {
    cursor = await cursor.getDirectoryHandle(part, { create: true });
  }
}
