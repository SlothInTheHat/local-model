import { evaluate } from "mathjs";
import { searchWeb } from "./search";
import { fileExists, backupFile, readFileFromHandle } from "./fileSystem";

// ─── Tauri invoke shim ───────────────────────────────────────────────────────

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__;
  if (!tauri) throw new Error("Not in Tauri desktop mode — launch with npm run tauri dev");
  const core = (tauri as Record<string, unknown>).core as {
    invoke?: (cmd: string, args?: unknown) => Promise<T>;
  };
  if (typeof core?.invoke !== "function") throw new Error("Tauri core.invoke unavailable");
  return core.invoke(cmd, args);
}

// Exposed so App.tsx can pass hardware/model info into get_system_info results
export let _systemInfoContext: {
  model?: string;
  gpuName?: string;
  vramGb?: number;
  ramGb?: number;
  cpuThreads?: number;
} = {};

export function setSystemInfoContext(ctx: typeof _systemInfoContext) {
  _systemInfoContext = { ..._systemInfoContext, ...ctx };
}

export type ToolName =
  | "read_file"
  | "write_file"
  | "delete_file"
  | "list_directory"
  | "grep_files"
  | "find_files"
  | "calculator"
  | "web_search"
  | "run_command"
  | "get_system_info";

export interface ToolDef {
  name: ToolName;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
}

export const TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: "read_file",
    description:
      "Read the text content of a file from the current workspace directory.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file within the workspace (e.g. 'src/main.ts').",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a file in the current workspace directory with the given text content.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file within the workspace.",
        },
        content: {
          type: "string",
          description: "The full text content to write.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_directory",
    description:
      "List the files and subdirectories in the current workspace (up to 2 levels deep). Returns a JSON array.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Optional sub-path within the workspace. Defaults to root.",
        },
      },
      required: [],
    },
  },
  {
    name: "calculator",
    description:
      "Evaluate a mathematical expression and return the numeric result. Uses mathjs syntax.",
    parameters: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "The math expression to evaluate (e.g. '2 + 2', 'sqrt(16)', 'sin(pi/4)').",
        },
      },
      required: ["expression"],
    },
  },
  {
    name: "web_search",
    description: "Search the web using DuckDuckGo and return a summary of results.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query string." },
      },
      required: ["query"],
    },
  },
  {
    name: "grep_files",
    description:
      "Search file contents for a pattern (like grep). Returns matching lines with file path and line number. Use this to find where a function, variable, or string is defined or used.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regular expression or plain string to search for.",
        },
        path: {
          type: "string",
          description: "Directory to search in, relative to workspace root. Defaults to root.",
        },
        file_pattern: {
          type: "string",
          description: "Glob to filter which files to search, e.g. '*.ts' or '*.tsx'. Defaults to all files.",
        },
        case_sensitive: {
          type: "boolean",
          description: "Whether the search is case-sensitive. Defaults to false.",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "delete_file",
    description:
      "Permanently delete a file from the workspace. Cannot be undone. Only deletes files, not directories.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file within the workspace (e.g. 'src/old.ts').",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "find_files",
    description:
      "Find files or directories by name pattern (like find). Returns a list of matching paths.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Name pattern to match. Supports * wildcard, e.g. '*.ts', 'use*.ts', 'App*'.",
        },
        path: {
          type: "string",
          description: "Directory to search in, relative to workspace root. Defaults to root.",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "run_command",
    description:
      "Execute a shell command on the user's machine and return its stdout/stderr output. Use for running scripts, compiling code, checking git status, installing packages, etc. Requires Tauri desktop mode.",
    parameters: {
      type: "object",
      properties: {
        cmd: {
          type: "string",
          description: "The shell command to run (e.g. 'npm install', 'git status', 'python main.py').",
        },
        cwd: {
          type: "string",
          description: "Working directory for the command. Defaults to the app's current directory.",
        },
      },
      required: ["cmd"],
    },
  },
  {
    name: "get_system_info",
    description:
      "Get system information: OS, CPU threads, GPU name, VRAM, RAM, and the currently selected Ollama model. Useful for understanding what models and tasks are feasible on this machine.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

export interface ToolCall {
  id: string;
  name: ToolName;
  args: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: ToolName;
  output: string;
  error?: string;
}

// ─── Grep / Find helpers ──────────────────────────────────────────────────────

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexStr = escaped.replace(/\*\*/g, ".+").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${regexStr}$`, "i");
}

function matchesFileGlob(name: string, pattern: string): boolean {
  if (!pattern || pattern === "*" || pattern === "**/*") return true;
  return globToRegex(pattern).test(name);
}

// Skip noisy directories that are rarely useful
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "__pycache__", ".venv", "build", "coverage"]);

async function grepInHandle(
  handle: FileSystemDirectoryHandle,
  pattern: RegExp,
  fileGlob: string,
  pathPrefix: string,
  results: string[],
  maxResults: number
): Promise<void> {
  if (results.length >= maxResults) return;
  for await (const [name, entry] of handle.entries()) {
    if (results.length >= maxResults) return;
    const entryPath = pathPrefix ? `${pathPrefix}/${name}` : name;
    if (entry.kind === "directory") {
      if (SKIP_DIRS.has(name)) continue;
      await grepInHandle(entry as FileSystemDirectoryHandle, pattern, fileGlob, entryPath, results, maxResults);
    } else if (matchesFileGlob(name, fileGlob)) {
      try {
        const file = await (entry as FileSystemFileHandle).getFile();
        // Skip binary files by checking size
        if (file.size > 500_000) continue;
        const text = await file.text();
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          pattern.lastIndex = 0;
          if (pattern.test(lines[i])) {
            results.push(`${entryPath}:${i + 1}: ${lines[i].trimEnd()}`);
            if (results.length >= maxResults) return;
          }
        }
      } catch {
        // skip unreadable
      }
    }
  }
}

async function findInHandle(
  handle: FileSystemDirectoryHandle,
  namePattern: RegExp,
  pathPrefix: string,
  results: string[],
  maxResults: number
): Promise<void> {
  if (results.length >= maxResults) return;
  for await (const [name, entry] of handle.entries()) {
    if (results.length >= maxResults) return;
    const entryPath = pathPrefix ? `${pathPrefix}/${name}` : name;
    if (namePattern.test(name)) results.push(entryPath);
    if (entry.kind === "directory") {
      if (SKIP_DIRS.has(name)) continue;
      await findInHandle(entry as FileSystemDirectoryHandle, namePattern, entryPath, results, maxResults);
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Safely extract a string from a tool arg — guards against models passing schema objects. */
function argStr(val: unknown): string {
  if (typeof val === "string") return val;
  if (val == null) return "";
  // Model passed an object (e.g. schema fragment) — try common value fields
  if (typeof val === "object") {
    const o = val as Record<string, unknown>;
    if (typeof o["value"] === "string") return o["value"];
    if (typeof o["default"] === "string") return o["default"];
    return "";
  }
  return String(val);
}

function noWorkspace(call: ToolCall): ToolResult {
  return {
    toolCallId: call.id,
    name: call.name,
    output: "",
    error: "No workspace directory set. Ask the user to open a folder.",
  };
}

function normalizeSubPath(p: string): string {
  const trimmed = p.trim().replace(/^\.?\/?$/, "");
  return trimmed;
}

/** Throw if any segment of a path could escape the workspace. */
function assertNoTraversal(path: string): void {
  // Split on both slash styles, filter blanks
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  for (const part of parts) {
    if (part === ".." || part === ".") {
      throw new Error(`Path traversal not allowed: "${path}"`);
    }
  }
  // Catch encoded variants like %2e%2e
  if (/%2e/i.test(path) || /\.\./i.test(path)) {
    throw new Error(`Path traversal not allowed: "${path}"`);
  }
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

interface DirEntry {
  name: string;
  kind: "file" | "directory";
  children?: DirEntry[];
}

function renderEntries(entries: DirEntry[], indent: string): string {
  return entries
    .map((e) => {
      const prefix = e.kind === "directory" ? "📁 " : "📄 ";
      const line = indent + prefix + e.name;
      if (e.children && e.children.length > 0) {
        return line + "\n" + renderEntries(e.children, indent + "  ");
      }
      return line;
    })
    .join("\n");
}

async function listEntries(
  handle: FileSystemDirectoryHandle,
  depth: number
): Promise<DirEntry[]> {
  const entries: DirEntry[] = [];
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind === "directory") {
      if (SKIP_DIRS.has(name)) {
        entries.push({ name: `${name}/ (skipped)`, kind: "directory" });
        continue;
      }
      if (depth > 0) {
        const children = await listEntries(entry as FileSystemDirectoryHandle, depth - 1);
        entries.push({ name, kind: "directory", children });
      } else {
        entries.push({ name, kind: "directory" });
      }
    } else {
      entries.push({ name, kind: entry.kind });
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

// ─── Executor ────────────────────────────────────────────────────────────────

export async function executeTool(
  call: ToolCall,
  dirHandle: FileSystemDirectoryHandle | null
): Promise<ToolResult> {
  try {
    switch (call.name) {
      case "calculator": {
        const expr = argStr(call.args["expression"]);
        if (!expr) throw new Error("Missing expression argument");
        const result = evaluate(expr) as unknown;
        return {
          toolCallId: call.id,
          name: call.name,
          output: String(result),
        };
      }

      case "web_search": {
        const query = argStr(call.args["query"]);
        if (!query) throw new Error("Missing query argument");
        const ctx = await searchWeb(query);
        return {
          toolCallId: call.id,
          name: call.name,
          output: ctx.formatted,
        };
      }

      case "list_directory": {
        if (!dirHandle) return noWorkspace(call);
        const subPath = normalizeSubPath(argStr(call.args["path"]));
        let targetHandle = dirHandle;
        if (subPath) {
          const parts = subPath.split("/").filter(Boolean);
          const resolved = await resolveDirHandle(dirHandle, parts);
          if (!resolved) throw new Error(`Directory not found: ${subPath}`);
          targetHandle = resolved;
        }
        const entries = await listEntries(targetHandle, 2);
        return {
          toolCallId: call.id,
          name: call.name,
          output: renderEntries(entries, ""),
        };
      }

      case "read_file": {
        if (!dirHandle) return noWorkspace(call);
        const path = argStr(call.args["path"]);
        if (!path) throw new Error("Missing path argument");
        assertNoTraversal(path);
        const parts = path.split("/").filter(Boolean);
        const fileName = parts.pop()!;
        let parentHandle = dirHandle;
        if (parts.length > 0) {
          const resolved = await resolveDirHandle(dirHandle, parts);
          if (!resolved) throw new Error(`Directory not found: ${parts.join("/")}`);
          parentHandle = resolved;
        }
        const fileHandle = await parentHandle.getFileHandle(fileName, { create: false });
        const file = await fileHandle.getFile();
        const text = await file.text();
        return {
          toolCallId: call.id,
          name: call.name,
          output: text,
        };
      }

      case "write_file": {
        if (!dirHandle) return noWorkspace(call);
        const path = argStr(call.args["path"]);
        const content = argStr(call.args["content"]);
        if (!path) throw new Error("Missing path argument");
        assertNoTraversal(path);

        const isBackupPath = path.startsWith(".localmind-backups/");
        let backupPath: string | null = null;

        if (!isBackupPath && await fileExists(dirHandle, path)) {
          const existing = await readFileFromHandle(dirHandle, path);
          backupPath = await backupFile(dirHandle, path, existing);
        }

        const parts = path.split("/").filter(Boolean);
        const fileName = parts.pop()!;
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

        const verb = backupPath ? "File written" : "File created";
        const backupNote = backupPath ? `\nBackup saved to: ${backupPath}` : "";
        return {
          toolCallId: call.id,
          name: call.name,
          output: `${verb}: ${path}${backupNote}`,
        };
      }

      case "grep_files": {
        if (!dirHandle) return noWorkspace(call);
        const pattern = argStr(call.args["pattern"]);
        if (!pattern) throw new Error("Missing pattern argument");
        const searchPath = normalizeSubPath(argStr(call.args["path"]));
        const fileGlob = argStr(call.args["file_pattern"]) || "*";
        const caseSensitive = (call.args["case_sensitive"] as boolean | undefined) ?? false;

        let targetHandle = dirHandle;
        if (searchPath) {
          const parts = searchPath.split("/").filter(Boolean);
          const resolved = await resolveDirHandle(dirHandle, parts);
          if (!resolved) throw new Error(`Directory not found: ${searchPath}`);
          targetHandle = resolved;
        }

        let regex: RegExp;
        try {
          regex = new RegExp(pattern, caseSensitive ? "g" : "gi");
        } catch {
          // Fall back to literal string search
          const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          regex = new RegExp(escaped, caseSensitive ? "g" : "gi");
        }

        const results: string[] = [];
        await grepInHandle(targetHandle, regex, fileGlob, searchPath || ".", results, 100);

        return {
          toolCallId: call.id,
          name: call.name,
          output: results.length > 0
            ? `${results.length} match${results.length !== 1 ? "es" : ""}:\n${results.join("\n")}`
            : "No matches found.",
        };
      }

      case "find_files": {
        if (!dirHandle) return noWorkspace(call);
        const pattern = argStr(call.args["pattern"]);
        if (!pattern) throw new Error("Missing pattern argument");
        const searchPath = normalizeSubPath(argStr(call.args["path"]));

        let targetHandle = dirHandle;
        if (searchPath) {
          const parts = searchPath.split("/").filter(Boolean);
          const resolved = await resolveDirHandle(dirHandle, parts);
          if (!resolved) throw new Error(`Directory not found: ${searchPath}`);
          targetHandle = resolved;
        }

        const nameRegex = globToRegex(pattern.replace(/^.*\//, "")); // match basename only
        const results: string[] = [];
        await findInHandle(targetHandle, nameRegex, searchPath || ".", results, 200);

        return {
          toolCallId: call.id,
          name: call.name,
          output: results.length > 0
            ? `${results.length} file${results.length !== 1 ? "s" : ""} found:\n${results.join("\n")}`
            : "No files matched.",
        };
      }

      case "delete_file": {
        if (!dirHandle) return noWorkspace(call);
        const path = argStr(call.args["path"]);
        if (!path) throw new Error("Missing path argument");
        assertNoTraversal(path);
        const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
        const fileName = parts.pop()!;
        let parentHandle = dirHandle;
        if (parts.length > 0) {
          const resolved = await resolveDirHandle(dirHandle, parts);
          if (!resolved) throw new Error(`Directory not found: ${parts.join("/")}`);
          parentHandle = resolved;
        }
        await parentHandle.removeEntry(fileName, { recursive: false });
        return {
          toolCallId: call.id,
          name: call.name,
          output: `Deleted: ${path}`,
        };
      }

      case "run_command": {
        const cmd = argStr(call.args["cmd"]);
        if (!cmd) throw new Error("Missing cmd argument");
        const cwd = argStr(call.args["cwd"]) || undefined;
        const result = await tauriInvoke<{ stdout: string; stderr: string; exit_code: number; cwd: string }>(
          "run_command",
          { cmd, cwd }
        );
        const combined = [result.stdout, result.stderr].filter(Boolean).join("\n");
        return {
          toolCallId: call.id,
          name: call.name,
          output: combined || "(no output)",
          ...(result.exit_code !== 0 ? { error: `Exit code: ${result.exit_code}` } : {}),
        };
      }

      case "get_system_info": {
        const ctx = _systemInfoContext;
        const info = {
          model: ctx.model ?? "unknown",
          gpu: ctx.gpuName ?? "unknown",
          vram_gb: ctx.vramGb ?? 0,
          ram_gb: ctx.ramGb ?? 0,
          cpu_threads: ctx.cpuThreads ?? 0,
          platform: navigator.platform,
          user_agent: navigator.userAgent,
          tauri_mode: !!(window as unknown as Record<string, unknown>).__TAURI__,
        };
        return {
          toolCallId: call.id,
          name: call.name,
          output: JSON.stringify(info, null, 2),
        };
      }

      default: {
        const exhaustive: never = call.name;
        return {
          toolCallId: call.id,
          name: call.name,
          output: "",
          error: `Unknown tool: ${exhaustive}`,
        };
      }
    }
  } catch (err) {
    const e = err as Error;
    return {
      toolCallId: call.id,
      name: call.name,
      output: "",
      error: e.message,
    };
  }
}
