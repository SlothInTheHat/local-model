import { evaluate } from "mathjs";
import { searchWeb } from "./search";
import { fileExists, backupFile, readFileFromHandle } from "./fileSystem";
import { mcpCallTool } from "./mcp";
import { useMcpStore } from "../store/mcp";
import { injectGitCredentials, sanitizeOutput } from "../store/profile";
import { loadSkills, saveSkill } from "./skillEngine";
import { saveImprovement } from "./improvements";
import { updateMemorySection, readProjectMemory } from "./projectMemory";
import { addMemory, searchMemory } from "./vectorMemory";
import { saveDynamicTool } from "./dynamicTools";
import type { DynamicToolDef } from "./dynamicTools";
import { APP_VIEWS } from "../types/app";
import type { AppView } from "../types/app";
import { useChatStore } from "../store/chat";
import { useModelSelectionStore } from "../store/modelSelection";
import { useAppViewStore } from "../store/appView";
import { useTaskQueueStore } from "../store/taskQueue";
import { useAgentStore } from "../store/agent";
import { useModelStore } from "../store/models";
import { buildJobSpec, computeInitialNextRun, describeSchedule, normalizeSchedule, parseJobSpec } from "./scheduler";
import { searchSessions } from "./sessionSearch";
import { isTauriEnv } from "./fileSystem";
import { resolveRole } from "./modelRoles";
import { streamChatForModel } from "./chatProvider";

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
  | "get_current_datetime"
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
  | "register_tool"
  | "switch_model"
  | "switch_view"
  | "send_task_to_tab"
  | "transcribe_video"
  | "schedule_task"
  | "list_scheduled"
  | "cancel_scheduled"
  | "spawn_subagent"
  | "propose_feature"
  | "search_past_sessions"
  | "search_knowledge"
  | "list_collections"
  | "read_clipboard"
  | "set_clipboard"
  | "open_application"
  | "list_windows"
  | "focus_window"
  | "take_screenshot";

export interface ToolDef {
  // string allows MCP tools with dynamic "serverId__toolName" names
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  group?: "files" | "shell" | "git" | "web" | "media" | "state" | "app" | "external";
  risk?: "read" | "mutate" | "execute" | "ui";
  /** Allowed in Plan (read-only) mode. */
  planModeAllowed?: boolean;
  /** Needs user approval in Build mode (unless autoApproveAll). */
  requiresApproval?: boolean;
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
    group: "files",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
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
    group: "files",
    risk: "mutate",
    planModeAllowed: false,
    requiresApproval: true,
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
    group: "files",
    risk: "mutate",
    planModeAllowed: false,
    requiresApproval: true,
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
    group: "files",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
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
    group: "state",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
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
    group: "web",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
  },
  {
    name: "search_past_sessions",
    description:
      "Full-text search across past agent sessions and conversations (transcripts). Use to recall earlier decisions/work.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query string." },
        limit: { type: "number", description: "Max results to return. Defaults to 8." },
      },
      required: ["query"],
    },
    group: "state",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
  },
  {
    name: "search_knowledge",
    description:
      "Search the user's ingested class notes / knowledge bases (their uploaded documents) for passages relevant to a query, scoped to a class collection. Returns passages WITH source citations. Use this to answer questions about the user's coursework and ALWAYS cite the returned source locations.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query string." },
        collection: { type: "string", description: "Optional class/collection id to scope the search to, e.g. 'CS101'. Use list_collections to see valid ids." },
        limit: { type: "number", description: "Max passages to return. Defaults to 6." },
      },
      required: ["query"],
    },
    group: "state",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
  },
  {
    name: "list_collections",
    description:
      "List the user's knowledge-base collections (their classes) with how many documents each contains. Use before search_knowledge if unsure which collection to search.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    group: "state",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
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
    group: "files",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
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
    group: "files",
    risk: "mutate",
    planModeAllowed: false,
    requiresApproval: true,
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
    group: "files",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
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
    group: "shell",
    risk: "execute",
    planModeAllowed: false,
    requiresApproval: true,
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
    group: "state",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
  },
  {
    name: "get_current_datetime",
    description:
      "Get the actual real current date and time from the system clock (ISO 8601, plus a human-readable local string and the timezone). ALWAYS use this when a task needs today's real date/time — e.g. appending a timestamp to a file. NEVER guess a date, use a date from your training data, or web_search/web_fetch an external \"current time\" API (those don't exist / aren't reachable and will fail) — this tool is instant, always available, and always correct.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    group: "state",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
  },
  {
    name: "read_clipboard",
    description: "Read the current text contents of the system clipboard.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    group: "state",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
  },
  {
    name: "set_clipboard",
    description: "Write text to the system clipboard, replacing its current contents.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to copy to the clipboard." },
      },
      required: ["text"],
    },
    group: "state",
    risk: "execute",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "open_application",
    description: "Launch an application, file, or URL by name/path using the OS shell (like typing it into Start/Spotlight). Does not resolve or validate the name — the OS handles lookup. On Windows, the display name in the Start menu is often NOT the executable name: use 'mspaint' for Paint, 'calc' for Calculator, 'cmd' for Command Prompt, 'notepad' for Notepad, 'explorer' for File Explorer. If a call fails or the app doesn't appear, retry once with the likely executable name — do not go searching the workspace filesystem for it.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The application name, file path, or URL to open, e.g. 'notepad', 'chrome', 'C:\\path\\to\\file.pdf', 'https://example.com'." },
      },
      required: ["name"],
    },
    group: "state",
    risk: "execute",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "list_windows",
    description: "List visible top-level windows on the desktop, each with a title and a stable id. Use the id with focus_window.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    group: "state",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
  },
  {
    name: "focus_window",
    description: "Bring a window to the foreground (restoring it if minimized) by the id returned from list_windows.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The window id from list_windows." },
      },
      required: ["id"],
    },
    group: "state",
    risk: "execute",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "take_screenshot",
    description: "Capture the primary monitor and analyze what's on screen. Runs a vision model over the capture (when one is installed) plus OCR, and returns a description, the recognized text, and the saved file path.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "What you want to know about the screen. Be specific — this is passed to a vision model that looks at the actual pixels.",
        },
      },
      required: [],
    },
    group: "state",
    risk: "execute",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "git_status",
    description: "Show the working tree status (changed, staged, and untracked files). Use this to understand what has changed in the repo.",
    parameters: { type: "object", properties: {}, required: [] },
    group: "git",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
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
    group: "git",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
  },
  {
    name: "git_log",
    description: "Show the last 20 commits in one-line format.",
    parameters: { type: "object", properties: {}, required: [] },
    group: "git",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
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
    group: "git",
    risk: "mutate",
    planModeAllowed: false,
    requiresApproval: true,
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
    group: "git",
    risk: "mutate",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "save_skill",
    description: "Create and save a reusable skill (a procedural how-to) as a markdown file in the workspace skill registry (.localmind/skills/). THIS is the tool to use whenever the user asks you to make / create / author / save a skill — including building one from a spec or instructions they paste. Also use it on your own after finishing a task to preserve a useful workflow. Provide name, tags (for later discovery), and content (the full markdown instructions). Do not invent any other tool for creating skills — this is the only one.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human-readable skill name, e.g. 'Docker Debugging'." },
        tags: { type: "string", description: "Comma-separated tags for skill discovery, e.g. 'docker,container,debug'." },
        content: { type: "string", description: "Markdown content: step-by-step instructions, commands, and tips." },
      },
      required: ["name", "tags", "content"],
    },
    group: "state",
    risk: "mutate",
    planModeAllowed: true,
    requiresApproval: true,
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
    group: "state",
    risk: "mutate",
    planModeAllowed: true,
    requiresApproval: false,
  },
  {
    name: "save_global_memory",
    description: "Save a durable note to your global, cross-project memory (a semantic store searched and injected automatically in every project). Use for user preferences, recurring facts, or decisions that should be remembered everywhere — not just this workspace. For project-specific notes, use update_project_memory instead.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The memory to save — a concise, self-contained statement." },
        tags: { type: "string", description: "Comma-separated tags to help retrieve this later, e.g. 'preferences,style'." },
      },
      required: ["text"],
    },
    group: "state",
    risk: "mutate",
    planModeAllowed: true,
    requiresApproval: false,
  },
  {
    name: "propose_feature",
    description: "Draft a structured spec for a NEW LocalMind capability you lack and cannot build yourself with register_tool (i.e. it needs app source changes). Saved to .localmind/improvements/ for the user or Claude Code to implement later. Use this instead of refusing or faking a capability. Do NOT use it for things a shell one-liner could do — use register_tool for those.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short imperative title, e.g. 'Resize images in the image editor'." },
        motivation: { type: "string", description: "Why this is needed / what the user was trying to do." },
        proposed_files: { type: "string", description: "Optional: comma-separated files likely involved, if you can guess them." },
        acceptance_criteria: { type: "string", description: "Optional: how you'd know it works." },
        size_guess: { type: "string", description: "Optional rough effort: S, M, or L." },
        details: { type: "string", description: "The detailed spec — approach, edge cases, anything an implementer needs." },
      },
      required: ["title", "motivation"],
    },
    group: "state",
    risk: "mutate",
    planModeAllowed: true,
    requiresApproval: false,
  },
  {
    name: "list_skills",
    description: "List all skills in the workspace skill registry (.localmind/skills/). Returns skill names and tags.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    group: "state",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
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
    group: "shell",
    risk: "execute",
    planModeAllowed: false,
    requiresApproval: true,
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
              // Examples deliberately generic (not a filename/project-specific example): a live
              // trace showed a weak model, mid-task and low on real context, parrot the exact
              // sample text back as a todo/skill name ("Create game.py") — i.e. this field's own
              // schema example became the hijack. Keep examples abstract enough that echoing them
              // verbatim can't plausibly look like a real, unrelated action.
              content: { type: "string", description: "Task description, imperative mood (e.g. 'Add input validation', 'Fix the failing test')" },
              status:  { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
            },
            required: ["id", "content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    group: "state",
    risk: "mutate",
    planModeAllowed: true,
    requiresApproval: false,
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
    group: "files",
    risk: "mutate",
    planModeAllowed: false,
    requiresApproval: true,
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
    group: "web",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
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
    group: "files",
    risk: "mutate",
    // Intentional change from legacy behavior: closes a hole where Plan mode
    // could create directories (it wasn't in the old PLAN_MODE_DENIED set).
    planModeAllowed: false,
    requiresApproval: false,
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
    group: "state",
    risk: "mutate",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "switch_model",
    description: "Switch the app's active Ollama model. ONLY use when the user explicitly asks to change/switch models. Do not switch models on your own initiative just because another might fit better — the user must have asked.",
    parameters: {
      type: "object",
      properties: {
        model: { type: "string", description: "Name of an already-pulled Ollama model to switch to (must match an available model exactly)." },
      },
      required: ["model"],
    },
    group: "app",
    risk: "ui",
    planModeAllowed: true,
    requiresApproval: true,
  },
  {
    name: "switch_view",
    description: "Navigate the user's UI to a different tab. ONLY use when the user explicitly asks to go to / open / show another tab. NEVER use it to 'look something up', to reach a feature, or as a step while answering a question — switching the user's tab unprompted is disruptive. When in doubt, do not switch.",
    parameters: {
      type: "object",
      properties: {
        view: { type: "string", enum: APP_VIEWS, description: "The tab to switch to." },
      },
      required: ["view"],
    },
    group: "app",
    risk: "ui",
    planModeAllowed: true,
    requiresApproval: true,
  },
  {
    name: "send_task_to_tab",
    description: "Queue a task for another tab's agent to pick up later (the user starts it from a banner; nothing runs immediately and the view does not change). ONLY use when the user explicitly asks to hand work to another tab. Do not use it to ask the user to do something or as a way to make progress on the current request.",
    parameters: {
      type: "object",
      properties: {
        target_view: { type: "string", enum: APP_VIEWS, description: "The tab the task is intended for." },
        task: { type: "string", description: "Description of the task for that tab's agent to perform." },
      },
      required: ["target_view", "task"],
    },
    group: "app",
    risk: "ui",
    planModeAllowed: true,
    requiresApproval: true,
  },
  {
    name: "transcribe_video",
    description: "Transcribe a video/audio file OR an online video (YouTube etc.) to text and return the transcript. For URLs it grabs captions when available (fast) and otherwise downloads the audio and transcribes it offline (ffmpeg + faster-whisper). Use this to summarize or 'watch' videos, or to learn/extract skills from them: transcribe, read the transcript, then save reusable skills with save_skill or write a document with write_file. Pass EITHER url (for online videos) OR path (for a file in the workspace). Requires the desktop app with the phone-agent Python pipeline installed.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL of an online video to transcribe (e.g. a YouTube link). Use this for videos on the web." },
        path: { type: "string", description: "Path to a local video/audio file, relative to the workspace root (e.g. 'clips/tutorial.mp4'). Use this instead of url for files already in the workspace." },
        whisper_model: { type: "string", description: "Optional whisper model size used only when audio must be transcribed: base (default, fastest), small, or medium (most accurate)." },
      },
      required: [],
    },
    group: "media",
    risk: "execute",
    planModeAllowed: true,
    requiresApproval: false,
  },
  {
    name: "schedule_task",
    description:
      "Schedule a task to run automatically in the background on a recurring or future basis — even when the user isn't actively chatting ('every morning summarize my improvement queue', 'every 2 minutes append a note'). The task runs as a headless agent in the CURRENT workspace folder, so any files it writes (e.g. notes.md) land in the workspace root. The Rust backend ticks every 30s and fires due jobs, surviving app restarts. ONLY use when the user explicitly asks for something to happen automatically/on a schedule/recurring/unattended — never schedule work on your own initiative.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The instruction for the scheduled agent run to execute, in natural English — NEVER shell code or commands. Examples: 'append the current date and time to notes.md', 'summarize my improvement queue and write to status.md'. Bad: 'echo $(date) >> file', 'date >> file', 'Get-Date'. The scheduled agent runs on the user's platform and will emit the correct commands; your job is to describe the goal in plain English.",
        },
        schedule: {
          type: "string",
          description: "Schedule descriptor. One of: 'interval:<seconds>' (e.g. 'interval:3600' for hourly, 'interval:120' for every 2 minutes), 'cron:<5-field-expr>' (e.g. 'cron:0 8 * * *' for 8am daily), or 'once:<unix_seconds>' for a single future run at that Unix timestamp (seconds).",
        },
      },
      required: ["task", "schedule"],
    },
    group: "state",
    risk: "mutate",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "list_scheduled",
    description: "List all scheduled background jobs (active, done, or cancelled), including each job's task text, schedule, status, and next run time.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    group: "state",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
  },
  {
    name: "cancel_scheduled",
    description: "Cancel (permanently delete) a previously scheduled background job by id. Use list_scheduled first to find the id.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The job id, from list_scheduled." },
      },
      required: ["id"],
    },
    group: "state",
    risk: "mutate",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "spawn_subagent",
    description:
      "Delegate a sub-task to a separate, autonomous headless agent session that runs against the current workspace and reports back its result. Use this to fan out an independent chunk of work (e.g. 'summarize this directory', 'analyze src/ and report structure') without consuming your own context on it. The subagent gets read-only tools (read_file, list_directory, grep_files, find_files, web_search, web_fetch, get_system_info, git_status, git_diff, git_log, list_skills, calculator) — it can investigate but cannot write/delete files or run shell commands, and it cannot spawn further subagents. Requires an open workspace.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "The sub-task instruction for the subagent to carry out." },
        model: { type: "string", description: "Optional model name to run the subagent with. Defaults to the current active model." },
      },
      required: ["task"],
    },
    group: "state",
    risk: "execute",
    planModeAllowed: false,
    requiresApproval: true,
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

/** Common wrong tool names local models emit → the real name. */
const TOOL_ALIASES: Record<string, string> = {
  install_dependencies: "install_deps", install_dependency: "install_deps", install_packages: "install_deps",
  write_to_file: "write_file", create_file: "write_file", save_file: "write_file",
  search_web: "web_search", google: "web_search", search: "web_search",
  fetch_url: "web_fetch", fetch: "web_fetch",
  search_files: "grep_files", grep: "grep_files", find_in_files: "grep_files",
  find: "find_files", ls: "list_directory", list: "list_directory",
  read: "read_file", write: "write_file", cat: "read_file",
  run: "run_command", shell: "run_command", exec: "run_command", execute: "run_command", bash: "run_command",
  transcribe: "transcribe_video", transcribe_audio: "transcribe_video",
  mkdir: "create_folder", make_dir: "create_folder", create_directory: "create_folder", create_dir: "create_folder",
  // scheduler / self-improvement — models frequently hyphenate these
  schedule: "schedule_task", create_task: "schedule_task", add_task: "schedule_task",
};

let _knownToolNames: Set<string> | null = null;
/** Lazily built (avoids module-load TDZ) set of all built-in tool names. */
function knownToolNames(): Set<string> {
  if (!_knownToolNames) _knownToolNames = new Set(TOOL_DEFINITIONS.map((t) => t.name));
  return _knownToolNames;
}

/**
 * Canonicalize a model-emitted tool name to a real built-in name. Handles
 * exact matches, common aliases, and — crucially for weak local models — the
 * very common "schedule-task"/"read-file" HYPHENATION of underscore names.
 * Returns "" for an empty/blank name. MCP names (containing "__") pass through
 * untouched. Unknown names are returned as-is for downstream error handling.
 */
export function canonicalToolName(rawName: string): string {
  const name = (rawName ?? "").trim();
  if (!name) return "";
  if (name.includes("__")) return name; // MCP tool — leave as-is
  const known = knownToolNames();
  if (known.has(name)) return name;
  if (TOOL_ALIASES[name]) return TOOL_ALIASES[name];
  const underscored = name.replace(/-/g, "_");
  if (known.has(underscored)) return underscored;
  if (TOOL_ALIASES[underscored]) return TOOL_ALIASES[underscored];
  return name;
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
  // Empty old_string has no anchor to match against — weak models reach for
  // this to mean "just insert this text" (their mental model of "append").
  // JS's String.indexOf("") always returns 0, so Tier 1 below would silently
  // "match" position [0,0] and the caller's slice(0,ms)+new+slice(me) would
  // PREPEND new content at the very START of the file instead of appending —
  // no error, hadSideEffects still fires, but the write lands in the wrong
  // place (looks like "nothing happened" to a user checking the end of the
  // file for a new line). Treat an empty anchor as an explicit append-to-end.
  if (oldString === "") return [content.length, content.length];

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
    // ── Guard empty/malformed tool calls (weak models emit {name:"",...}) ────
    if (!call.name || !call.name.trim()) {
      return {
        toolCallId: call.id, name: call.name ?? "", output: "",
        error: "Empty tool call — no tool name was provided. Emit a valid tool call using one of the tools in your system prompt (e.g. schedule_task, write_file), or reply with plain text.",
      };
    }
    // ── Normalize tool names (aliases + hyphen→underscore) ───────────────────
    const canonical = canonicalToolName(call.name);
    if (canonical && canonical !== call.name) {
      call = { ...call, name: canonical };
    }

    // ── MCP dispatch: names are prefixed "serverId__toolName" ────────────────
    if (call.name.includes("__")) {
      const sep = call.name.indexOf("__");
      const serverId = call.name.slice(0, sep);
      const realName = call.name.slice(sep + 2);
      const servers = useMcpStore.getState().servers;
      let server = servers.find((s) => s.id === serverId);
      // Fallback: the prefix may be a STALE server id — e.g. the server was
      // removed and re-added (getting a new uuid) while an older tool name
      // lingers in conversation history and the model parrots it. Route by the
      // real tool name to any connected server that actually exposes it, so
      // re-adding a server doesn't force the user to start a fresh chat.
      if (!server) {
        server = servers.find(
          (s) => s.status === "connected" && (s.tools ?? []).some((t) => t.name === `${s.id}__${realName}`)
        );
      }
      if (!server) {
        return { toolCallId: call.id, name: call.name, output: "", error: `MCP server '${serverId}' not found` };
      }
      // Reconstruct with the resolved server's id so mcpCallTool strips the
      // prefix correctly (it keys off the server's CURRENT id, not the name's).
      const output = await mcpCallTool(server, `${server.id}__${realName}`, call.args);
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

      case "search_past_sessions": {
        const query = argStr(call.args["query"]);
        if (!query) throw new Error("Missing query argument");
        const limitArg = call.args["limit"];
        const limit = typeof limitArg === "number" && limitArg > 0 ? Math.floor(limitArg) : 8;
        const hits = await searchSessions(query, limit);
        const output = hits.length === 0
          ? "No matching past sessions."
          : hits
              .map((h, i) => {
                const date = new Date(h.created_at).toLocaleString();
                return `${i + 1}. [${h.origin}] ${h.task} (${date}, ${h.outcome})\n   ${h.snippet}`;
              })
              .join("\n\n");
        return { toolCallId: call.id, name: call.name, output };
      }

      case "search_knowledge": {
        const query = argStr(call.args["query"]);
        if (!query) throw new Error("Missing query argument");
        const collection = argStr(call.args["collection"]) || undefined;
        const limitArg = call.args["limit"];
        const limit = typeof limitArg === "number" && limitArg > 0 ? Math.floor(limitArg) : 6;
        const hits = await searchMemory(query, limit, 0.3, { collection, includeKnowledge: true });
        const output = hits.length === 0
          ? "No matching passages found in the user's notes."
          : hits
              .map(({ entry }, i) => {
                const anchor = `[${[entry.collection, entry.sourceUri].filter(Boolean).join("/")}${entry.location ? " " + entry.location : ""}]`;
                return `${i + 1}. ${anchor} ${entry.text}`;
              })
              .join("\n\n");
        return { toolCallId: call.id, name: call.name, output };
      }

      case "list_collections": {
        let collections: Array<{ id: string; label: string; created_at: number; doc_count: number }> = [];
        try {
          collections = await tauriInvoke("collections_all");
        } catch {
          // Not in Tauri desktop mode, or no backend support yet — treat as empty.
          collections = [];
        }
        const output = collections.length === 0
          ? "No knowledge collections yet."
          : collections
              .map((c, i) => `${i + 1}. ${c.label || c.id} (${c.doc_count} docs)`)
              .join("\n");
        return { toolCallId: call.id, name: call.name, output };
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
        if (replaceAll && oldString !== "") {
          // For replace_all, use split/join on normalized content. Guarded
          // against oldString === "" above: JS splits an empty separator
          // between EVERY character, which would interleave newString across
          // the whole file instead of the single append fuzzyFindMatch
          // resolves it to (see the empty-old_string case there) — replace_all
          // has no sane meaning for "replace every occurrence of nothing".
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

      case "get_current_datetime": {
        const now = new Date();
        const info = {
          iso: now.toISOString(),
          local: now.toLocaleString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          unix_seconds: Math.floor(now.getTime() / 1000),
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

      case "save_global_memory": {
        const text = argStr(call.args["text"]);
        const tagsStr = argStr(call.args["tags"]);
        if (!text) throw new Error("Missing text");
        const tags = tagsStr.split(",").map((t) => t.trim()).filter(Boolean);
        await addMemory(text, tags, "agent");
        return {
          toolCallId: call.id,
          name: call.name,
          output: `Saved to global memory: "${text}"`,
        };
      }

      case "propose_feature": {
        if (!dirHandle) return noWorkspace(call);
        const title = argStr(call.args["title"]);
        if (!title) throw new Error("Missing title");
        const path = await saveImprovement(dirHandle, {
          title,
          motivation: argStr(call.args["motivation"]),
          proposed_files: argStr(call.args["proposed_files"]),
          acceptance_criteria: argStr(call.args["acceptance_criteria"]),
          size_guess: argStr(call.args["size_guess"]),
          body: argStr(call.args["details"]),
        });
        return {
          toolCallId: call.id,
          name: call.name,
          output: `Feature proposal drafted → ${path}. The user can review it in Settings → Feature proposals, or hand it to Claude Code to implement.`,
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
        // Resolve relative paths against the workspace root so the folder lands
        // inside the confined root (fs_mkdir refuses paths outside it). Absolute
        // paths (already under the root) are passed through unchanged.
        const isAbsolute = /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(folderPath);
        const targetPath = isAbsolute || !workspacePath
          ? folderPath
          : `${workspacePath.replace(/[\\/]+$/, "")}/${normalizeSubPath(folderPath)}`;
        await tauriInvoke("fs_mkdir", { path: targetPath });
        return {
          toolCallId: call.id,
          name: call.name,
          output: `Created folder: ${targetPath}`,
        };
      }

      case "transcribe_video": {
        const url = argStr(call.args["url"]).trim();
        const whisperModel = argStr(call.args["whisper_model"]) || undefined;
        let target: string;
        let label: string;
        if (url) {
          target = url;
          label = url;
        } else {
          const relPath = normalizeSubPath(argStr(call.args["path"]));
          if (!relPath) throw new Error("Provide a url (online video) or path (workspace file) to transcribe.");
          if (!workspacePath) {
            throw new Error("Transcribing a local file requires the desktop app with an open workspace folder (needs the real file path). For online videos, pass url instead.");
          }
          target = `${workspacePath}/${relPath}`;
          label = relPath;
        }
        const transcript = await tauriInvoke<string>("transcribe_video", {
          videoPath: target,
          whisperModel,
        });
        return {
          toolCallId: call.id,
          name: call.name,
          output: `Transcript of ${label}:\n\n${transcript}`,
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

      case "schedule_task": {
        // Accept the many arg names / formats weak models emit.
        const task = argStr(call.args["task"]) || argStr(call.args["task_name"]) || argStr(call.args["name"]) || argStr(call.args["description"]) || argStr(call.args["prompt"]);
        const rawSchedule = argStr(call.args["schedule"]) || argStr(call.args["interval"]) || argStr(call.args["every"]) || argStr(call.args["cron"]) || argStr(call.args["when"]) || argStr(call.args["frequency"]);
        if (!task) throw new Error("Missing task — provide 'task' as a natural-language instruction (e.g. 'append the current time to notes.md').");
        if (!rawSchedule) throw new Error("Missing schedule — provide 'schedule' like 'interval:120', '2m', 'every 2 minutes', or a cron expression.");
        const schedule = normalizeSchedule(rawSchedule);
        const spec = buildJobSpec(task, schedule);
        // Idempotency: if an identical active job already exists, don't create a
        // duplicate. Weak models sometimes re-emit schedule_task across rounds
        // (or a completion-review nudge re-triggers it); scheduling the same
        // thing twice is virtually never intended and would multiply the job's
        // side effects. Return the existing job instead of stacking duplicates.
        try {
          const existing = await tauriInvoke<Array<{ id: string; spec: string; status: string }>>("jobs_list", {});
          const dup = existing.find((j) => j.status === "active" && j.spec === spec);
          if (dup) {
            return {
              toolCallId: call.id,
              name: call.name,
              output: `Already scheduled: "${task}" (${describeSchedule(schedule)}) is active as job ${dup.id}. No duplicate was created — this task is done.`,
            };
          }
        } catch {
          // jobs_list unavailable (non-Tauri / older backend) — fall through and insert.
        }
        const id = crypto.randomUUID();
        const nextRunAt = computeInitialNextRun(schedule);
        await tauriInvoke("jobs_insert", { id, spec, nextRunAt, status: "active" });
        return {
          toolCallId: call.id,
          name: call.name,
          output: `Scheduled: "${task}" (${describeSchedule(schedule)}). Job id: ${id}. This task is now done — do not schedule it again.`,
        };
      }

      case "list_scheduled": {
        const jobs = await tauriInvoke<
          Array<{ id: string; spec: string; next_run_at: number; status: string; created_at: number }>
        >("jobs_list", {});
        if (jobs.length === 0) {
          return { toolCallId: call.id, name: call.name, output: "No scheduled jobs." };
        }
        const lines = jobs.map((j) => {
          const parsed = parseJobSpec(j.spec);
          const taskText = parsed?.task ?? "(unparseable spec)";
          const scheduleText = parsed ? describeSchedule(parsed.schedule) : "?";
          const nextRun = new Date(j.next_run_at).toLocaleString();
          return `- [${j.status}] ${j.id}: "${taskText}" — ${scheduleText} — next: ${nextRun}`;
        });
        return { toolCallId: call.id, name: call.name, output: lines.join("\n") };
      }

      case "cancel_scheduled": {
        const id = argStr(call.args["id"]);
        if (!id) throw new Error("Missing id argument");
        await tauriInvoke("jobs_cancel", { id });
        return { toolCallId: call.id, name: call.name, output: `Cancelled scheduled job: ${id}` };
      }

      case "spawn_subagent": {
        const subWorkspacePath = useAgentStore.getState().workspacePath ?? workspacePath;
        if (!subWorkspacePath) {
          throw new Error("spawn_subagent requires an open workspace — ask the user to open a folder first.");
        }
        const subTask = argStr(call.args["task"]);
        if (!subTask) throw new Error("Missing task argument");
        const subModel = argStr(call.args["model"]) || useModelSelectionStore.getState().selectedModel;
        if (!subModel) throw new Error("No model specified and no default model is selected.");
        const subHardware = useModelStore.getState().hardware;

        // Dynamic import avoids a static circular dependency (headlessRunner.ts
        // imports TOOL_DEFINITIONS from this file).
        const { runHeadlessTask, HEADLESS_DEFAULT_ALLOWLIST } = await import("./headlessRunner");

        const { record, transcript } = await runHeadlessTask({
          workspacePath: subWorkspacePath,
          modelRef: subModel,
          task: subTask,
          hardware: subHardware,
          origin: "subagent",
          agentBuildMode: true,
          // Read-only allowlist: subagents can investigate but not mutate the
          // workspace, run shell commands, or spawn further subagents (see
          // HEADLESS_EXCLUDED_TOOLS in headlessRunner.ts for the recursion guard).
          toolAllowlist: HEADLESS_DEFAULT_ALLOWLIST,
        });

        const trimmedTranscript = transcript.trim().slice(0, 4000);
        return {
          toolCallId: call.id,
          name: call.name,
          output:
            `Subagent (${subModel}) finished — outcome: ${record.outcome}, ${record.roundsUsed} round(s).\n\n` +
            `Summary: ${record.summary}\n\n` +
            `Transcript:\n${trimmedTranscript}${transcript.trim().length > 4000 ? "\n\n…(truncated)" : ""}`,
        };
      }

      case "read_clipboard": {
        if (!isTauriEnv()) throw new Error("Not in Tauri desktop mode — launch with npm run tauri dev");
        const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
        const text = await readText();
        return {
          toolCallId: call.id,
          name: call.name,
          output: text || "(clipboard is empty)",
        };
      }

      case "set_clipboard": {
        if (!isTauriEnv()) throw new Error("Not in Tauri desktop mode — launch with npm run tauri dev");
        const text = argStr(call.args["text"]);
        if (!text) throw new Error("Missing text argument");
        const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
        await writeText(text);
        return {
          toolCallId: call.id,
          name: call.name,
          output: "Copied text to clipboard.",
        };
      }

      case "open_application": {
        const name = argStr(call.args["name"]);
        if (!name) throw new Error("Missing name argument");
        const output = await tauriInvoke<string>("open_application", { name });
        return {
          toolCallId: call.id,
          name: call.name,
          output,
        };
      }

      case "list_windows": {
        const windows = await tauriInvoke<{ id: string; title: string }[]>("list_windows");
        const output = windows.length
          ? windows.map((w, i) => `${i + 1}. ${w.title} [${w.id}]`).join("\n")
          : "(no visible windows found)";
        return {
          toolCallId: call.id,
          name: call.name,
          output,
        };
      }

      case "focus_window": {
        const id = argStr(call.args["id"]);
        if (!id) throw new Error("Missing id argument");
        const output = await tauriInvoke<string>("focus_window", { id });
        return {
          toolCallId: call.id,
          name: call.name,
          output,
        };
      }

      case "take_screenshot": {
        const result = await tauriInvoke<{ path: string; ocr_text: string; ocr_available: boolean }>(
          "take_screenshot"
        );
        const question = argStr(call.args["question"]);

        const ocrMaxLen = 4000;
        const ocrTruncated = result.ocr_text.length > ocrMaxLen;
        const ocrText = ocrTruncated
          ? `${result.ocr_text.slice(0, ocrMaxLen)}\n\n…(OCR text truncated, ${result.ocr_text.length} chars total)`
          : result.ocr_text;

        // WP6.2b — vision sub-call. The primary model never sees the image;
        // this tool looks at the pixels itself (via the `vision` role) and
        // hands back text, so it works with any primary model and requires
        // no change to the text-only agent-loop tool-result protocol.
        const visionModel = resolveRole("vision");
        let visionSection: string;

        if (!visionModel) {
          visionSection =
            "(No vision model installed — this answer is based on OCR text only, which is unreliable for math, diagrams, and dense UI. Install one with: ollama pull llava)";
        } else {
          try {
            // maxDim tradeoff: higher = better small-glyph/digit accuracy for
            // math screenshots (the driving use case) at the cost of more
            // input tokens and latency per vision call. Bumped from 1568 to
            // 2048 after a user report of the vision model misreading numbers.
            const imageB64 = await tauriInvoke<string>("read_image_base64", {
              path: result.path,
              maxDim: 2048,
            });
            const basePrompt = question
              ? question
              : "Describe everything visible on this screen in detail, including all text, equations, code, and UI elements. Transcribe text exactly.";
            const prompt = `${basePrompt} Transcribe any mathematics, code, or numbers exactly as written.`;

            const visionMaxLen = 4000;
            let visionText = "";
            for await (const chunk of streamChatForModel(visionModel, [
              { role: "user", content: prompt, images: [imageB64] },
            ])) {
              visionText += chunk;
              if (visionText.length > visionMaxLen) break;
            }
            // An empty response is a real, observed failure mode here (a
            // model can stream zero tokens and "succeed"), and rendering it
            // as a blank description would read as "the screen is empty"
            // rather than "the vision call produced nothing".
            const trimmedVision = visionText.trim();
            visionSection = trimmedVision
              ? `[Screen description — from vision model ${visionModel}]\n${trimmedVision}`
              : `(Vision model ${visionModel} returned an empty response — falling back to OCR text only, which is unreliable for math, diagrams, and dense UI.)`;
          } catch (err) {
            // Never let a vision-model hiccup (not loaded, OOM, network) fail
            // the whole tool — degrade to OCR-only plus a note naming why.
            const reason = err instanceof Error ? err.message : String(err);
            visionSection = `(Vision model call failed — falling back to OCR text only, which is unreliable for math, diagrams, and dense UI. Reason: ${reason})`;
          }
        }

        const sections = [visionSection];
        if (result.ocr_available) {
          sections.push(`[OCR text — exact strings, may be garbled]\n${ocrText}`);
        }
        sections.push(`[Screenshot saved to: ${result.path}]`);

        return {
          toolCallId: call.id,
          name: call.name,
          output: sections.join("\n\n"),
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
          error: `Unknown tool "${call.name}" — no such tool exists. Do not call it again or invent tool names. To create/save a skill use save_skill (name, tags, content). To produce a report/document/file use write_file. Otherwise use one of the tools listed in your system prompt.`,
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
