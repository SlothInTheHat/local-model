import { evaluate } from "mathjs";
import { searchWeb } from "./search";
import { fileExists, backupFile, readFileFromHandle } from "./fileSystem";
import { mcpCallTool } from "./mcp";
import { useMcpStore } from "../store/mcp";
import { injectGitCredentials, sanitizeOutput } from "../store/profile";
import { loadSkills, saveSkill } from "./skillEngine";
import { updateMemorySection } from "./projectMemory";
import { saveDynamicTool } from "./dynamicTools";
import type { DynamicToolDef } from "./dynamicTools";

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
  | "get_system_info"
  | "git_status"
  | "git_diff"
  | "git_log"
  | "git_add"
  | "git_commit";

export interface ToolDef {
  // string allows MCP tools with dynamic "serverId__toolName" names
  name: string;
  description: string;
  parameters: Record<string, unknown>;
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
  {
    name: "git_status",
    description: "Show the working tree status (changed, staged, and untracked files). Use this to understand what has changed in the repo.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "git_diff",
    description: "Show the diff of unstaged or staged changes. Optionally limit to a specific file.",
    parameters: {
      type: "object",
      properties: {
        staged: { type: "boolean", description: "If true, show staged (--cached) diff." },
        path: { type: "string", description: "Optional file path to limit the diff to." },
      },
      required: [],
    },
  },
  {
    name: "git_log",
    description: "Show the last 20 commits in one-line format.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "git_add",
    description: "Stage file(s) for commit.",
    parameters: {
      type: "object",
      properties: {
        paths: { type: "string", description: "Space-separated list of files/patterns to stage, e.g. 'src/main.ts' or '.' for all." },
      },
      required: ["paths"],
    },
  },
  {
    name: "git_commit",
    description: "Create a git commit with the given message. Only stage changes you intend to commit first.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The commit message." },
      },
      required: ["message"],
    },
  },
  {
    name: "save_skill",
    description: "Save a reusable skill (procedural knowledge) to the workspace skill registry at .localmind/skills/. Use this after completing a task to preserve the workflow for future use.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable skill name, e.g. 'Docker Debugging'." },
        tags: { type: "string", description: "Comma-separated tags for skill discovery, e.g. 'docker,container,debug'." },
        content: { type: "string", description: "Markdown content: step-by-step instructions, commands, and tips." },
      },
      required: ["name", "tags", "content"],
    },
  },
  {
    name: "update_project_memory",
    description: "Update or append a named section in the project's persistent memory file (.localmind/memory.md). Use this to store architecture decisions, tech stack info, common commands, or user preferences that should persist across sessions.",
    parameters: {
      type: "object",
      properties: {
        section: { type: "string", description: "Section heading name, e.g. 'Tech Stack' or 'Common Commands'." },
        content: { type: "string", description: "Markdown content for this section. Replaces existing content for the section." },
      },
      required: ["section", "content"],
    },
  },
  {
    name: "list_skills",
    description: "List all skills in the workspace skill registry (.localmind/skills/). Returns skill names and tags.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "register_tool",
    description: "Register a new dynamic tool in the workspace tool registry (.localmind/tools/). The tool will be available in future sessions. Tools use run_command under the hood with a template string.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Tool name (snake_case), e.g. 'analyze_logs'." },
        description: { type: "string", description: "What the tool does." },
        parameters: { type: "string", description: "JSON object mapping parameter names to {type, description} objects." },
        template: { type: "string", description: "Shell command template using {{paramName}} placeholders, e.g. 'grep -n \"{{pattern}}\" \"{{path}}\"'." },
      },
      required: ["name", "description", "template"],
    },
  },
];

/**
 * Returns the combined tool list: built-in tools (filtered by enabled state) + MCP tools.
 * Import and call this instead of TOOL_DEFINITIONS directly.
 */
export function getToolDefinitions(mcpTools: ToolDef[] = []): ToolDef[] {
  return [...TOOL_DEFINITIONS, ...mcpTools];
}

export interface ToolCall {
  id: string;
  name: string; // string allows MCP tool names ("serverId__toolName")
  args: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
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
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", "__pycache__", ".venv", "build", "coverage", ".localmind-backups"]);

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

/**
 * Resolve a path relative to the workspace root.
 * Collapses "." segments and resolves ".." against the accumulated stack.
 * Throws only if ".." would escape the root (stack underflows) or if
 * percent-encoded dot sequences are present.
 * Returns the canonical path segments ready for the File System Access API.
 */
function resolvePathParts(path: string): string[] {
  if (/%2e/i.test(path)) {
    throw new Error(`Path traversal not allowed: "${path}"`);
  }
  const raw = path.replace(/\\/g, "/").split("/").filter((s) => s !== "" && s !== ".");
  const stack: string[] = [];
  for (const part of raw) {
    if (part === "..") {
      if (stack.length === 0) {
        throw new Error(`Path traversal not allowed: "${path}"`);
      }
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack;
}

function normalizeSubPath(p: string): string {
  const trimmed = p.trim();
  if (!trimmed) return "";
  return resolvePathParts(trimmed).join("/");
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
    // ── MCP dispatch: names are prefixed "serverId__toolName" ────────────────
    if (call.name.includes("__")) {
      const [serverId] = call.name.split("__");
      const server = useMcpStore.getState().servers.find((s) => s.id === serverId);
      if (!server) {
        return { toolCallId: call.id, name: call.name, output: "", error: `MCP server '${serverId}' not found` };
      }
      const output = await mcpCallTool(server, call.name, call.args);
      return { toolCallId: call.id, name: call.name, output };
    }

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
        const parts = resolvePathParts(path);
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
        const parts = resolvePathParts(path);
        const normalizedPath = parts.join("/");

        const isBackupPath = normalizedPath.startsWith(".localmind-backups/");
        let backupPath: string | null = null;

        if (!isBackupPath && await fileExists(dirHandle, normalizedPath)) {
          const existing = await readFileFromHandle(dirHandle, normalizedPath);
          backupPath = await backupFile(dirHandle, normalizedPath, existing);
        }
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
        const parts = resolvePathParts(path);
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
        // Inject stored git credentials into HTTPS URLs before execution.
        // Token is never shown in the approval dialog (call.args keeps the original).
        const injectedCmd = injectGitCredentials(cmd);
        const result = await tauriInvoke<{ stdout: string; stderr: string; exit_code: number; cwd: string }>(
          "run_command",
          { cmd: injectedCmd, cwd }
        );
        const combined = sanitizeOutput(
          [result.stdout, result.stderr].filter(Boolean).join("\n")
        );
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

      case "git_status":
      case "git_diff":
      case "git_log":
      case "git_add":
      case "git_commit": {
        let gitCmd: string;
        if (call.name === "git_status") {
          gitCmd = "git status --porcelain";
        } else if (call.name === "git_diff") {
          const staged = call.args["staged"] ? "--cached " : "";
          const path = argStr(call.args["path"]);
          gitCmd = `git diff ${staged}${path ? `-- ${path}` : ""}`.trim();
        } else if (call.name === "git_log") {
          gitCmd = "git log --oneline -20";
        } else if (call.name === "git_add") {
          const paths = argStr(call.args["paths"]);
          if (!paths) throw new Error("Missing paths argument");
          gitCmd = `git add ${paths}`;
        } else {
          const message = argStr(call.args["message"]);
          if (!message) throw new Error("Missing message argument");
          gitCmd = `git commit -m "${message.replace(/"/g, '\\"')}"`;
        }
        const gitResult = await tauriInvoke<{ stdout: string; stderr: string; exit_code: number }>(
          "run_command",
          { cmd: gitCmd }
        );
        const combined = [gitResult.stdout, gitResult.stderr].filter(Boolean).join("\n");
        return {
          toolCallId: call.id,
          name: call.name,
          output: combined || "(no output)",
          ...(gitResult.exit_code !== 0 ? { error: `Exit code: ${gitResult.exit_code}` } : {}),
        };
      }

      case "save_skill": {
        if (!dirHandle) return noWorkspace(call);
        const skillName = argStr(call.args["name"]);
        const tagsStr = argStr(call.args["tags"]);
        const content = argStr(call.args["content"]);
        if (!skillName || !content) throw new Error("Missing name or content");
        const tags = tagsStr.split(",").map((t) => t.trim()).filter(Boolean);
        const filename = await saveSkill(dirHandle, { name: skillName, tags, content });
        return {
          toolCallId: call.id,
          name: call.name,
          output: `Skill saved: .localmind/skills/${filename}`,
        };
      }

      case "update_project_memory": {
        if (!dirHandle) return noWorkspace(call);
        const section = argStr(call.args["section"]);
        const content = argStr(call.args["content"]);
        if (!section || !content) throw new Error("Missing section or content");
        await updateMemorySection(dirHandle, section, content);
        return {
          toolCallId: call.id,
          name: call.name,
          output: `Project memory updated: ## ${section}`,
        };
      }

      case "list_skills": {
        if (!dirHandle) return noWorkspace(call);
        const skills = await loadSkills(dirHandle);
        if (skills.length === 0) {
          return { toolCallId: call.id, name: call.name, output: "No skills found in .localmind/skills/." };
        }
        const list = skills.map((s) => `- **${s.name}** [${s.tags.join(", ")}]`).join("\n");
        return { toolCallId: call.id, name: call.name, output: `${skills.length} skills:\n${list}` };
      }

      case "register_tool": {
        if (!dirHandle) return noWorkspace(call);
        const toolName = argStr(call.args["name"]);
        const description = argStr(call.args["description"]);
        const template = argStr(call.args["template"]);
        if (!toolName || !description || !template) throw new Error("Missing required fields");
        let params: Record<string, { type: string; description: string }> = {};
        try {
          const rawParams = argStr(call.args["parameters"]);
          if (rawParams) params = JSON.parse(rawParams) as typeof params;
        } catch { /* ignore bad JSON */ }
        const def: DynamicToolDef = { name: toolName, description, parameters: params, implementation: "run_command", template };
        await saveDynamicTool(dirHandle, def);
        return {
          toolCallId: call.id,
          name: call.name,
          output: `Tool registered: ${toolName} → .localmind/tools/${toolName}.json`,
        };
      }

      default: {
        // Handle dynamic tools loaded from .localmind/tools/
        if ((call as unknown as { _dynamicTemplate?: string })._dynamicTemplate) {
          const tmpl = (call as unknown as { _dynamicTemplate: string })._dynamicTemplate;
          const { renderTemplate } = await import("./dynamicTools");
          const rendered = renderTemplate(tmpl, call.args);
          const injected = injectGitCredentials(rendered);
          const result = await tauriInvoke<{ stdout: string; stderr: string; exit_code: number }>(
            "run_command", { cmd: injected }
          );
          const combined = sanitizeOutput([result.stdout, result.stderr].filter(Boolean).join("\n"));
          return {
            toolCallId: call.id,
            name: call.name,
            output: combined || "(no output)",
            ...(result.exit_code !== 0 ? { error: `Exit code: ${result.exit_code}` } : {}),
          };
        }
        return {
          toolCallId: call.id,
          name: call.name,
          output: "",
          error: `Unknown tool: ${call.name}`,
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
