import { evaluate } from "mathjs";
import { searchWeb } from "./search";
import { fileExists, backupFile, readFileFromHandle } from "./fileSystem";
import { mcpCallTool } from "./mcp";
import { useMcpStore } from "../store/mcp";
import { injectGitCredentials, sanitizeOutput } from "../store/profile";
import { loadSkills, saveSkill } from "./skillEngine";
import { updateMemorySection, readProjectMemory } from "./projectMemory";
import { saveDynamicTool } from "./dynamicTools";
import type { DynamicToolDef } from "./dynamicTools";
import type { AppView } from "../types/app";
import { useChatStore } from "../store/chat";
import { useModelSelectionStore } from "../store/modelSelection";
import { useAppViewStore } from "../store/appView";
import { useTaskQueueStore } from "../store/taskQueue";

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
  | "patch_file"
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
  | "git_commit"
  | "install_deps"
  | "todo_write"
  | "apply_patch"
  | "web_fetch"
  | "create_folder"
  | "switch_model"
  | "switch_view"
  | "send_task_to_tab";

/** All top-level UI tabs/views, used for switch_view / send_task_to_tab validation. */
export const APP_VIEWS: AppView[] = [
  "chat", "code", "docs", "models", "terminal", "agents", "research",
  "study", "settings", "image", "skills", "benchmarks", "compare", "memory", "logs",
];

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
      "Create a NEW file or completely replace an existing one. For editing existing files, prefer patch_file instead.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file within the workspace." },
        content: { type: "string", description: "The full text content to write." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "patch_file",
    description: "Edit an existing file by replacing old_string with new_string. Uses fuzzy matching. Re-read the file first if unsure of exact content.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file within the workspace.",
        },
        old_string: {
          type: "string",
          description: "The exact string to find and replace (must match character-for-character including newlines and indentation).",
        },
        new_string: {
          type: "string",
          description: "The replacement string.",
        },
        replace_all: {
          type: "boolean",
          description: "If true, replace every occurrence instead of just the first. Defaults to false.",
        },
      },
      required: ["path", "old_string", "new_string"],
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
    name: "install_deps",
    description:
      "Install project dependencies by auto-detecting the package manager. " +
      "Finds requirements.txt → pip, package.json → npm, Cargo.toml → cargo, pyproject.toml → pip. " +
      "If 'Requirement already satisfied' appears for every package, installation succeeded — the tool reports OK. " +
      "Use this instead of calling run_command with pip/npm manually. " +
      "Also responds to: install_dependencies, install_packages.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Optional sub-directory within the workspace. Defaults to workspace root.",
        },
      },
      required: [],
    },
  },
  {
    name: "todo_write",
    description: "Manage your task list. ONE todo in_progress at a time. Use instead of PLAN.md.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "Full task list — always pass the complete list, not just changed items.",
          items: {
            type: "object",
            properties: {
              id:      { type: "string", description: "Unique ID (e.g. '1', '2', '3')" },
              content: { type: "string", description: "Task description (imperative: 'Install deps', 'Create game.py')" },
              status:  { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
            },
            required: ["id", "content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
  {
    name: "apply_patch",
    description: "Patch multiple files at once. Uses fuzzy matching (whitespace differences OK).",
    parameters: {
      type: "object",
      properties: {
        patches: {
          type: "array",
          description: "List of patch operations to apply sequentially.",
          items: {
            type: "object",
            properties: {
              path:       { type: "string", description: "File path to patch." },
              old_string: { type: "string", description: "String to find (fuzzy-matched)." },
              new_string: { type: "string", description: "Replacement string." },
            },
            required: ["path", "old_string", "new_string"],
          },
        },
      },
      required: ["patches"],
    },
  },
  {
    name: "web_fetch",
    description: "Fetch a URL and return its content as plain text (HTML tags stripped).",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch (must start with https:// or http://)." },
      },
      required: ["url"],
    },
  },
  {
    name: "create_folder",
    description:
      "Create a directory (and all parent directories) at an absolute OS path. Use this to scaffold new project folder structures on the user's machine. Requires Tauri desktop mode.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to create, e.g. C:/Users/user/Documents/MyProject/src",
        },
      },
      required: ["path"],
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
  {
    name: "switch_model",
    description: "Switch the app's active Ollama model. Use when the user asks to change models, or when a different model would suit the current task better.",
    parameters: {
      type: "object",
      properties: {
        model: { type: "string", description: "Name of an already-pulled Ollama model to switch to (must match an available model exactly)." },
      },
      required: ["model"],
    },
  },
  {
    name: "switch_view",
    description: "Navigate the user's UI to a different tab/view of the app.",
    parameters: {
      type: "object",
      properties: {
        view: { type: "string", enum: APP_VIEWS, description: "The tab to switch to." },
      },
      required: ["view"],
    },
  },
  {
    name: "send_task_to_tab",
    description: "Queue a task description for the agent in another tab to pick up later. Does not switch the user's view or run anything immediately — the user (or that tab's agent) starts it from a banner.",
    parameters: {
      type: "object",
      properties: {
        target_view: { type: "string", enum: APP_VIEWS, description: "The tab the task is intended for." },
        task: { type: "string", description: "Description of the task for that tab's agent to perform." },
      },
      required: ["target_view", "task"],
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
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", ".next", "__pycache__",
  // Python virtual environments — all common names
  ".venv", "venv", "env", ".env", "myenv", "virtualenv", ".virtualenv",
  // Build artifacts
  "build", "coverage", "target", ".localmind-backups",
]);

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
export function resolvePathParts(path: string): string[] {
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

export function normalizeSubPath(p: string): string {
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

// ─── Fuzzy patch matcher (inspired by OpenCode's 9-tier Edit strategy) ───────

/**
 * Find oldString in content using progressively looser matching.
 * Returns [matchStart, matchEnd] character positions, or null if not found.
 *
 * Tiers (stops at first match):
 *   1. Exact string match
 *   2. After CRLF → LF normalization
 *   3. Line-trimmed match (ignore trailing whitespace per line)
 *   4. Indentation-flexible match (ignore leading whitespace per line)
 *   5. Whitespace-normalized match (collapse all whitespace sequences)
 */
function fuzzyFindMatch(content: string, oldString: string): [number, number] | null {
  // Tier 1 — exact
  let idx = content.indexOf(oldString);
  if (idx !== -1) return [idx, idx + oldString.length];

  // Normalize line endings for all remaining tiers
  const nl = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const nc = nl(content);
  const no = nl(oldString);

  // Tier 2 — exact after CRLF normalization
  idx = nc.indexOf(no);
  if (idx !== -1) return [idx, idx + no.length];

  const ncLines = nc.split("\n");
  const noLines = no.split("\n");
  const len = noLines.length;

  /** Compute [charStart, charEnd] for a matched window starting at line i. */
  function lineRange(i: number): [number, number] {
    let start = 0;
    for (let k = 0; k < i; k++) start += ncLines[k].length + 1;
    let end = start;
    for (let k = i; k < i + len; k++) end += ncLines[k].length + 1;
    return [start, Math.min(end, nc.length)]; // end may overshoot by 1 newline
  }

  // Tier 3 — trim trailing whitespace per line
  const trailingTrimmed = noLines.map((l) => l.trimEnd());
  for (let i = 0; i <= ncLines.length - len; i++) {
    if (ncLines.slice(i, i + len).map((l) => l.trimEnd())
        .every((l, j) => l === trailingTrimmed[j])) {
      return lineRange(i);
    }
  }

  // Tier 4 — strip leading whitespace per line (indentation-flexible)
  const deindented = noLines.map((l) => l.trimStart());
  for (let i = 0; i <= ncLines.length - len; i++) {
    if (ncLines.slice(i, i + len).map((l) => l.trimStart())
        .every((l, j) => l === deindented[j])) {
      return lineRange(i);
    }
  }

  // Tier 5 — collapse all whitespace (whitespace-normalized)
  const wsNorm = (s: string) => s.replace(/\s+/g, " ").trim();
  const normOld = wsNorm(no);
  for (let i = 0; i <= ncLines.length - len; i++) {
    const windowNorm = wsNorm(ncLines.slice(i, i + len).join("\n"));
    if (windowNorm === normOld) return lineRange(i);
  }

  return null;
}

// ─── Executor ────────────────────────────────────────────────────────────────

export async function executeTool(
  call: ToolCall,
  dirHandle: FileSystemDirectoryHandle | null,
  workspacePath?: string   // fallback cwd for run_command when model omits it
): Promise<ToolResult> {
  try {
    // ── Normalize tool names — models often hallucinate close-but-wrong names ──
    const TOOL_ALIASES: Record<string, string> = {
      install_dependencies: "install_deps",
      install_dependency: "install_deps",
      install_packages: "install_deps",
      write_to_file: "write_file",
      create_file: "write_file",
      save_file: "write_file",
      search_web: "web_search",
      google: "web_search",
      search: "web_search",
      fetch_url: "web_fetch",
      fetch: "web_fetch",
      search_files: "grep_files",
      grep: "grep_files",
      find_in_files: "grep_files",
      find: "find_files",
      ls: "list_directory",
      list: "list_directory",
      read: "read_file",
      write: "write_file",
      cat: "read_file",
      run: "run_command",
      shell: "run_command",
      exec: "run_command",
      execute: "run_command",
      bash: "run_command",
      mkdir: "create_folder",
      make_dir: "create_folder",
      create_directory: "create_folder",
      create_dir: "create_folder",
    };
    if (TOOL_ALIASES[call.name]) {
      call = { ...call, name: TOOL_ALIASES[call.name] };
    }

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
        const path = argStr(call.args["path"]) || argStr(call.args["file_path"]) || argStr(call.args["filename"]);
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
        // Accept file_path as alias for path (models sometimes use the wrong param name)
        const path = argStr(call.args["path"]) || argStr(call.args["file_path"]) || argStr(call.args["filename"]);
        const content = argStr(call.args["content"]) || argStr(call.args["text"]) || argStr(call.args["code"]);
        if (!path) throw new Error("Missing path argument (expected 'path', 'file_path', or 'filename')");
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
        // When overwriting an existing file, remind the model that patch_file is preferred for future edits.
        const overwriteHint = backupPath
          ? `\nNote: You overwrote an existing file. For future fixes use patch_file — it edits only the changed lines and is less likely to introduce new bugs.`
          : "";
        return {
          toolCallId: call.id,
          name: call.name,
          output: `${verb}: ${path}${backupNote}${overwriteHint}`,
        };
      }

      case "patch_file": {
        if (!dirHandle) return noWorkspace(call);
        const path = argStr(call.args["path"]);
        const oldString = call.args["old_string"] != null ? String(call.args["old_string"]) : null;
        const newString = call.args["new_string"] != null ? String(call.args["new_string"]) : "";
        const replaceAll = Boolean(call.args["replace_all"]);

        if (!path) throw new Error("Missing path argument");
        if (oldString === null) throw new Error("Missing old_string argument");

        const patchParts = resolvePathParts(path);
        const patchFileName = patchParts.pop()!;
        let patchParent = dirHandle;
        if (patchParts.length > 0) {
          const resolved = await resolveDirHandle(dirHandle, patchParts);
          if (!resolved) throw new Error(`Directory not found: ${patchParts.join("/")}`);
          patchParent = resolved;
        }
        const patchHandle = await patchParent.getFileHandle(patchFileName, { create: false });
        const patchFileObj = await patchHandle.getFile();
        const original = await patchFileObj.text();

        // Use fuzzy matcher — handles trailing whitespace, CRLF, indentation differences
        const fuzzyMatch = fuzzyFindMatch(original, oldString);
        if (!fuzzyMatch) {
          return {
            toolCallId: call.id,
            name: call.name,
            output: "",
            error: `patch_file: old_string not found in ${path} (tried exact, CRLF-normalized, line-trimmed, indentation-flexible, and whitespace-normalized matching). Re-read the file with read_file to get the exact current content.`,
          };
        }

        let patched: string;
        if (replaceAll) {
          // For replace_all, use split/join on normalized content
          patched = original.split(oldString).join(newString);
          if (patched === original) {
            // Try with normalized line endings
            patched = original.replace(/\r\n/g, "\n").split(oldString.replace(/\r\n/g, "\n")).join(newString);
          }
        } else {
          const [ms, me] = fuzzyMatch;
          patched = original.slice(0, ms) + newString + original.slice(me);
        }

        const patchWritable = await patchHandle.createWritable();
        await patchWritable.write(patched);
        await patchWritable.close();

        return {
          toolCallId: call.id,
          name: call.name,
          output: `Patched ${path}.`,
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

        // Fall back to workspace path so commands always run in the right directory
        // even when the model forgets to pass cwd (a common failure mode).
        const cwd = argStr(call.args["cwd"]) || workspacePath || undefined;
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
        const exitNote = `[exit code: ${result.exit_code}]`;
        return {
          toolCallId: call.id,
          name: call.name,
          output: combined ? `${combined}\n\n${exitNote}` : exitNote,
          // Only flag as a tool error when the command produced NO output at all —
          // a non-zero exit WITH output (test failure, lint error) is a result the
          // model should read, not a tool failure.
          ...(result.exit_code !== 0 && !combined
            ? { error: `Command failed with exit code ${result.exit_code} and produced no output` }
            : {}),
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

      case "switch_model": {
        const model = argStr(call.args["model"]);
        if (!model) throw new Error("Missing model argument");
        const available = useChatStore.getState().availableModels;
        if (!available.includes(model)) {
          return {
            toolCallId: call.id,
            name: call.name,
            output: `"${model}" is not in the available models list.`,
            error: `Model not found. Available models: ${available.join(", ") || "(none)"}`,
          };
        }
        useModelSelectionStore.getState().setSelectedModel(model);
        return {
          toolCallId: call.id,
          name: call.name,
          output: `Switched active model to "${model}".`,
        };
      }

      case "switch_view": {
        const view = argStr(call.args["view"]) as AppView;
        if (!APP_VIEWS.includes(view)) {
          return {
            toolCallId: call.id,
            name: call.name,
            output: `"${view}" is not a valid view.`,
            error: `Invalid view. Valid views: ${APP_VIEWS.join(", ")}`,
          };
        }
        useAppViewStore.getState().setView(view);
        return {
          toolCallId: call.id,
          name: call.name,
          output: `Switched view to "${view}".`,
        };
      }

      case "send_task_to_tab": {
        const targetView = argStr(call.args["target_view"]) as AppView;
        const task = argStr(call.args["task"]);
        if (!APP_VIEWS.includes(targetView)) {
          return {
            toolCallId: call.id,
            name: call.name,
            output: `"${targetView}" is not a valid view.`,
            error: `Invalid target_view. Valid views: ${APP_VIEWS.join(", ")}`,
          };
        }
        if (!task) throw new Error("Missing task argument");
        const sourceView = useAppViewStore.getState().view;
        const id = useTaskQueueStore.getState().enqueue(targetView, task, sourceView);
        return {
          toolCallId: call.id,
          name: call.name,
          output: `Queued task ${id} for the "${targetView}" tab: "${task}"`,
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

      case "install_deps": {
        const subPath = normalizeSubPath(argStr(call.args["path"]));
        const cwdParts = subPath ? subPath.split("/").filter(Boolean) : [];

        // ── Check project memory first — skip if already installed ────────────
        if (dirHandle) {
          const mem = await readProjectMemory(dirHandle);
          if (mem.includes("## Dependencies") && mem.includes("Status: installed")) {
            return {
              toolCallId: call.id,
              name: call.name,
              output: "Dependencies already installed (recorded in project memory).\nSkip this step — proceed to the next unchecked item in PLAN.md.",
            };
          }
        }

        // ── Detect manifest file ──────────────────────────────────────────────
        const checkFile = async (name: string): Promise<boolean> => {
          if (!dirHandle) return false;
          let handle = dirHandle;
          for (const part of cwdParts) {
            try { handle = await handle.getDirectoryHandle(part, { create: false }); } catch { return false; }
          }
          try { await handle.getFileHandle(name, { create: false }); return true; } catch { return false; }
        };

        const [hasReqs, hasPkg, hasCargo, hasPyproject] = await Promise.all([
          checkFile("requirements.txt"),
          checkFile("package.json"),
          checkFile("Cargo.toml"),
          checkFile("pyproject.toml"),
        ]);

        let cmd = "";
        let manifest = "";
        if (hasReqs)           { cmd = "pip install -r requirements.txt"; manifest = "requirements.txt"; }
        else if (hasPkg)       { cmd = "npm install";                     manifest = "package.json"; }
        else if (hasCargo)     { cmd = "cargo build";                     manifest = "Cargo.toml"; }
        else if (hasPyproject) { cmd = "pip install -e .";                manifest = "pyproject.toml"; }
        else {
          return {
            toolCallId: call.id, name: call.name, output: "",
            error: "No manifest found (requirements.txt, package.json, Cargo.toml, pyproject.toml).",
          };
        }

        const tauri = (window as unknown as Record<string, unknown>).__TAURI__;
        if (!tauri) {
          return { toolCallId: call.id, name: call.name, output: `Would run: ${cmd}`, error: "Not in desktop mode." };
        }

        const cwd: string | undefined = workspacePath || undefined;
        const result = await tauriInvoke<{ stdout: string; stderr: string; exit_code: number }>(
          "run_command", { cmd, cwd }
        );
        const combined = sanitizeOutput([result.stdout, result.stderr].filter(Boolean).join("\n"));

        const hasRealError = result.exit_code !== 0 &&
          !combined.includes("Successfully installed") &&
          combined.includes("ERROR");

        // ── Write install status to project memory on success ─────────────────
        if (!hasRealError && dirHandle) {
          const date = new Date().toISOString().split("T")[0];
          const memContent = `Status: installed\nManifest: ${manifest}\nDate: ${date}`;
          await updateMemorySection(dirHandle, "Dependencies", memContent).catch(() => {});
        }

        return {
          toolCallId: call.id,
          name: call.name,
          output: hasRealError
            ? combined
            : `${combined}\n\n✓ Dependencies installed. Status written to project memory — this step will be skipped in future sessions.`,
          ...(hasRealError ? { error: `Exit code: ${result.exit_code}` } : {}),
        };
      }

      case "todo_write": {
        if (!dirHandle) return noWorkspace(call);
        const rawTodos = call.args["todos"] as Array<Record<string, string>> | undefined;
        if (!Array.isArray(rawTodos)) throw new Error("todos must be an array");

        const lmDir = await dirHandle.getDirectoryHandle(".localmind", { create: true });

        // Read existing todos to protect completed items from being reset.
        // The agent cannot un-complete a task — progress is permanent.
        const existingCompletedIds = new Set<string>();
        try {
          const existingHandle = await lmDir.getFileHandle("todos.json", { create: false });
          const existingFile = await existingHandle.getFile();
          const existingData = JSON.parse(await existingFile.text()) as Array<Record<string, string>>;
          for (const t of existingData) {
            if (t["status"] === "completed") existingCompletedIds.add(t["id"]);
          }
        } catch { /* no existing file — first write */ }

        // Apply rules: protect completed, enforce single in_progress
        let foundInProgress = false;
        let protectedCount = 0;
        const todos = rawTodos.map((t) => {
          // Lock completed items — cannot be reset to pending or in_progress
          if (existingCompletedIds.has(t["id"]) && t["status"] !== "completed") {
            protectedCount++;
            return { ...t, status: "completed" };
          }
          if (t["status"] === "in_progress") {
            if (foundInProgress) return { ...t, status: "pending" };
            foundInProgress = true;
          }
          return t;
        });

        const todoHandle = await lmDir.getFileHandle("todos.json", { create: true });
        const todoWritable = await todoHandle.createWritable();
        await todoWritable.write(JSON.stringify(todos, null, 2));
        await todoWritable.close();

        const done = todos.filter((t) => t["status"] === "completed").length;
        const active = todos.filter((t) => t["status"] === "in_progress").length;
        const pending = todos.filter((t) => t["status"] === "pending").length;

        const protectedNote = protectedCount > 0
          ? ` (${protectedCount} completed item${protectedCount > 1 ? "s" : ""} protected from reset)`
          : "";
        const nextNote = active === 1
          ? ` — now execute the in_progress task, do NOT call todo_write again until it is done`
          : pending > 0
          ? ` — mark one task in_progress and start executing it immediately`
          : "";

        return {
          toolCallId: call.id,
          name: call.name,
          output: `Todos updated: ${todos.length} tasks — ${done} completed, ${active} in progress, ${pending} pending${protectedNote}.${nextNote}`,
        };
      }

      case "apply_patch": {
        if (!dirHandle) return noWorkspace(call);
        const patchOps = call.args["patches"] as Array<{ path: string; old_string: string; new_string: string }> | undefined;
        if (!Array.isArray(patchOps) || patchOps.length === 0) throw new Error("patches must be a non-empty array");

        const results: string[] = [];
        for (const op of patchOps) {
          const opParts = resolvePathParts(op.path);
          const opFile = opParts.pop()!;
          let opParent = dirHandle;
          if (opParts.length > 0) {
            const resolved = await resolveDirHandle(dirHandle, opParts);
            if (!resolved) { results.push(`✗ ${op.path}: directory not found`); continue; }
            opParent = resolved;
          }
          let opHandle: FileSystemFileHandle;
          try { opHandle = await opParent.getFileHandle(opFile, { create: false }); }
          catch { results.push(`✗ ${op.path}: file not found`); continue; }

          const opFObj = await opHandle.getFile();
          const opContent = await opFObj.text();
          const opMatch = fuzzyFindMatch(opContent, op.old_string);
          if (!opMatch) { results.push(`✗ ${op.path}: old_string not found (re-read the file)`); continue; }

          const [opS, opE] = opMatch;
          const opPatched = opContent.slice(0, opS) + op.new_string + opContent.slice(opE);
          const opWr = await opHandle.createWritable();
          await opWr.write(opPatched);
          await opWr.close();
          results.push(`✓ ${op.path}`);
        }

        const failed = results.filter((r) => r.startsWith("✗")).length;
        return {
          toolCallId: call.id,
          name: call.name,
          output: results.join("\n"),
          ...(failed > 0 ? { error: `${failed} patch${failed !== 1 ? "es" : ""} failed` } : {}),
        };
      }

      case "web_fetch": {
        const fetchUrl = argStr(call.args["url"]);
        if (!fetchUrl) throw new Error("Missing url argument");
        if (!fetchUrl.startsWith("http://") && !fetchUrl.startsWith("https://")) {
          throw new Error("url must start with http:// or https://");
        }
        let fetchRes: Response;
        try {
          fetchRes = await fetch(fetchUrl, {
            headers: { "User-Agent": "LocalMind-Agent/1.0" },
            signal: AbortSignal.timeout(20000),
          });
        } catch (err) {
          throw new Error(`Fetch failed: ${(err as Error).message}`);
        }
        if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}: ${fetchRes.statusText}`);

        let fetchText = await fetchRes.text();
        const ct = fetchRes.headers.get("content-type") ?? "";
        if (ct.includes("html")) {
          fetchText = fetchText
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<!--[\s\S]*?-->/g, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
            .replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
        }
        const MAX_FETCH = 12000;
        return {
          toolCallId: call.id,
          name: call.name,
          output: fetchText.length > MAX_FETCH
            ? fetchText.slice(0, MAX_FETCH) + "\n\n…(truncated)"
            : fetchText,
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

      case "create_folder": {
        const folderPath = argStr(call.args["path"]);
        if (!folderPath) throw new Error("Missing path argument");
        await tauriInvoke("fs_mkdir", { path: folderPath });
        return {
          toolCallId: call.id,
          name: call.name,
          output: `Created folder: ${folderPath}`,
        };
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
