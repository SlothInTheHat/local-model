import { evaluate, compile } from "mathjs";
import { searchWeb, searchImages } from "./search";
import { useArtifactStore } from "../store/artifacts";
import { fileExists } from "./fileSystem";
import { TauriDirectoryHandle } from "./tauriFs";
import { speakText, SPEAK_TEXT_MAX_CHARS } from "./speech";
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
import { useWorkflowStore, compileInstruction } from "../store/workflows";
import type { Workflow } from "../store/workflows";
import { buildJobSpec, computeInitialNextRun, describeSchedule, normalizeSchedule, parseJobSpec } from "./scheduler";
import { searchSessions } from "./sessionSearch";
import { isTauriEnv } from "./fileSystem";
import { resolveRole } from "./modelRoles";
import { streamChatForModel } from "./chatProvider";
import { listShadowHistory, diffShadowRange } from "./shadowGit";
import { runBenchmarkSuite } from "./benchmarks";
import { notifyOs } from "./osNotify";

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

function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1];
      if (!base64) {
        reject(new Error("Failed to extract base64 data from blob"));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
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
  | "move_file"
  | "copy_file"
  | "rename_file"
  | "list_directory"
  | "grep_files"
  | "find_files"
  | "get_known_folder"
  | "download_file"
  | "compress_files"
  | "extract_archive"
  | "convert_image"
  | "remove_background"
  | "pdf_merge"
  | "pdf_to_text"
  | "close_window"
  | "minimize_window"
  | "uia_list_elements"
  | "uia_click_element"
  | "uia_read_element_text"
  | "uia_set_element_text"
  | "list_processes"
  | "kill_process"
  | "get_disk_usage"
  | "empty_recycle_bin"
  | "adjust_volume"
  | "speak_text"
  | "print_file"
  | "remind_me"
  | "calculator"
  | "web_search"
  | "search_images"
  | "run_command"
  | "run_tool_script"
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
  | "spawn_reviewer_subagent"
  | "propose_feature"
  | "search_past_sessions"
  | "find_recurring_issues"
  | "search_knowledge"
  | "list_collections"
  | "search_resume_knowledge"
  | "propose_resume_edit"
  | "read_clipboard"
  | "set_clipboard"
  | "open_application"
  | "list_windows"
  | "focus_window"
  | "take_screenshot"
  | "save_workflow"
  | "list_workflows"
  | "run_workflow"
  | "delete_workflow"
  | "notify_user"
  | "render_canvas"
  | "plot_graph"
  | "render_table"
  | "show_webpage";

export interface ToolDef {
  // string allows MCP tools with dynamic "serverId__toolName" names
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  group?: "files" | "shell" | "git" | "web" | "media" | "state" | "app" | "external" | "ui";
  risk?: "read" | "mutate" | "execute" | "ui";
  /** Allowed in Plan (read-only) mode. */
  planModeAllowed?: boolean;
  /** Needs user approval in Build mode (unless autoApproveAll). */
  requiresApproval?: boolean;
  /**
   * Alternate names a model might emit for this tool (hand-authored). Feeds
   * per-round tool retrieval's alias hard-include match (toolFilter.ts) — if
   * the current objective text names this tool by one of these, it's
   * force-included regardless of rank score. Distinct from TOOL_ALIASES
   * below (a flat wrong-name -> canonical-name map used for POST-HOC call
   * normalization after the model already picked a tool) — that map is
   * merged into this field automatically via effectiveAliases(), so most
   * tools don't need to hand-populate this at all. Optional and empty on
   * every tool by default; absence is not a regression, just no extra signal.
   */
  aliases?: string[];
  /**
   * Short situational phrasings of when this tool applies (e.g. "isolate
   * subject from background"), folded into the indexed text alongside the
   * description for per-round retrieval (toolBm25.ts) — never shown to the
   * model verbatim. Optional; empty/absent tools just retrieve on
   * name+description exactly as before this field existed.
   */
  useWhen?: string[];
}

/** Appended to file-tool path descriptions so the model knows absolute paths
 *  into a Settings > Privacy & Security-enabled folder work too, not just
 *  workspace-relative ones. */
const EXTRA_ROOT_PATH_HINT =
  " Absolute paths also work if they're inside a folder the user has enabled in Settings > Privacy & Security (e.g. Downloads, Desktop) — use get_known_folder to look one up.";

export const TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: "read_file",
    description:
      "Read the text content of a file from the current workspace directory. For large files, use offset/limit to page through sections instead of re-reading from the start — do not fall back to grep_files just to see content further into a file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file within the workspace (e.g. 'src/main.ts')." + EXTRA_ROOT_PATH_HINT,
        },
        offset: {
          type: "number",
          description: "1-based line number to start reading from. Omit to start at line 1.",
        },
        limit: {
          type: "number",
          description: "Max number of lines to return. Omit to read to end of file (capped at 2000 lines to protect context — use offset to page through longer files).",
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
        path: { type: "string", description: "Relative path to the file within the workspace." + EXTRA_ROOT_PATH_HINT },
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
          description: "Optional sub-path within the workspace. Defaults to root." + EXTRA_ROOT_PATH_HINT,
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
    name: "get_known_folder",
    description:
      "Resolve a well-known OS folder (Downloads, Desktop, Documents, Pictures, Home) to its real absolute path on this computer. This only looks up the path — it does NOT grant access. Other file tools (read_file/write_file/list_directory/etc.) can only actually use that path if the user has enabled it in Settings > Privacy & Security first; if a subsequent file-tool call is refused, tell the user which folder to enable there rather than retrying.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "One of: downloads, desktop, documents, pictures, home.",
        },
      },
      required: ["name"],
    },
    group: "files",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
  },
  {
    name: "download_file",
    description:
      "Download a URL's binary content (image, PDF, zip, etc.) straight to disk. Use this instead of web_fetch when you need the actual file bytes, not just page text — web_fetch strips HTML and returns text only." + EXTRA_ROOT_PATH_HINT,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to download (must start with http:// or https://)." },
        dest_path: { type: "string", description: "Where to save it. Relative paths resolve against the open workspace." },
      },
      required: ["url", "dest_path"],
    },
    group: "web",
    risk: "mutate",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "remove_background",
    description:
      "Remove the background from an image, producing a transparent PNG. Runs the same on-device model used by the Image tab's 'Remove background' button — no network call.",
    parameters: {
      type: "object",
      properties: {
        src_path: { type: "string", description: "Path to the source image." + EXTRA_ROOT_PATH_HINT },
        dest_path: { type: "string", description: "Where to save the result (should end in .png — the output always has transparency)." },
      },
      required: ["src_path", "dest_path"],
    },
    group: "media",
    risk: "mutate",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "convert_image",
    description:
      "Convert an image's format and/or resize it (downscale only, aspect ratio preserved). Output format is inferred from dest_path's extension (.png/.jpg/.jpeg).",
    parameters: {
      type: "object",
      properties: {
        src_path: { type: "string", description: "Path to the source image." + EXTRA_ROOT_PATH_HINT },
        dest_path: { type: "string", description: "Where to save the converted image — its extension determines the output format." },
        max_width: { type: "number", description: "Optional max width in pixels. Omit to leave width unconstrained." },
        max_height: { type: "number", description: "Optional max height in pixels. Omit to leave height unconstrained." },
      },
      required: ["src_path", "dest_path"],
    },
    group: "media",
    risk: "mutate",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "compress_files",
    description: "Create a zip archive containing the given files and/or directories (directories are added recursively).",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Files/directories to include." + EXTRA_ROOT_PATH_HINT,
        },
        dest_path: { type: "string", description: "Path for the resulting .zip file." },
      },
      required: ["paths", "dest_path"],
    },
    group: "files",
    risk: "mutate",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "extract_archive",
    description: "Extract a zip archive's contents into a destination directory (created if it doesn't exist).",
    parameters: {
      type: "object",
      properties: {
        archive_path: { type: "string", description: "Path to the .zip file." + EXTRA_ROOT_PATH_HINT },
        dest_dir: { type: "string", description: "Directory to extract into." },
      },
      required: ["archive_path", "dest_dir"],
    },
    group: "files",
    risk: "mutate",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "pdf_merge",
    description: "Merge multiple PDF files into one, in the given order.",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "PDF file paths to merge, in order (need at least 2)." + EXTRA_ROOT_PATH_HINT,
        },
        dest_path: { type: "string", description: "Path for the resulting merged PDF." },
      },
      required: ["paths", "dest_path"],
    },
    group: "files",
    risk: "mutate",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "pdf_to_text",
    description:
      "Extract plain text from a PDF. Works well for text-based PDFs; scanned/image-only PDFs may yield little or nothing since there is no OCR step.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the PDF file." + EXTRA_ROOT_PATH_HINT },
      },
      required: ["path"],
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
    name: "search_images",
    description:
      "Search for actual downloadable images (not web pages) and return direct file URLs — use this instead of web_search whenever the goal is to find AND download/save an image (a picture, icon, photo, graphic). web_search only returns page URLs and text snippets, never a usable image URL; this tool exists specifically to close that gap. Each result's 'url' is a real, direct, downloadable file link — pass it straight to download_file, no further searching/guessing needed. Backed by Wikimedia Commons, so results skew toward diagrams/icons/photos/public-domain or openly-licensed images rather than every possible image on the web.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What the image should show, e.g. 'red arrow', 'golden retriever puppy'." },
        limit: { type: "number", description: "Max results to return, default 8." },
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
    name: "find_recurring_issues",
    description:
      "Scans past agent session history for RECURRING friction patterns — the same block/error/recovery-hint showing up across multiple separate sessions — not a single anecdote. Returns counts and example snippets per pattern, grounded in real history. Use this before calling propose_feature for a system-prompt or tool-description fix, so the proposal is backed by data instead of one bad session. If nothing clears the occurrence threshold, that itself is useful information — it means there's no clear recurring problem yet.",
    parameters: {
      type: "object",
      properties: {
        min_occurrences: {
          type: "number",
          description: "Minimum distinct sessions a pattern must appear in to be reported. Defaults to 3 — lower this only if session history is still sparse.",
        },
      },
      required: [],
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
    name: "search_resume_knowledge",
    description:
      "Search the user's 'Resume' background-knowledge collection — additional projects, experience, and skills the user has recorded that are NOT necessarily on their current resume, kept fully separate from their class/study collections. Use this when tailoring a resume to a job listing to find real background material to draw from instead of inventing content. Returns passages with source citations. This tool is scoped to the Resume collection only and cannot search any other collection.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query string." },
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
    name: "propose_resume_edit",
    description:
      "Propose a tailored edit to the currently open resume file for the user to review. Does NOT write to disk or change the file — it stages the full proposed replacement text as a side-by-side diff that the user must explicitly accept before anything is saved. Always pass the FULL new file content, not just the changed portion. Use this instead of write_file/patch_file, which are not available on this surface.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path of the resume file being edited — must match the file currently open in the editor." },
        new_content: { type: "string", description: "The full proposed replacement text for the file." },
        summary: { type: "string", description: "One-line human-readable description of what changed, shown as the diff's header." },
      },
      required: ["path", "new_content", "summary"],
    },
    group: "files",
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
          description: "Directory (not a file) to search in, relative to workspace root. Defaults to root — omit rather than pointing this at a single file." + EXTRA_ROOT_PATH_HINT,
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
          description: "Relative path to the file within the workspace (e.g. 'src/old.ts')." + EXTRA_ROOT_PATH_HINT,
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
    name: "move_file",
    description:
      "Move (or rename, if 'to' is in the same folder) a file or directory. Works within the open workspace, or between any folders the user has enabled in Settings > Privacy & Security (e.g. moving a file from Downloads into the workspace, or organizing files within Downloads).",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Path to the existing file/directory. Relative paths resolve against the open workspace; absolute paths must be inside the workspace or an enabled folder." },
        to: { type: "string", description: "Destination path, same rules as 'from'. Parent directories are created as needed." },
      },
      required: ["from", "to"],
    },
    group: "files",
    risk: "mutate",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "copy_file",
    description:
      "Copy a file or directory (recursively) to a new location, leaving the original in place. Same path rules as move_file.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Path to the existing file/directory." },
        to: { type: "string", description: "Destination path. Parent directories are created as needed." },
      },
      required: ["from", "to"],
    },
    group: "files",
    risk: "mutate",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "rename_file",
    description: "Rename a file or directory in place (keeps it in the same folder). For moving to a different folder, use move_file instead.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the existing file/directory." },
        new_name: { type: "string", description: "The new file/directory name (not a full path — just the name)." },
      },
      required: ["path", "new_name"],
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
          description: "Directory (not a file) to search in, relative to workspace root. Defaults to root — omit rather than pointing this at a single file." + EXTRA_ROOT_PATH_HINT,
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
      "Execute a shell command on the user's machine and return its stdout/stderr output. Use for running scripts, compiling code, checking git status, installing packages, etc. Requires Tauri desktop mode. On Windows this runs in PowerShell, not bash — avoid one-liners with embedded double quotes (e.g. `node -e \"...\"`), PowerShell's quoting breaks them; write a small script file with write_file and run that instead of fighting with inline quoting.",
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
    name: "run_tool_script",
    description:
      "\"Code Mode\": run a short JavaScript program instead of calling tools one at a time. The program runs in an isolated sandbox with no network/DOM access — the ONLY things it can do are call the tool functions listed below (each available tool from this round is exposed as a plain function you call directly, e.g. `const r = read_file({ path: \"a.ts\" }); write_file({ path: \"b.ts\", content: r.output.toUpperCase() });` — no async/await needed, they return their result synchronously). Use this to collapse a multi-step sequence (read several files, transform, write results) into ONE call instead of one round-trip per step. `console.log(...)` is available for debugging. End with a `return` statement if you want a value back. Do NOT call run_tool_script from inside a script (not available there), and do not attempt network/window access — it isn't present in the sandbox.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript source to run. Runs inside a function body (top-level `return` is allowed). Only call tool functions that were available to you this round — the sandbox does not expose every tool that exists, only the ones you were offered.",
        },
      },
      required: ["code"],
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
    description: "Launch an application, file, or URL by name/path (like typing it into Start/Spotlight). On Windows this first tries a fuzzy match against installed Start Menu apps (so a display name like 'Photoshop' or 'VS Code' works even if it's not the executable name), then falls back to the raw OS shell lookup, which only resolves PATH executables, registered app names, or file/URL associations — e.g. 'mspaint' for Paint, 'calc' for Calculator, 'cmd' for Command Prompt, 'notepad' for Notepad, 'explorer' for File Explorer. If a call still fails, retry once with the likely executable name — do not go searching the workspace filesystem for it.",
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
    name: "close_window",
    description: "Close a window (a normal close request, same as clicking its X button — well-behaved apps get a chance to prompt for unsaved changes) by the id returned from list_windows.",
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
    name: "minimize_window",
    description: "Minimize a window by the id returned from list_windows.",
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
    name: "uia_list_elements",
    description: "List UI elements (buttons, text fields, checkboxes, etc.) inside a window's accessibility tree, by the id from list_windows. Use this to see what's actually on screen — names, control types, and which actions each element supports — before targeting one with uia_click_element/uia_read_element_text/uia_set_element_text. This reads the accessibility tree directly (no screenshots), so it works even for elements that are visually scrolled off-screen or overlapped.",
    parameters: {
      type: "object",
      properties: {
        window_id: { type: "string", description: "The window id from list_windows." },
        control_type: { type: "string", description: "Optional filter, e.g. 'button', 'edit', 'checkbox', 'menuitem'. Omit to list everything." },
      },
      required: ["window_id"],
    },
    group: "state",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
  },
  {
    name: "uia_click_element",
    description: "Click/activate a UI element by its accessible name inside a window (from list_windows), matched via the element-targeted accessibility API — not screen coordinates. Works for buttons, checkboxes, menu items, links, etc. Call uia_list_elements first if you're not sure of the exact name.",
    parameters: {
      type: "object",
      properties: {
        window_id: { type: "string", description: "The window id from list_windows." },
        name: { type: "string", description: "The element's accessible name (exact match preferred, substring match as fallback)." },
        control_type: { type: "string", description: "Optional filter to disambiguate elements sharing a name, e.g. 'button'." },
      },
      required: ["window_id", "name"],
    },
    group: "state",
    risk: "execute",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "uia_read_element_text",
    description: "Read the text/value of a UI element by its accessible name inside a window (from list_windows) — edit fields, labels, static text, or document content. Call uia_list_elements first if you're not sure of the exact name.",
    parameters: {
      type: "object",
      properties: {
        window_id: { type: "string", description: "The window id from list_windows." },
        name: { type: "string", description: "The element's accessible name (exact match preferred, substring match as fallback)." },
        control_type: { type: "string", description: "Optional filter to disambiguate elements sharing a name, e.g. 'edit'." },
      },
      required: ["window_id", "name"],
    },
    group: "state",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
  },
  {
    name: "uia_set_element_text",
    description: "Set the text/value of an editable UI element (text box, combo box edit area) by its accessible name inside a window (from list_windows). Call uia_list_elements first if you're not sure of the exact name.",
    parameters: {
      type: "object",
      properties: {
        window_id: { type: "string", description: "The window id from list_windows." },
        name: { type: "string", description: "The element's accessible name (exact match preferred, substring match as fallback)." },
        value: { type: "string", description: "The text to set." },
        control_type: { type: "string", description: "Optional filter to disambiguate elements sharing a name, e.g. 'edit'." },
      },
      required: ["window_id", "name", "value"],
    },
    group: "state",
    risk: "execute",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "list_processes",
    description: "List running processes (pid + name). Use to find the pid of a process you want to terminate with kill_process.",
    parameters: { type: "object", properties: {}, required: [] },
    group: "state",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
  },
  {
    name: "kill_process",
    description: "Forcibly terminate a process by pid (from list_processes). Unsaved work in that process is lost. Be careful with system-critical processes — only kill what the user clearly asked to stop.",
    parameters: {
      type: "object",
      properties: {
        pid: { type: "number", description: "Process id from list_processes." },
      },
      required: ["pid"],
    },
    group: "state",
    risk: "execute",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "get_disk_usage",
    description: "Get total/free disk space for a drive.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "A path on the drive to check, e.g. 'C:\\'. Omit to check the system drive." },
      },
      required: [],
    },
    group: "state",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
  },
  {
    name: "empty_recycle_bin",
    description: "Empty the Recycle Bin. Cannot be undone.",
    parameters: { type: "object", properties: {}, required: [] },
    group: "state",
    risk: "execute",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "adjust_volume",
    description: "Adjust system volume by simulating a physical media key press — relative steps and mute only, not an exact percentage.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "One of: mute, up, down." },
      },
      required: ["action"],
    },
    group: "state",
    risk: "execute",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "speak_text",
    description: "Read text aloud through the system's text-to-speech voice. Uses the best available voice, which on Windows is often a cloud-rendered neural voice (requires network) rather than a local one — falls back to a fully offline system voice if none is available. Use for hands-free/ambient responses when the user is asking for something to be read out rather than typed.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to speak (capped at 1000 characters — keep it concise)." },
      },
      required: ["text"],
    },
    group: "media",
    risk: "execute",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "print_file",
    description: "Ask the OS to print a file via its default application's Print handler (like right-click > Print). Works for common types (images, PDFs, documents) whose default app supports it — not guaranteed for every file type, and needs a configured default printer.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to print." + EXTRA_ROOT_PATH_HINT },
      },
      required: ["path"],
    },
    group: "files",
    risk: "execute",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "remind_me",
    description: "Set a one-time reminder that pushes an OS notification with the given message at the given time — for casual 'remind me to X' requests. For anything recurring, use schedule_task instead.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The reminder text to show the user." },
        in_minutes: { type: "number", description: "Fire this many minutes from now. Use this OR at_unix_seconds, not both." },
        at_unix_seconds: { type: "number", description: "Fire at this absolute Unix timestamp (seconds) — get the current time from get_current_datetime first if computing an absolute time like '3pm today'." },
      },
      required: ["message"],
    },
    group: "state",
    risk: "mutate",
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
    description: "Draft a structured spec for a NEW LocalMind capability you lack and cannot build yourself with register_tool (i.e. it needs app source changes). Saved to .localmind/improvements/ for the user or Claude Code to implement later. Use this instead of refusing or faking a capability. Do NOT use it for things a shell one-liner could do — use register_tool for those. When the proposal is a system-prompt or tool-description wording change (e.g. following up on find_recurring_issues), fill in 'diff' with the concrete before/after text — a prose description of a wording tweak is much harder for an implementer to act on than the actual wording. If this workspace has any saved benchmarks (Benchmarks tab), they're run automatically before saving as a baseline score attached to the proposal, so a human reviewer can re-run them after applying the change and see immediately if anything regressed.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short imperative title, e.g. 'Resize images in the image editor'." },
        motivation: { type: "string", description: "Why this is needed / what the user was trying to do." },
        proposed_files: { type: "string", description: "Optional: comma-separated files likely involved, if you can guess them." },
        acceptance_criteria: { type: "string", description: "Optional: how you'd know it works." },
        size_guess: { type: "string", description: "Optional rough effort: S, M, or L." },
        details: { type: "string", description: "The detailed spec — approach, edge cases, anything an implementer needs." },
        diff: { type: "string", description: "Optional: for a wording/prompt/tool-description change specifically, the concrete before → after text (quote the exact current wording and the exact proposed replacement)." },
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
          description: "The instruction for the scheduled agent run to execute — a natural-English description of THIS user's actual goal, never shell code/commands (bad: 'echo $(date) >> file', 'Get-Date') and never a copy of any example text you've seen elsewhere — write it fresh, describing what THIS specific request needs done. The scheduled agent runs on the user's platform and will emit the correct commands itself; your only job here is to state the goal in plain English.",
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
    name: "save_workflow",
    description:
      "Save a named, reusable automation the user can re-run manually or on a schedule — e.g. 'watch these internship sites and keep a running list' or 'check these stock prices every morning'. This is DIFFERENT from schedule_task: a workflow is named, shows up in the Workflows tab, keeps its own accumulating output file, and can optionally use specific MCP integrations for unattended runs. IMPORTANT — do not call this on the first ask. Have a real conversation first: if the goal names a category rather than concrete sources ('top internship sites', 'my usual news sites'), ask the user which specific sites/URLs to use — you cannot reliably discover 'the top N' sites yourself, and a wrong guess makes every future unattended run silently useless. If the goal implies pages web_search/web_fetch can't reach (JS-heavy job boards, login-gated pages), ask whether to opt this workflow into a connected MCP tool (e.g. a Browser/Playwright server) — only offer servers that are actually connected right now (see the Integrations (MCP) status in your context), never one that isn't. Confirm the output format/location expectation and how often it should run (or that it's manual-only) before calling this tool. Only call it once the goal is concrete enough that a headless run with no further back-and-forth could actually succeed.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short name for this workflow, e.g. 'Internship Tracker'." },
        description: { type: "string", description: "One-sentence summary of what this workflow does." },
        instruction: {
          type: "string",
          description: "The natural-language goal to run each time, in plain English — never shell code. This is combined automatically with instructions to read/update this workflow's output file without duplicating entries, so just describe the goal itself (e.g. 'Search for new remote software engineering internship postings on <specific sites the user named>'). If you provide 'steps' below, this can just be a short overall summary — the actual run instruction is compiled from steps instead. IMPORTANT: unattended/scheduled runs never have run_command (or any shell/script execution) access — that's a deliberate safety boundary, not a bug, since no human is present to review a command before it runs unattended. If migrating an existing script-based process (e.g. a Python file that computes something), do NOT write a step like 'run update_status.py' — it will be silently denied every round until the run fails. Instead describe the underlying logic itself in plain English (e.g. 'compare each row's deadline to today's date and mark it past-due if earlier') so the agent works it out directly each run — this fully replaces needing the script.",
        },
        steps: {
          type: "array",
          items: { type: "string" },
          description: "Optional but recommended: break the goal into an ordered list of concrete sub-steps (e.g. ['Search <site> for new internship postings', 'Extract company, role, deadline, and link for each', 'Filter to remote-only', 'Write results to the output file']). Shown as an editable visual flow in the Workflows tab — the user can edit individual steps later, so make each one a self-contained, meaningful unit of work rather than an arbitrarily fine or coarse split. Each step must be achievable with read_file/write_file/patch_file/web_search/web_fetch/grep_files/find_files (plus any connected MCP tools opted into via mcp_servers) — never a step that assumes run_command/shell execution, which unattended runs never have access to (see instruction's note above).",
        },
        schedule: {
          type: "string",
          description: "Optional. Omit entirely for a manual-only workflow (the user runs it themselves whenever they want). Otherwise same format as schedule_task: 'interval:<seconds>', 'cron:<5-field-expr>', or 'once:<unix_seconds>'.",
        },
        mcp_servers: {
          type: "array",
          items: { type: "string" },
          description: "Optional. Labels (not ids) of currently-connected MCP servers this workflow may use during UNATTENDED (scheduled) runs, e.g. ['Browser']. Only include a server the user has explicitly agreed this workflow should use, and only if it shows as connected in your context right now.",
        },
        output_format: {
          type: "string",
          description: "Optional, defaults to 'markdown'. Use 'html' when the user wants an interactive result — a filterable/sortable dashboard, not just a running list — e.g. 'find internships and let me filter by paid/unpaid' rather than 'keep a list of internships'. HTML workflows are shown as a live rendered preview in the Workflows tab instead of raw text, and each run should write a complete, self-contained interactive page (inline <style>/<script>, real filter/sort controls) rather than a static table.",
        },
      },
      required: ["name", "description", "instruction"],
    },
    group: "state",
    risk: "mutate",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "list_workflows",
    description: "List all saved workflows, including each one's name, description, schedule, output file, and last run outcome/time.",
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
    name: "run_workflow",
    description: "Run a saved workflow right now, regardless of its schedule. Use list_workflows first to find the id or exact name.",
    parameters: {
      type: "object",
      properties: {
        id_or_name: { type: "string", description: "The workflow's id (from list_workflows) or its exact name." },
      },
      required: ["id_or_name"],
    },
    group: "state",
    risk: "execute",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "delete_workflow",
    description: "Permanently delete a saved workflow and cancel its schedule (if any). Does NOT delete the workflow's accumulated output file — that stays on disk. Use list_workflows first to find the id or exact name.",
    parameters: {
      type: "object",
      properties: {
        id_or_name: { type: "string", description: "The workflow's id (from list_workflows) or its exact name." },
      },
      required: ["id_or_name"],
    },
    group: "state",
    risk: "mutate",
    planModeAllowed: false,
    requiresApproval: true,
  },
  {
    name: "notify_user",
    description: "Send the user a desktop OS notification right now, outside your normal chat response. This is for UNATTENDED/background contexts (a scheduled job, a workflow, a self-improvement pass) where you've noticed something worth telling the user about immediately — e.g. a workflow's output changed in a way that matters, or you found a genuine recurring problem worth flagging. Do NOT use this for routine 'finished successfully, nothing notable' status — a scheduled run already gets its own completion notification separately, so only call this when there's something specific and worth interrupting the user for. If in doubt, don't call it — silence is the correct default.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short notification title." },
        message: { type: "string", description: "The specific thing worth telling the user, in one or two sentences." },
      },
      required: ["title", "message"],
    },
    group: "state",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
  },
  {
    name: "render_canvas",
    description: "Render a complete, self-contained interactive HTML/CSS/JS page inline in the chat, in a live sandboxed preview — for diagrams, mini-simulations, custom visualizations, small games, or anything else you can build with HTML/CSS/JS that a static markdown reply can't show. LocalMind is fully offline: never reference an external CDN, font, image, or script URL — inline every style and script directly in the document, and inline any needed images as base64 data: URIs. For a plain function graph use plot_graph instead (better default styling, no need to hand-write plotting code); for tabular data use render_table instead (built-in sort/filter, no iframe needed).",
    parameters: {
      type: "object",
      properties: {
        html: { type: "string", description: "A complete HTML document (or a body-only fragment — it will be wrapped automatically). Must be fully self-contained: inline <style> and <script>, no external resource references." },
        title: { type: "string", description: "Optional short title shown above the preview." },
      },
      required: ["html"],
    },
    group: "ui",
    risk: "ui",
    planModeAllowed: true,
    requiresApproval: false,
  },
  {
    name: "plot_graph",
    description: "Plot one or more math expressions in x (e.g. 'sin(x)*x', 'x^2 - 3') and/or raw (x,y) data series as an interactive, pannable/zoomable graph inline in the chat — the Desmos-style graphing tool. Prefer this over render_canvas for anything that's fundamentally a function/data plot; it looks better and needs no plotting code from you.",
    parameters: {
      type: "object",
      properties: {
        expressions: { type: "array", items: { type: "string" }, description: "Math expressions in terms of x, evaluated with mathjs syntax (e.g. 'sin(x)', 'x^2/4 - 2')." },
        series: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              points: { type: "array", items: { type: "array", items: { type: "number" } }, description: "Array of [x, y] pairs." },
            },
          },
          description: "Optional: raw (x,y) data series to plot alongside/instead of expressions.",
        },
        xMin: { type: "number", description: "Optional, default -10." },
        xMax: { type: "number", description: "Optional, default 10." },
        title: { type: "string" },
      },
    },
    group: "ui",
    risk: "ui",
    planModeAllowed: true,
    requiresApproval: false,
  },
  {
    name: "render_table",
    description: "Display structured tabular data inline in the chat as a real interactive table with sorting and filtering — use this instead of a markdown table whenever the data has more than a handful of rows or the user would benefit from sorting/filtering it (e.g. comparing several options, listing search results with multiple attributes).",
    parameters: {
      type: "object",
      properties: {
        columns: { type: "array", items: { type: "string" }, description: "Column headers, in order." },
        rows: { type: "array", items: { type: "array" }, description: "Each row is an array of cell values in the same order as columns." },
        title: { type: "string" },
      },
      required: ["columns", "rows"],
    },
    group: "ui",
    risk: "ui",
    planModeAllowed: true,
    requiresApproval: false,
  },
  {
    name: "show_webpage",
    description: "Display a live external webpage inline in the chat, e.g. documentation or a reference page you found via web_search. Tries to embed the actual live page; many sites block being embedded (banks, Google, and others send headers that prevent this) — when that happens this automatically falls back to a clean read-only text view of the page's content instead, so it always shows something useful either way.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL, starting with http:// or https://." },
        title: { type: "string" },
      },
      required: ["url"],
    },
    group: "web",
    risk: "read",
    planModeAllowed: true,
    requiresApproval: false,
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
  {
    name: "spawn_reviewer_subagent",
    description:
      "After finishing a non-trivial build task (multiple file edits, a new feature, a bug fix) and before declaring it done, use this to get an independent second opinion — a separate agent with completely fresh context (no memory of writing the code, no motivation to see it as correct) reviews the actual diff of what changed. This catches issues a single agent grading its own homework tends to miss. It automatically gathers the diff itself (from this app's own shadow version history, independent of any real git repo) — you do not need to pass a diff. The reviewer is read-only: it can read files for context but never edits anything, and just reports what it found.",
    parameters: {
      type: "object",
      properties: {
        task_description: {
          type: "string",
          description: "What the work was supposed to accomplish, so the reviewer can judge the diff against the actual goal rather than reviewing it in a vacuum.",
        },
        since_commits: {
          type: "number",
          description: "How many recent shadow-history commits to include in the reviewed diff. Defaults to 10 — enough to cover a typical build task's worth of changes.",
        },
        model: { type: "string", description: "Optional model name to run the reviewer with. Defaults to the current active model." },
      },
      required: ["task_description"],
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
  /** Optional structured fact about what this call produced/touched — set by
   *  a small set of handlers that already compute this data before
   *  flattening it into `output` prose. Feeds RuntimeState.resources in
   *  agentRuntime.ts so later rounds can reference it without re-parsing
   *  output text. Absent by default; most tools don't set it. */
  resource?: { kind: "file" | "path" | "artifact"; path?: string; url?: string; id?: string; label: string };
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

/** Same defensiveness as argStr, for array args — accepts a real array, or a
 *  comma-separated string (weak models sometimes emit that instead). */
function argStrArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map((v) => argStr(v)).filter(Boolean);
  const s = argStr(val);
  return s ? s.split(",").map((x) => x.trim()).filter(Boolean) : [];
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
  image_search: "search_images", search_image: "search_images", find_image: "search_images", find_images: "search_images",
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

let _aliasesByCanonical: Map<string, string[]> | null = null;
/** Inverts TOOL_ALIASES (wrong-name -> canonical) into (canonical -> wrong-names[]),
 *  lazily, once. This is the "free first pass" backfill: ~15 tools already have
 *  curated alternate names here from real observed model mistakes, reused as
 *  retrieval signal with no new authoring required. */
function aliasesByCanonical(): Map<string, string[]> {
  if (!_aliasesByCanonical) {
    const map = new Map<string, string[]>();
    for (const [wrong, canonical] of Object.entries(TOOL_ALIASES)) {
      const list = map.get(canonical) ?? [];
      list.push(wrong);
      map.set(canonical, list);
    }
    _aliasesByCanonical = map;
  }
  return _aliasesByCanonical;
}

/** A tool's full alias list for retrieval purposes: its own hand-authored
 *  `aliases` field (if any) plus every TOOL_ALIASES entry that maps TO it —
 *  so most tools get real alias coverage without ever populating the field. */
export function effectiveAliases(tool: ToolDef): string[] {
  const fromMap = aliasesByCanonical().get(tool.name) ?? [];
  return tool.aliases && tool.aliases.length > 0 ? [...tool.aliases, ...fromMap] : fromMap;
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

/** Matches a Windows drive-letter path ("C:/...", "C:\\...") or a POSIX absolute path ("/..."). */
const ABSOLUTE_PATH_RE = /^(?:[a-zA-Z]:[\\/]|[\\/])/;

/**
 * Resolves a model-supplied path (relative OR absolute) to workspace-relative
 * path segments, for the FSA-`dirHandle`-based tools (read_file/write_file/
 * patch_file/delete_file/list_directory/grep_files/find_files/apply_patch).
 *
 * Confirmed bug this fixes: resolvePathParts alone has no concept of an
 * absolute path — given "C:/Users/.../workspace/foo.txt" it just splits on
 * "/" and walks every segment (including the literal "C:") as a nested
 * subfolder NAME relative to the already-workspace-scoped dirHandle. That
 * silently resolves to the wrong (nonexistent) nested location instead of
 * the real file — unlike create_folder, which goes through a real OS path
 * via the Rust fs_mkdir command and already special-cases absolute paths
 * correctly. A model passing the identical absolute path to write_file then
 * read_file previously got inconsistent behavior (write "succeeding" at the
 * wrong spot, then read failing with "Directory not found").
 */
export function resolveWorkspaceRelativeParts(rawPath: string, workspacePath: string | null | undefined): string[] {
  if (!ABSOLUTE_PATH_RE.test(rawPath)) {
    return resolvePathParts(rawPath);
  }
  if (!workspacePath) {
    throw new Error(`Absolute path "${rawPath}" given but no workspace root is known — use a relative path instead.`);
  }
  const normWorkspace = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const normRaw = rawPath.replace(/\\/g, "/");
  if (normRaw.toLowerCase() !== normWorkspace && !normRaw.toLowerCase().startsWith(normWorkspace + "/")) {
    throw new Error(`Absolute path "${rawPath}" is outside the current workspace root ("${workspacePath}") — use a relative path instead.`);
  }
  const rel = normRaw.slice(normWorkspace.length).replace(/^\/+/, "");
  return resolvePathParts(rel);
}

/** Same as normalizeSubPath, but rebases an absolute path onto workspacePath first (see resolveWorkspaceRelativeParts). */
export function normalizeWorkspaceRelativeSubPath(p: string, workspacePath: string | null | undefined): string {
  const trimmed = p.trim();
  if (!trimmed) return "";
  return resolveWorkspaceRelativeParts(trimmed, workspacePath).join("/");
}

/**
 * Resolves a model-supplied path (relative or absolute) to a (root handle,
 * relative parts) pair for the FSA-shaped file tools (read_file/write_file/
 * patch_file/delete_file/list_directory/grep_files/find_files). Relative
 * paths and absolute paths inside the open workspace resolve against
 * `dirHandle`, same as resolveWorkspaceRelativeParts. Absolute paths inside a
 * folder the user has enabled in Settings > Privacy & Security (extraRoots —
 * Downloads, Desktop, etc.) resolve against a fresh handle rooted there
 * instead, so file tools can reach outside the single open workspace.
 * TauriDirectoryHandle duck-types FileSystemDirectoryHandle (see tauriFs.ts),
 * so callers' existing walk logic (resolveDirHandle, getFileHandle, etc.)
 * needs no changes regardless of which root this returns — and Rust's
 * ensure_confined is still the real security boundary underneath either root.
 */
export function resolveFileRoot(
  rawPath: string,
  dirHandle: FileSystemDirectoryHandle | null,
  workspacePath: string | null | undefined
): { root: FileSystemDirectoryHandle; parts: string[] } {
  const trimmed = rawPath.trim();
  const normRaw = trimmed.replace(/\\/g, "/");

  if (ABSOLUTE_PATH_RE.test(trimmed)) {
    if (workspacePath) {
      const normWorkspace = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      if (normRaw.toLowerCase() === normWorkspace || normRaw.toLowerCase().startsWith(normWorkspace + "/")) {
        if (!dirHandle) throw new Error("No workspace directory set. Ask the user to open a folder.");
        const rel = normRaw.slice(normWorkspace.length).replace(/^\/+/, "");
        return { root: dirHandle, parts: resolvePathParts(rel) };
      }
    }
    const extraRoots = useAgentStore.getState().extraRoots;
    for (const rootPath of Object.values(extraRoots)) {
      if (!rootPath) continue;
      const normRoot = rootPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      if (normRaw.toLowerCase() === normRoot || normRaw.toLowerCase().startsWith(normRoot + "/")) {
        const rel = normRaw.slice(normRoot.length).replace(/^\/+/, "");
        return {
          root: new TauriDirectoryHandle(rootPath) as unknown as FileSystemDirectoryHandle,
          parts: resolvePathParts(rel),
        };
      }
    }
    const enabledNames = Object.keys(extraRoots);
    const hint = enabledNames.length > 0
      ? ` Enabled folders: ${enabledNames.join(", ")}. Use get_known_folder to look up others, and tell the user to enable them in Settings > Privacy & Security.`
      : " No extra folders are enabled — tell the user to enable one in Settings > Privacy & Security (e.g. Downloads) to reach outside the workspace.";
    throw new Error(
      `Absolute path "${rawPath}" is outside the current workspace root${workspacePath ? ` ("${workspacePath}")` : ""} and no enabled folder covers it.${hint}`
    );
  }

  // Relative path — resolves against the open workspace.
  if (!dirHandle) {
    throw new Error(
      `Relative path "${rawPath}" given but no workspace is open — open a workspace folder, or pass an absolute path inside a folder enabled in Settings > Privacy & Security.`
    );
  }
  return { root: dirHandle, parts: resolvePathParts(trimmed) };
}

/**
 * Resolves a model-supplied path to a plain absolute OS path string, for the
 * native Rust-backed tools (move_file/copy_file/rename_file) that operate on
 * path strings directly rather than a FileSystemDirectoryHandle. Confinement
 * is still enforced server-side by Rust's ensure_confined — this only builds
 * a plausible absolute path and grants no access by itself.
 */
export function resolveNativeAbsolutePath(rawPath: string, workspacePath: string | null | undefined): string {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new Error("Missing path argument");
  if (ABSOLUTE_PATH_RE.test(trimmed)) {
    return trimmed.replace(/\\/g, "/");
  }
  if (!workspacePath) {
    throw new Error(`Relative path "${rawPath}" given but no workspace is open — pass an absolute path instead.`);
  }
  const base = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${base}/${resolvePathParts(trimmed).join("/")}`;
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

/**
 * Builds a clear error for when resolveDirHandle fails against `root`/`parts` —
 * distinguishes "that path is a file, not a directory" (a model passed
 * e.g. grep_files' path at a specific *.html file instead of its containing
 * folder) from a genuinely missing path, since the two look identical from
 * resolveDirHandle's plain null return and a model can't self-correct from an
 * ambiguous "Directory not found" alone.
 */
async function describeDirResolutionFailure(root: FileSystemDirectoryHandle, searchPath: string, parts: string[]): Promise<string> {
  if (parts.length > 0) {
    const parentParts = parts.slice(0, -1);
    const last = parts[parts.length - 1];
    const parent = parentParts.length > 0 ? await resolveDirHandle(root, parentParts) : root;
    if (parent) {
      try {
        await parent.getFileHandle(last, { create: false });
        return `"${searchPath}" is a file, not a directory — path must name a folder to search within (omit it to search the whole workspace, or pass its containing folder instead).`;
      } catch {
        // not a file either — genuinely missing, fall through to the generic message
      }
    }
  }
  return `Directory not found: ${searchPath}`;
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

/**
 * Best-effort nudge appended to a zero-result workspace-file search
 * (grep_files/find_files): if this workspace has knowledge-base collections,
 * point the model at search_knowledge instead of letting it give up. Cheap
 * (one extra API call, only on the empty-result path) and harmless if the
 * model's query really was about workspace files — see the "what do my class
 * notes say about X" tool-selection failure this exists to catch.
 */
async function noMatchKnowledgeHint(): Promise<string> {
  try {
    const collections = await tauriInvoke<Array<{ id: string; label: string }>>("collections_all");
    if (collections.length === 0) return "";
    return `\n\n[ACTION REQUIRED] No matches in this project's files. If the question is about the user's class notes / uploaded documents: do not tell the user you can't find them — call search_knowledge now (available: ${collections.map((c) => c.label || c.id).join(", ")}) before answering.`;
  } catch {
    return ""; // not in Tauri desktop mode, or no knowledge backend — no hint, no error either
  }
}

// ─── Chat artifacts (render_canvas / plot_graph / render_table / show_webpage) ──

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Wraps a bare fragment in a minimal document if the model didn't already
 *  provide a full <html> document — render_canvas explicitly allows either. */
function wrapHtmlDocument(html: string): string {
  return /<html[\s>]/i.test(html) ? html : `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
}

/**
 * Builds a self-contained, interactive (wheel-zoom + drag-pan) SVG plot as a
 * standalone HTML document — no charting library needed, mathjs (already a
 * dependency, used elsewhere by the calculator tool) does all the math on
 * this side; the artifact only ships the already-sampled points plus a small
 * inline viewer script.
 */
function buildPlotHtml(
  curves: { label: string; points: [number, number][] }[],
  opts: { title?: string; xMin: number; xMax: number },
): string {
  const width = 640, height = 400, pad = 40;
  const allY = curves.flatMap((c) => c.points.map((p) => p[1]));
  const yMin = allY.length ? Math.min(...allY) : -1;
  const yMax = allY.length ? Math.max(...allY) : 1;
  const yPad = (yMax - yMin) * 0.1 || 1;
  const y0 = yMin - yPad, y1 = yMax + yPad;
  const colors = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2"];

  const sx = (x: number) => pad + ((x - opts.xMin) / (opts.xMax - opts.xMin || 1)) * (width - 2 * pad);
  const sy = (y: number) => height - pad - ((y - y0) / (y1 - y0 || 1)) * (height - 2 * pad);

  const paths = curves.map((c, i) => {
    const d = c.points.map((p, j) => `${j === 0 ? "M" : "L"} ${sx(p[0]).toFixed(2)} ${sy(p[1]).toFixed(2)}`).join(" ");
    return `<path d="${d}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="2" />`;
  }).join("\n      ");

  const legend = curves.map((c, i) =>
    `<div style="display:flex;align-items:center;gap:6px;"><span style="width:10px;height:10px;background:${colors[i % colors.length]};border-radius:2px;display:inline-block;"></span>${escapeHtml(c.label)}</div>`
  ).join("\n      ");

  const xAxisY = y0 <= 0 && 0 <= y1 ? sy(0) : null;
  const yAxisX = opts.xMin <= 0 && 0 <= opts.xMax ? sx(0) : null;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin:0; font-family:system-ui,-apple-system,sans-serif; background:#fff; color:#111; }
  .wrap { padding:12px; }
  h3 { margin:0 0 8px; font-size:13px; font-weight:600; }
  svg { touch-action:none; cursor:grab; }
  .legend { display:flex; gap:14px; margin-top:8px; flex-wrap:wrap; font-size:12px; color:#444; }
</style></head>
<body>
  <div class="wrap">
    ${opts.title ? `<h3>${escapeHtml(opts.title)}</h3>` : ""}
    <svg id="chart" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#fafafa" stroke="#e5e5e5"/>
      ${xAxisY !== null ? `<line x1="${pad}" y1="${xAxisY}" x2="${width - pad}" y2="${xAxisY}" stroke="#ccc"/>` : ""}
      ${yAxisX !== null ? `<line x1="${yAxisX}" y1="${pad}" x2="${yAxisX}" y2="${height - pad}" stroke="#ccc"/>` : ""}
      ${paths}
    </svg>
    <div class="legend">${legend}</div>
  </div>
  <script>
    const svg = document.getElementById('chart');
    let vb = [0, 0, ${width}, ${height}];
    function apply() { svg.setAttribute('viewBox', vb.join(' ')); }
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const scale = e.deltaY > 0 ? 1.1 : 0.9;
      const [x, y, w, h] = vb;
      const mx = x + (e.offsetX / svg.clientWidth) * w;
      const my = y + (e.offsetY / svg.clientHeight) * h;
      vb = [mx - (mx - x) * scale, my - (my - y) * scale, w * scale, h * scale];
      apply();
    }, { passive: false });
    let dragging = false, last = null;
    svg.addEventListener('mousedown', (e) => { dragging = true; last = [e.clientX, e.clientY]; });
    window.addEventListener('mouseup', () => { dragging = false; });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const [x, y, w, h] = vb;
      const dx = (e.clientX - last[0]) / svg.clientWidth * w;
      const dy = (e.clientY - last[1]) / svg.clientHeight * h;
      vb = [x - dx, y - dy, w, h];
      last = [e.clientX, e.clientY];
      apply();
    });
  </script>
</body></html>`;
}

/**
 * Strips script/style/nav/header/footer/iframe blocks and inline event-
 * handler attributes from fetched HTML for show_webpage's reader-view
 * fallback. This is cleanliness, not the actual security boundary — the
 * result always renders in a sandbox="" iframe (no script execution allowed
 * at all) regardless of what a regex strip misses.
 */
function stripToReadable(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");
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

      case "search_images": {
        const query = argStr(call.args["query"]);
        if (!query) throw new Error("Missing query argument");
        const limitArg = call.args["limit"];
        const limit = typeof limitArg === "number" && limitArg > 0 ? Math.floor(limitArg) : 8;
        const results = await searchImages(query, limit);
        const output = results.length === 0
          ? `No images found for "${query}". Try a different/simpler query, or fall back to web_search.`
          : results
              .map((r, i) => `${i + 1}. ${r.title} (${r.width}x${r.height}, ${r.mime})\n   url: ${r.url}`)
              .join("\n\n");
        return {
          toolCallId: call.id,
          name: call.name,
          output,
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

      case "find_recurring_issues": {
        const rawMin = call.args["min_occurrences"];
        const minOccurrences = typeof rawMin === "number" && rawMin > 0 ? Math.floor(rawMin) : 3;

        // Mirrors the exact bracketed markers stuckDetector.ts / agentRuntime.ts
        // already emit into transcripts — this reuses those signals rather than
        // inventing a new failure-detection mechanism. Aggregated via the
        // existing session_search FTS (searchSessions), no new backend needed.
        const PATTERN_QUERIES: { label: string; query: string }[] = [
          { label: "Loop block (repeated identical tool call)", query: "BLOCKED LOOP" },
          { label: "Repeated-call block (re-ran an already-completed action)", query: "BLOCKED REPEATED CALL" },
          { label: "Read-only investigation loop", query: "BLOCKED READ-ONLY LOOP" },
          { label: "Planning-without-acting loop", query: "BLOCKED PLANNING LOOP" },
          { label: "Same run_command error repeated", query: "SAME ERROR" },
          { label: "Recovery hint triggered (a real error occurred)", query: "RECOVERY HINT" },
          { label: "Tool call denied by user", query: "Denied by user" },
          { label: "Denied in Plan mode", query: "Denied Plan mode" },
        ];

        const findings: { label: string; count: number; examples: string[] }[] = [];
        for (const { label, query } of PATTERN_QUERIES) {
          try {
            const hits = await searchSessions(query, 20);
            if (hits.length >= minOccurrences) {
              findings.push({
                label,
                count: hits.length,
                examples: hits.slice(0, 3).map((h) => `[${h.origin}] ${h.task}: ${h.snippet}`),
              });
            }
          } catch {
            // session search unavailable (non-Tauri / no history yet) — skip this pattern
          }
        }

        findings.sort((a, b) => b.count - a.count);

        if (findings.length === 0) {
          return {
            toolCallId: call.id,
            name: call.name,
            output: `No pattern recurred across at least ${minOccurrences} sessions. Either history is still sparse, or there's genuinely no clear recurring problem right now — that's a fine outcome, not a failed scan.`,
          };
        }

        const output = [
          `Found ${findings.length} recurring pattern(s) across session history (threshold: ${minOccurrences}+ sessions):`,
          ...findings.map((f, i) =>
            `${i + 1}. ${f.label} — ${f.count} session(s)\n   Examples:\n${f.examples.map((e) => `   - ${e}`).join("\n")}`
          ),
          "",
          "If one of these looks worth fixing, use propose_feature to draft a concrete system-prompt or tool-description change — cite the pattern and count as the motivation. Where practical, test the change against the Benchmarks tab before/after to confirm it doesn't regress anything else.",
        ].join("\n\n");

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

      case "search_resume_knowledge": {
        const query = argStr(call.args["query"]);
        if (!query) throw new Error("Missing query argument");
        const limitArg = call.args["limit"];
        const limit = typeof limitArg === "number" && limitArg > 0 ? Math.floor(limitArg) : 6;
        // collection is intentionally hardcoded, never read from call.args —
        // this is the isolation guarantee that keeps resume background
        // material from ever mixing with class/study collections.
        const hits = await searchMemory(query, limit, 0.3, { collection: "Resume", includeKnowledge: true });
        const output = hits.length === 0
          ? "No matching passages found in the Resume background collection. The user may not have uploaded background material yet — don't invent experience to fill the gap."
          : hits
              .map(({ entry }, i) => {
                const anchor = `[Resume${entry.sourceUri ? " " + entry.sourceUri : ""}${entry.location ? " " + entry.location : ""}]`;
                return `${i + 1}. ${anchor} ${entry.text}`;
              })
              .join("\n\n");
        return { toolCallId: call.id, name: call.name, output };
      }

      case "propose_resume_edit": {
        const path = argStr(call.args["path"]);
        const newContent = call.args["new_content"] != null ? String(call.args["new_content"]) : "";
        const summary = argStr(call.args["summary"]) || "Proposed resume edit";
        if (!path) throw new Error("Missing path argument");
        if (!newContent) throw new Error("Missing new_content argument");
        // No filesystem/memory I/O here on purpose — the UI reads path/new_content/summary
        // straight from call.args in onToolCallResolved and renders a pending diff;
        // nothing is written until the user clicks Accept.
        return {
          toolCallId: call.id,
          name: call.name,
          output: `Proposed edit ready for review in the diff panel: ${summary}`,
        };
      }

      case "list_directory": {
        const { root, parts } = resolveFileRoot(argStr(call.args["path"]), dirHandle, workspacePath);
        let targetHandle = root;
        if (parts.length > 0) {
          const resolved = await resolveDirHandle(root, parts);
          if (!resolved) throw new Error(`Directory not found: ${parts.join("/")}`);
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
        const path = argStr(call.args["path"]) || argStr(call.args["file_path"]) || argStr(call.args["filename"]);
        if (!path) throw new Error("Missing path argument");
        const { root, parts } = resolveFileRoot(path, dirHandle, workspacePath);
        const fileName = parts.pop()!;
        let parentHandle = root;
        if (parts.length > 0) {
          const resolved = await resolveDirHandle(root, parts);
          if (!resolved) throw new Error(`Directory not found: ${parts.join("/")}`);
          parentHandle = resolved;
        }
        const fileHandle = await parentHandle.getFileHandle(fileName, { create: false });
        const file = await fileHandle.getFile();
        const text = await file.text();

        // offset/limit: Ollama tool-call args can legitimately arrive as either
        // JSON numbers or numeric strings depending on the model/backend —
        // Number(...) handles both instead of silently ignoring a stringified arg.
        const rawOffset = call.args["offset"];
        const rawLimit = call.args["limit"];
        const offsetNum = rawOffset != null ? Number(rawOffset) : NaN;
        const limitNum = rawLimit != null ? Number(rawLimit) : NaN;
        const offset = Number.isFinite(offsetNum) && offsetNum > 1 ? Math.floor(offsetNum) : 1;
        const limit = Number.isFinite(limitNum) && limitNum > 0 ? Math.floor(limitNum) : 2000;

        const lines = text.split("\n");
        const start = offset - 1;
        const slice = lines.slice(start, start + limit);
        const output = slice.join("\n");
        const truncationNote =
          start + slice.length < lines.length
            ? `\n\n[Showing lines ${offset}-${start + slice.length} of ${lines.length}. Pass offset=${start + slice.length + 1} to continue.]`
            : "";

        return {
          toolCallId: call.id,
          name: call.name,
          output: output + truncationNote,
        };
      }

      case "write_file": {
        // Accept file_path as alias for path (models sometimes use the wrong param name)
        const path = argStr(call.args["path"]) || argStr(call.args["file_path"]) || argStr(call.args["filename"]);
        const content = argStr(call.args["content"]) || argStr(call.args["text"]) || argStr(call.args["code"]);
        if (!path) throw new Error("Missing path argument (expected 'path', 'file_path', or 'filename')");
        const { root, parts } = resolveFileRoot(path, dirHandle, workspacePath);
        const normalizedPath = parts.join("/");

        // Overwriting an existing file is now recovered via shadow-git
        // history (every mutating tool call is auto-committed after it
        // runs) rather than the old per-write sibling-folder backup.
        const overwritingExisting = await fileExists(root, normalizedPath);

        const fileName = parts.pop()!;
        let parentHandle = root;
        if (parts.length > 0) {
          let cursor: FileSystemDirectoryHandle = root;
          for (const part of parts) {
            cursor = await cursor.getDirectoryHandle(part, { create: true });
          }
          parentHandle = cursor;
        }
        const fileHandle = await parentHandle.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();

        const verb = overwritingExisting ? "File written" : "File created";
        // When overwriting an existing file, remind the model that patch_file is preferred for future edits.
        const overwriteHint = overwritingExisting
          ? `\nNote: You overwrote an existing file. For future fixes use patch_file — it edits only the changed lines and is less likely to introduce new bugs.`
          : "";
        return {
          toolCallId: call.id,
          name: call.name,
          output: `${verb}: ${path}${overwriteHint}`,
          resource: { kind: "file", path: normalizedPath, label: `wrote ${normalizedPath}` },
        };
      }

      case "patch_file": {
        const path = argStr(call.args["path"]);
        const oldString = call.args["old_string"] != null ? String(call.args["old_string"]) : null;
        const newString = call.args["new_string"] != null ? String(call.args["new_string"]) : "";
        const replaceAll = Boolean(call.args["replace_all"]);

        if (!path) throw new Error("Missing path argument");
        if (oldString === null) throw new Error("Missing old_string argument");

        const { root: patchRoot, parts: patchParts } = resolveFileRoot(path, dirHandle, workspacePath);
        const patchFileName = patchParts.pop()!;
        let patchParent = patchRoot;
        if (patchParts.length > 0) {
          const resolved = await resolveDirHandle(patchRoot, patchParts);
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
          resource: { kind: "file", path, label: `patched ${path}` },
        };
      }

      case "grep_files": {
        const pattern = argStr(call.args["pattern"]);
        if (!pattern) throw new Error("Missing pattern argument. If this is about the user's class notes/uploaded documents: do not ask the user to clarify — call search_knowledge now instead (it takes 'query', not 'pattern'). grep_files only searches this workspace's own project files.");
        const { root: grepRoot, parts: grepParts } = resolveFileRoot(argStr(call.args["path"]), dirHandle, workspacePath);
        const searchPath = grepParts.join("/");
        const fileGlob = argStr(call.args["file_pattern"]) || "*";
        const caseSensitive = (call.args["case_sensitive"] as boolean | undefined) ?? false;

        let targetHandle = grepRoot;
        if (grepParts.length > 0) {
          const resolved = await resolveDirHandle(grepRoot, grepParts);
          if (!resolved) throw new Error(await describeDirResolutionFailure(grepRoot, searchPath, grepParts));
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

        // A zero-match grep is a dead end this workspace's files genuinely
        // can't help with — but a weaker model asked something like "what do
        // my notes say about X" will sometimes reach for grep_files (it
        // searches "files") instead of search_knowledge (it searches
        // "notes"), despite the tool descriptions already distinguishing
        // them, then give up rather than retry with the right tool. If this
        // workspace actually has knowledge collections, nudge toward them.
        return {
          toolCallId: call.id,
          name: call.name,
          output: (results.length > 0
            ? `${results.length} match${results.length !== 1 ? "es" : ""}:\n${results.join("\n")}`
            : "No matches found.") + (results.length === 0 ? await noMatchKnowledgeHint() : ""),
        };
      }

      case "find_files": {
        const pattern = argStr(call.args["pattern"]);
        if (!pattern) throw new Error("Missing pattern argument. If this is about the user's class notes/uploaded documents: do not ask the user to clarify — call search_knowledge now instead (it takes 'query', not 'pattern'). find_files only searches this workspace's own project files by name.");
        const { root: findRoot, parts: findParts } = resolveFileRoot(argStr(call.args["path"]), dirHandle, workspacePath);
        const searchPath = findParts.join("/");

        let targetHandle = findRoot;
        if (findParts.length > 0) {
          const resolved = await resolveDirHandle(findRoot, findParts);
          if (!resolved) throw new Error(await describeDirResolutionFailure(findRoot, searchPath, findParts));
          targetHandle = resolved;
        }

        const nameRegex = globToRegex(pattern.replace(/^.*\//, "")); // match basename only
        const results: string[] = [];
        await findInHandle(targetHandle, nameRegex, searchPath || ".", results, 200);

        return {
          toolCallId: call.id,
          name: call.name,
          output: (results.length > 0
            ? `${results.length} file${results.length !== 1 ? "s" : ""} found:\n${results.join("\n")}`
            : "No files matched.") + (results.length === 0 ? await noMatchKnowledgeHint() : ""),
        };
      }

      case "delete_file": {
        const path = argStr(call.args["path"]);
        if (!path) throw new Error("Missing path argument");
        const { root: delRoot, parts: delParts } = resolveFileRoot(path, dirHandle, workspacePath);
        const fileName = delParts.pop()!;
        let parentHandle = delRoot;
        if (delParts.length > 0) {
          const resolved = await resolveDirHandle(delRoot, delParts);
          if (!resolved) throw new Error(`Directory not found: ${delParts.join("/")}`);
          parentHandle = resolved;
        }
        await parentHandle.removeEntry(fileName, { recursive: false });
        return {
          toolCallId: call.id,
          name: call.name,
          output: `Deleted: ${path}`,
        };
      }

      case "move_file": {
        const fromArg = argStr(call.args["from"]) || argStr(call.args["source"]) || argStr(call.args["path"]);
        const toArg = argStr(call.args["to"]) || argStr(call.args["destination"]);
        if (!fromArg) throw new Error("Missing 'from' argument");
        if (!toArg) throw new Error("Missing 'to' argument");
        const from = resolveNativeAbsolutePath(fromArg, workspacePath);
        const to = resolveNativeAbsolutePath(toArg, workspacePath);
        await tauriInvoke("fs_move", { from, to });
        return { toolCallId: call.id, name: call.name, output: `Moved ${from} -> ${to}`, resource: { kind: "file", path: to, label: `moved file to ${to}` } };
      }

      case "copy_file": {
        const fromArg = argStr(call.args["from"]) || argStr(call.args["source"]) || argStr(call.args["path"]);
        const toArg = argStr(call.args["to"]) || argStr(call.args["destination"]);
        if (!fromArg) throw new Error("Missing 'from' argument");
        if (!toArg) throw new Error("Missing 'to' argument");
        const from = resolveNativeAbsolutePath(fromArg, workspacePath);
        const to = resolveNativeAbsolutePath(toArg, workspacePath);
        await tauriInvoke("fs_copy", { from, to });
        return { toolCallId: call.id, name: call.name, output: `Copied ${from} -> ${to}`, resource: { kind: "file", path: to, label: `copied file to ${to}` } };
      }

      case "rename_file": {
        const pathArg = argStr(call.args["path"]);
        const newName = argStr(call.args["new_name"]) || argStr(call.args["name"]);
        if (!pathArg) throw new Error("Missing path argument");
        if (!newName) throw new Error("Missing new_name argument");
        if (newName.includes("/") || newName.includes("\\")) {
          throw new Error("new_name must be a plain name, not a path — use move_file to relocate to a different folder.");
        }
        const from = resolveNativeAbsolutePath(pathArg, workspacePath);
        const parentDir = from.slice(0, from.lastIndexOf("/"));
        const to = `${parentDir}/${newName}`;
        await tauriInvoke("fs_move", { from, to });
        return { toolCallId: call.id, name: call.name, output: `Renamed to ${to}`, resource: { kind: "file", path: to, label: `renamed file to ${to}` } };
      }

      case "get_known_folder": {
        const name = argStr(call.args["name"]);
        if (!name) throw new Error("Missing name argument");
        const path = await tauriInvoke<string>("get_known_folder", { name });
        const enabled = Object.values(useAgentStore.getState().extraRoots).some(
          (p) => p?.toLowerCase() === path.toLowerCase()
        );
        const note = enabled
          ? ""
          : `\n(Not yet enabled for file access — ask the user to turn it on in Settings > Privacy & Security before using it with other file tools.)`;
        return { toolCallId: call.id, name: call.name, output: path + note, resource: { kind: "path", path, label: `${name} folder at ${path}` } };
      }

      case "download_file": {
        const url = argStr(call.args["url"]);
        const destArg = argStr(call.args["dest_path"]) || argStr(call.args["path"]);
        if (!url) throw new Error("Missing url argument");
        if (!destArg) throw new Error("Missing dest_path argument");
        const destPath = resolveNativeAbsolutePath(destArg, workspacePath);
        const bytes = await tauriInvoke<number>("fetch_binary", { url, destPath });
        return { toolCallId: call.id, name: call.name, output: `Downloaded ${bytes} bytes to ${destPath}`, resource: { kind: "file", path: destPath, url, label: `downloaded file at ${destPath}` } };
      }

      case "remove_background": {
        const srcArg = argStr(call.args["src_path"]) || argStr(call.args["path"]);
        const destArg = argStr(call.args["dest_path"]);
        if (!srcArg) throw new Error("Missing src_path argument");
        if (!destArg) throw new Error("Missing dest_path argument");
        const srcPath = resolveNativeAbsolutePath(srcArg, workspacePath);
        const destPath = resolveNativeAbsolutePath(destArg, workspacePath);
        const srcBase64 = await tauriInvoke<string>("fs_read_file_base64", { path: srcPath });
        const srcBlob = base64ToBlob(srcBase64, "image/png");
        const { removeBackground } = await import("@imgly/background-removal");
        const resultBlob = await removeBackground(srcBlob);
        const resultBase64 = await blobToBase64(resultBlob);
        await tauriInvoke("fs_write_file_base64", { path: destPath, dataBase64: resultBase64 });
        return { toolCallId: call.id, name: call.name, output: `Background removed: ${destPath}`, resource: { kind: "file", path: destPath, label: `background-removed image at ${destPath}` } };
      }

      case "convert_image": {
        const srcArg = argStr(call.args["src_path"]) || argStr(call.args["path"]);
        const destArg = argStr(call.args["dest_path"]);
        if (!srcArg) throw new Error("Missing src_path argument");
        if (!destArg) throw new Error("Missing dest_path argument");
        const srcPath = resolveNativeAbsolutePath(srcArg, workspacePath);
        const destPath = resolveNativeAbsolutePath(destArg, workspacePath);
        const rawMaxW = call.args["max_width"];
        const rawMaxH = call.args["max_height"];
        const maxWidth = rawMaxW != null && Number.isFinite(Number(rawMaxW)) ? Math.floor(Number(rawMaxW)) : undefined;
        const maxHeight = rawMaxH != null && Number.isFinite(Number(rawMaxH)) ? Math.floor(Number(rawMaxH)) : undefined;
        await tauriInvoke("image_convert", { srcPath, destPath, maxWidth, maxHeight });
        return { toolCallId: call.id, name: call.name, output: `Converted: ${destPath}`, resource: { kind: "file", path: destPath, label: `converted image at ${destPath}` } };
      }

      case "compress_files": {
        const rawPaths = call.args["paths"];
        const inputPaths = Array.isArray(rawPaths) ? rawPaths.map((p) => String(p)) : [];
        if (inputPaths.length === 0) throw new Error("Missing paths argument (expected a non-empty array)");
        const destArg = argStr(call.args["dest_path"]);
        if (!destArg) throw new Error("Missing dest_path argument");
        const paths = inputPaths.map((p) => resolveNativeAbsolutePath(p, workspacePath));
        const destPath = resolveNativeAbsolutePath(destArg, workspacePath);
        await tauriInvoke("fs_compress", { paths, destPath });
        return { toolCallId: call.id, name: call.name, output: `Created archive: ${destPath}`, resource: { kind: "file", path: destPath, label: `created archive at ${destPath}` } };
      }

      case "extract_archive": {
        const archiveArg = argStr(call.args["archive_path"]) || argStr(call.args["path"]);
        const destArg = argStr(call.args["dest_dir"]);
        if (!archiveArg) throw new Error("Missing archive_path argument");
        if (!destArg) throw new Error("Missing dest_dir argument");
        const archivePath = resolveNativeAbsolutePath(archiveArg, workspacePath);
        const destDir = resolveNativeAbsolutePath(destArg, workspacePath);
        await tauriInvoke("fs_extract", { archivePath, destDir });
        return { toolCallId: call.id, name: call.name, output: `Extracted to: ${destDir}`, resource: { kind: "path", path: destDir, label: `extracted archive to ${destDir}` } };
      }

      case "pdf_merge": {
        const rawPaths = call.args["paths"];
        const inputPaths = Array.isArray(rawPaths) ? rawPaths.map((p) => String(p)) : [];
        if (inputPaths.length < 2) throw new Error("Missing paths argument (expected an array of at least 2 PDF paths)");
        const destArg = argStr(call.args["dest_path"]);
        if (!destArg) throw new Error("Missing dest_path argument");
        const paths = inputPaths.map((p) => resolveNativeAbsolutePath(p, workspacePath));
        const destPath = resolveNativeAbsolutePath(destArg, workspacePath);
        await tauriInvoke("pdf_merge", { paths, destPath });
        return { toolCallId: call.id, name: call.name, output: `Merged PDF: ${destPath}`, resource: { kind: "file", path: destPath, label: `merged PDF at ${destPath}` } };
      }

      case "pdf_to_text": {
        const pathArg = argStr(call.args["path"]);
        if (!pathArg) throw new Error("Missing path argument");
        const path = resolveNativeAbsolutePath(pathArg, workspacePath);
        const text = await tauriInvoke<string>("pdf_to_text", { path });
        return { toolCallId: call.id, name: call.name, output: text };
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
          const opParts = resolveWorkspaceRelativeParts(op.path, workspacePath);
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
        const succeeded = results.length - failed;
        return {
          toolCallId: call.id,
          name: call.name,
          output: results.join("\n"),
          ...(failed > 0 ? { error: `${failed} patch${failed !== 1 ? "es" : ""} failed` } : {}),
          ...(succeeded > 0 ? { resource: { kind: "file" as const, label: `patched ${succeeded} file${succeeded !== 1 ? "s" : ""}` } } : {}),
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
          resource: { kind: "file", path: `.localmind/skills/${filename}`, label: `saved skill at .localmind/skills/${filename}` },
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
        const diff = argStr(call.args["diff"]);

        // Regression baseline: if this workspace has any saved benchmarks, run
        // them now and fold the score into the proposal body — gives whoever
        // reviews the proposal a concrete "was passing N/M before" number to
        // compare against after applying the change, rather than propose_feature
        // being pure prose with no way to tell if a fix actually helped.
        // Best-effort only: a benchmark run failing/timing out must never block
        // saving the proposal itself.
        let benchmarkNote = "";
        try {
          const modelRef = useModelSelectionStore.getState().selectedModel;
          const summary = modelRef ? await runBenchmarkSuite(dirHandle, modelRef) : null;
          if (summary) {
            benchmarkNote = `\n\n---\n**Benchmark baseline at proposal time:** ${summary.passed}/${summary.total} passed` +
              (summary.failed.length > 0 ? ` (failing: ${summary.failed.join(", ")})` : "") +
              `. Re-run the Benchmarks tab after applying this change to confirm nothing regressed.`;
          }
        } catch {
          // No workspace benchmarks, no model selected, or a run errored — the
          // proposal still saves without a baseline note.
        }

        const bodyParts = [argStr(call.args["details"])];
        if (diff) bodyParts.push(`\n\n---\n**Proposed diff:**\n\n${diff}`);
        bodyParts.push(benchmarkNote);

        const path = await saveImprovement(dirHandle, {
          title,
          motivation: argStr(call.args["motivation"]),
          proposed_files: argStr(call.args["proposed_files"]),
          acceptance_criteria: argStr(call.args["acceptance_criteria"]),
          size_guess: argStr(call.args["size_guess"]),
          body: bodyParts.join(""),
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
          resource: { kind: "path", path: targetPath, label: `created folder at ${targetPath}` },
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

      case "save_workflow": {
        const name = argStr(call.args["name"]);
        const description = argStr(call.args["description"]);
        const rawInstruction = argStr(call.args["instruction"]);
        const rawSteps = argStrArray(call.args["steps"]);
        if (!name) throw new Error("Missing name argument");
        if (!description) throw new Error("Missing description argument");
        if (!rawInstruction && rawSteps.length === 0) throw new Error("Missing instruction argument");

        // steps is the source of truth when given — instruction is compiled
        // from it (see store/workflows.ts's compileInstruction) so the visual
        // editor in the Workflows tab stays meaningful; falls back to wrapping
        // the plain instruction as a single step when the model didn't break
        // the goal down.
        const steps = rawSteps.length > 0 ? rawSteps : [rawInstruction];
        const instruction = rawSteps.length > 0 ? compileInstruction(rawSteps) : rawInstruction;

        // Name-based idempotency: unlike schedule_task's identical-spec check,
        // each workflow gets a fresh random id every call, so an identical-spec
        // check would never match — dedupe by name instead, and hand back the
        // existing workflow rather than creating a near-duplicate if a weak
        // model re-emits this call across rounds.
        const existing = useWorkflowStore.getState().workflows.find(
          (w) => w.name.toLowerCase() === name.toLowerCase(),
        );
        if (existing) {
          return {
            toolCallId: call.id,
            name: call.name,
            output: `A workflow named "${existing.name}" already exists (id ${existing.id}, output file ${existing.outputFile}). No duplicate was created — this task is done.`,
          };
        }

        const rawSchedule = argStr(call.args["schedule"]);
        const schedule = rawSchedule ? normalizeSchedule(rawSchedule) : null;

        const mcpLabels = argStrArray(call.args["mcp_servers"]);
        const mcpServerIds: string[] = [];
        for (const label of mcpLabels) {
          const server = useMcpStore.getState().servers.find((s) => s.label.toLowerCase() === label.toLowerCase());
          if (!server || !server.enabled || server.status !== "connected") {
            throw new Error(
              `MCP server "${label}" is not currently connected — the user must add and connect it under Settings → MCP servers before this workflow can use it unattended.`,
            );
          }
          mcpServerIds.push(server.id);
        }

        const slug =
          name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "workflow";
        const outputFormat = argStr(call.args["output_format"]).toLowerCase() === "html" ? "html" : "markdown";
        const outputFile = `.localmind/workflows/${slug}/output.${outputFormat === "html" ? "html" : "md"}`;

        const id = crypto.randomUUID();
        const now = Date.now();
        let jobId: string | null = null;
        if (schedule) {
          const spec = buildJobSpec(instruction, schedule, id);
          const nextRunAt = computeInitialNextRun(schedule);
          jobId = crypto.randomUUID();
          await tauriInvoke("jobs_insert", { id: jobId, spec, nextRunAt, status: "active" });
        }

        const workflow: Workflow = {
          id,
          name,
          description,
          instruction,
          steps,
          toolAllowlist: [],
          mcpServerIds,
          outputFile,
          schedule,
          jobId,
          createdAt: now,
          updatedAt: now,
          lastRunAt: null,
          lastRunOutcome: null,
          runCount: 0,
        };
        useWorkflowStore.getState().addWorkflow(workflow);

        const scheduleText = schedule
          ? describeSchedule(schedule)
          : "manual — run it anytime from the Workflows tab or by asking me";
        return {
          toolCallId: call.id,
          name: call.name,
          output: `Saved workflow "${name}" (id ${id}). Output file: ${outputFile}. Schedule: ${scheduleText}.`,
        };
      }

      case "list_workflows": {
        const workflows = useWorkflowStore.getState().workflows;
        if (workflows.length === 0) {
          return { toolCallId: call.id, name: call.name, output: "No saved workflows." };
        }
        const lines = workflows.map((w) => {
          const scheduleText = w.schedule ? describeSchedule(w.schedule) : "manual";
          const lastRun = w.lastRunAt
            ? `${w.lastRunOutcome ?? "?"} at ${new Date(w.lastRunAt).toLocaleString()}`
            : "never run";
          return `- ${w.id}: "${w.name}" — ${w.description} — ${scheduleText} — output: ${w.outputFile} — last run: ${lastRun}`;
        });
        return { toolCallId: call.id, name: call.name, output: lines.join("\n") };
      }

      case "run_workflow": {
        const idOrName = argStr(call.args["id_or_name"]);
        if (!idOrName) throw new Error("Missing id_or_name argument");
        const workflow = useWorkflowStore
          .getState()
          .workflows.find((w) => w.id === idOrName || w.name.toLowerCase() === idOrName.toLowerCase());
        if (!workflow) throw new Error(`No workflow found matching "${idOrName}". Use list_workflows first.`);

        // Dynamic import avoids a static circular dependency (workflowRunner.ts
        // imports headlessRunner.ts, which imports TOOL_DEFINITIONS from this file).
        const { runWorkflow } = await import("./workflowRunner");
        const { record, transcript } = await runWorkflow(workflow, { origin: "workflow" });

        const trimmedTranscript = transcript.trim().slice(0, 4000);
        return {
          toolCallId: call.id,
          name: call.name,
          output:
            `Workflow "${workflow.name}" finished — outcome: ${record.outcome}, ${record.roundsUsed} round(s).\n\n` +
            `Summary: ${record.summary}\n\n` +
            `Transcript:\n${trimmedTranscript}${transcript.trim().length > 4000 ? "\n\n…(truncated)" : ""}`,
        };
      }

      case "delete_workflow": {
        const idOrName = argStr(call.args["id_or_name"]);
        if (!idOrName) throw new Error("Missing id_or_name argument");
        const workflow = useWorkflowStore
          .getState()
          .workflows.find((w) => w.id === idOrName || w.name.toLowerCase() === idOrName.toLowerCase());
        if (!workflow) throw new Error(`No workflow found matching "${idOrName}". Use list_workflows first.`);

        const { deleteWorkflow } = await import("./workflowRunner");
        await deleteWorkflow(workflow.id);

        return {
          toolCallId: call.id,
          name: call.name,
          output: `Deleted workflow "${workflow.name}". Its output file (${workflow.outputFile}) was left in place.`,
        };
      }

      case "notify_user": {
        const title = argStr(call.args["title"]);
        const message = argStr(call.args["message"]);
        if (!title) throw new Error("Missing title argument");
        if (!message) throw new Error("Missing message argument");
        await notifyOs(title, message);
        return {
          toolCallId: call.id,
          name: call.name,
          output: `Notification sent: "${title}" — ${message}`,
        };
      }

      case "render_canvas": {
        const html = argStr(call.args["html"]);
        if (!html) throw new Error("Missing html argument");
        const title = argStr(call.args["title"]) || undefined;
        const id = useArtifactStore.getState().add({ kind: "canvas", title, html: wrapHtmlDocument(html) });
        return {
          toolCallId: call.id,
          name: call.name,
          output: `[[LM_ARTIFACT:${id}]] Rendered${title ? ` "${title}"` : " an"} interactive canvas.`,
          resource: { kind: "artifact", id, label: `rendered canvas${title ? ` "${title}"` : ""}` },
        };
      }

      case "plot_graph": {
        const expressions = argStrArray(call.args["expressions"]);
        const seriesArg = call.args["series"];
        const title = argStr(call.args["title"]) || undefined;
        const xMinArg = call.args["xMin"];
        const xMaxArg = call.args["xMax"];
        const xMin = typeof xMinArg === "number" ? xMinArg : -10;
        const xMax = typeof xMaxArg === "number" ? xMaxArg : 10;

        const curves: { label: string; points: [number, number][] }[] = [];
        const SAMPLES = 400;
        for (const expr of expressions) {
          let node;
          try {
            node = compile(expr);
          } catch {
            throw new Error(`Could not parse expression "${expr}" — use mathjs syntax (e.g. "sin(x)*x", "x^2 - 3").`);
          }
          const points: [number, number][] = [];
          for (let i = 0; i <= SAMPLES; i++) {
            const x = xMin + (xMax - xMin) * (i / SAMPLES);
            try {
              const y = node.evaluate({ x });
              if (typeof y === "number" && Number.isFinite(y)) points.push([x, y]);
            } catch {
              // Undefined at this x (e.g. 1/x at x=0) — skip the point, not the whole curve.
            }
          }
          curves.push({ label: expr, points });
        }
        if (Array.isArray(seriesArg)) {
          for (const s of seriesArg) {
            if (s && typeof s === "object" && Array.isArray((s as Record<string, unknown>)["points"])) {
              const rawPoints = (s as Record<string, unknown>)["points"] as unknown[];
              const points = rawPoints.filter(
                (p): p is [number, number] => Array.isArray(p) && p.length === 2 && typeof p[0] === "number" && typeof p[1] === "number"
              );
              curves.push({ label: String((s as Record<string, unknown>)["label"] ?? "series"), points });
            }
          }
        }
        if (curves.length === 0) throw new Error("Provide at least one expression or a data series to plot");

        const html = buildPlotHtml(curves, { title, xMin, xMax });
        const id = useArtifactStore.getState().add({ kind: "plot", title, html });
        return {
          toolCallId: call.id,
          name: call.name,
          output: `[[LM_ARTIFACT:${id}]] Plotted ${curves.map((c) => c.label).join(", ")}.`,
          resource: { kind: "artifact", id, label: `plotted ${curves.map((c) => c.label).join(", ")}` },
        };
      }

      case "render_table": {
        const columns = argStrArray(call.args["columns"]);
        const rowsArg = call.args["rows"];
        if (columns.length === 0) throw new Error("Missing columns argument");
        if (!Array.isArray(rowsArg)) throw new Error("Missing rows argument (array of arrays)");
        const rows = rowsArg.filter((r): r is unknown[] => Array.isArray(r));
        const title = argStr(call.args["title"]) || undefined;
        const id = useArtifactStore.getState().add({ kind: "table", title, columns, rows });
        return {
          toolCallId: call.id,
          name: call.name,
          output: `[[LM_ARTIFACT:${id}]] Rendered a ${rows.length}-row table${title ? ` "${title}"` : ""}.`,
          resource: { kind: "artifact", id, label: `rendered a ${rows.length}-row table${title ? ` "${title}"` : ""}` },
        };
      }

      case "show_webpage": {
        const url = argStr(call.args["url"]).trim();
        if (!url) throw new Error("Missing url argument");
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          throw new Error("url must start with http:// or https://");
        }
        const title = argStr(call.args["title"]) || undefined;

        let blocked = false;
        let readableHtml = "";
        try {
          const res = await tauriInvoke<{ status: number; headers: [string, string][]; body: string }>(
            "http_fetch_with_headers",
            { url },
          );
          const headerMap = new Map(res.headers.map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]));
          const xfo = headerMap.get("x-frame-options") ?? "";
          const csp = headerMap.get("content-security-policy") ?? "";
          blocked = xfo.includes("deny") || xfo.includes("sameorigin") || csp.includes("frame-ancestors");
          readableHtml = stripToReadable(res.body);
        } catch (err) {
          throw new Error(`Could not reach ${url}: ${(err as Error).message}`);
        }

        const id = useArtifactStore.getState().add({ kind: "webpage", title, url, blocked, html: readableHtml });
        return {
          toolCallId: call.id,
          name: call.name,
          output: `[[LM_ARTIFACT:${id}]] ${blocked ? `Showing a reader view of ${url} (this site blocks being embedded directly).` : `Showing ${url} inline.`}`,
        };
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

      case "spawn_reviewer_subagent": {
        const reviewWorkspacePath = useAgentStore.getState().workspacePath ?? workspacePath;
        if (!reviewWorkspacePath) {
          throw new Error("spawn_reviewer_subagent requires an open workspace — ask the user to open a folder first.");
        }
        const taskDescription = argStr(call.args["task_description"]);
        if (!taskDescription) throw new Error("Missing task_description argument");
        const rawSince = call.args["since_commits"];
        const sinceCommits = typeof rawSince === "number" && rawSince > 0 ? Math.floor(rawSince) : 10;
        const reviewModel = argStr(call.args["model"]) || useModelSelectionStore.getState().selectedModel;
        if (!reviewModel) throw new Error("No model specified and no default model is selected.");
        const reviewHardware = useModelStore.getState().hardware;

        // Fetch one more than the window so the (N+1)th commit's tree can serve
        // as the diff's base — otherwise the oldest commit in the window would
        // be excluded from its own diff (it'd only be the base, never merged in).
        const history = await listShadowHistory(reviewWorkspacePath, undefined, sinceCommits + 1);
        if (history.length === 0) {
          return {
            toolCallId: call.id,
            name: call.name,
            output: "No shadow-history changes recorded yet for this workspace — nothing to review.",
          };
        }
        const headOid = history[0].oid;
        const baseOid = history.length > sinceCommits ? history[sinceCommits].oid : undefined;
        const diff = await diffShadowRange(reviewWorkspacePath, baseOid, headOid);
        if (!diff.trim()) {
          return {
            toolCallId: call.id,
            name: call.name,
            output: "The recent shadow-history commits produced an empty diff (net no-op) — nothing to review.",
          };
        }
        const MAX_DIFF_CHARS = 20000;
        const truncatedDiff = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n…(diff truncated)` : diff;

        const reviewTask = `You are doing an independent code review with completely fresh eyes — you did not write any of this code and have no context beyond what's given here, so don't assume it's correct just because it exists.\n\nThe work was supposed to accomplish: ${taskDescription}\n\nBelow is a unified diff of what actually changed. Review it for correctness bugs, regressions, missed edge cases, and anywhere it diverges from the stated goal. Use read_file/grep_files if the diff alone doesn't give enough context to judge a change. Report your findings as a concise list; if you genuinely find nothing wrong, say so plainly rather than inventing something to flag.\n\n--- DIFF ---\n${truncatedDiff}\n--- END DIFF ---`;

        // Dynamic import avoids a static circular dependency (headlessRunner.ts
        // imports TOOL_DEFINITIONS from this file).
        const { runHeadlessTask, HEADLESS_DEFAULT_ALLOWLIST } = await import("./headlessRunner");

        const { record, transcript } = await runHeadlessTask({
          workspacePath: reviewWorkspacePath,
          modelRef: reviewModel,
          task: reviewTask,
          hardware: reviewHardware,
          origin: "subagent",
          agentBuildMode: true,
          // Read-only: a reviewer that can edit files defeats the point of a
          // fresh, independent second opinion — it should only read and report.
          toolAllowlist: HEADLESS_DEFAULT_ALLOWLIST,
        });

        const trimmedTranscript = transcript.trim().slice(0, 4000);
        return {
          toolCallId: call.id,
          name: call.name,
          output:
            `Reviewer subagent (${reviewModel}) finished — outcome: ${record.outcome}, ${record.roundsUsed} round(s).\n\n` +
            `Findings:\n${trimmedTranscript}${transcript.trim().length > 4000 ? "\n\n…(truncated)" : ""}`,
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

      case "close_window": {
        const id = argStr(call.args["id"]);
        if (!id) throw new Error("Missing id argument");
        const output = await tauriInvoke<string>("close_window", { id });
        return { toolCallId: call.id, name: call.name, output };
      }

      case "minimize_window": {
        const id = argStr(call.args["id"]);
        if (!id) throw new Error("Missing id argument");
        const output = await tauriInvoke<string>("minimize_window", { id });
        return { toolCallId: call.id, name: call.name, output };
      }

      case "uia_list_elements": {
        const windowId = argStr(call.args["window_id"]);
        if (!windowId) throw new Error("Missing window_id argument");
        const controlType = argStr(call.args["control_type"]) || undefined;
        const elements = await tauriInvoke<
          Array<{ name: string; control_type: string; automation_id: string; is_enabled: boolean; supported_actions: string[] }>
        >("uia_list_elements", { windowId, controlType });
        const output = elements.length
          ? elements
              .map(
                (e, i) =>
                  `${i + 1}. "${e.name}" [${e.control_type}]${e.automation_id ? ` #${e.automation_id}` : ""}${e.is_enabled ? "" : " (disabled)"} — actions: ${e.supported_actions.join(", ") || "none"}`,
              )
              .join("\n")
          : "(no matching elements found)";
        return { toolCallId: call.id, name: call.name, output };
      }

      case "uia_click_element": {
        const windowId = argStr(call.args["window_id"]);
        const name = argStr(call.args["name"]);
        if (!windowId || !name) throw new Error("Missing window_id/name argument");
        const controlType = argStr(call.args["control_type"]) || undefined;
        const output = await tauriInvoke<string>("uia_click_element", { windowId, name, controlType });
        return { toolCallId: call.id, name: call.name, output };
      }

      case "uia_read_element_text": {
        const windowId = argStr(call.args["window_id"]);
        const name = argStr(call.args["name"]);
        if (!windowId || !name) throw new Error("Missing window_id/name argument");
        const controlType = argStr(call.args["control_type"]) || undefined;
        const output = await tauriInvoke<string>("uia_read_element_text", { windowId, name, controlType });
        return { toolCallId: call.id, name: call.name, output };
      }

      case "uia_set_element_text": {
        const windowId = argStr(call.args["window_id"]);
        const name = argStr(call.args["name"]);
        const value = argStr(call.args["value"]);
        if (!windowId || !name) throw new Error("Missing window_id/name argument");
        const controlType = argStr(call.args["control_type"]) || undefined;
        const output = await tauriInvoke<string>("uia_set_element_text", { windowId, name, value, controlType });
        return { toolCallId: call.id, name: call.name, output };
      }

      case "list_processes": {
        const processes = await tauriInvoke<Array<{ pid: number; name: string }>>("list_processes");
        const output = processes.length === 0
          ? "No processes found."
          : processes.map((p) => `${p.pid}\t${p.name}`).join("\n");
        return { toolCallId: call.id, name: call.name, output };
      }

      case "kill_process": {
        const rawPid = call.args["pid"];
        const pid = rawPid != null ? Math.floor(Number(rawPid)) : NaN;
        if (!Number.isFinite(pid) || pid <= 0) throw new Error("Missing or invalid pid argument");
        const output = await tauriInvoke<string>("kill_process", { pid });
        return { toolCallId: call.id, name: call.name, output };
      }

      case "get_disk_usage": {
        const path = argStr(call.args["path"]) || undefined;
        const usage = await tauriInvoke<{ total_bytes: number; free_bytes: number }>("get_disk_usage", { path });
        const gb = (n: number) => (n / (1024 ** 3)).toFixed(1);
        return {
          toolCallId: call.id,
          name: call.name,
          output: `${gb(usage.free_bytes)} GB free of ${gb(usage.total_bytes)} GB total`,
        };
      }

      case "empty_recycle_bin": {
        const output = await tauriInvoke<string>("empty_recycle_bin");
        return { toolCallId: call.id, name: call.name, output };
      }

      case "adjust_volume": {
        const action = argStr(call.args["action"]);
        if (!action) throw new Error("Missing action argument");
        const output = await tauriInvoke<string>("adjust_volume", { action });
        return { toolCallId: call.id, name: call.name, output };
      }

      case "speak_text": {
        const rawText = argStr(call.args["text"]);
        if (!rawText) throw new Error("Missing text argument");
        const truncated = rawText.length > SPEAK_TEXT_MAX_CHARS;
        const text = truncated ? rawText.slice(0, SPEAK_TEXT_MAX_CHARS) : rawText;
        try {
          await speakText(text);
          return {
            toolCallId: call.id,
            name: call.name,
            output: truncated ? `Spoke the text aloud (truncated to ${SPEAK_TEXT_MAX_CHARS} characters).` : "Spoke the text aloud.",
          };
        } catch {
          // Web Speech API unavailable/errored — fall back to the Rust/SAPI path
          // (always available on Windows, lower voice quality).
          const output = await tauriInvoke<string>("speak_text", { text });
          return { toolCallId: call.id, name: call.name, output };
        }
      }

      case "print_file": {
        const pathArg = argStr(call.args["path"]);
        if (!pathArg) throw new Error("Missing path argument");
        const path = resolveNativeAbsolutePath(pathArg, workspacePath);
        const output = await tauriInvoke<string>("print_file", { path });
        return { toolCallId: call.id, name: call.name, output };
      }

      case "remind_me": {
        const message = argStr(call.args["message"]) || argStr(call.args["reminder"]) || argStr(call.args["text"]);
        if (!message) throw new Error("Missing message argument");
        const rawAtUnix = call.args["at_unix_seconds"];
        const rawInMinutes = call.args["in_minutes"];
        let atSeconds: number;
        if (rawAtUnix != null && Number.isFinite(Number(rawAtUnix))) {
          atSeconds = Math.floor(Number(rawAtUnix));
        } else if (rawInMinutes != null && Number.isFinite(Number(rawInMinutes))) {
          atSeconds = Math.floor(Date.now() / 1000) + Math.round(Number(rawInMinutes) * 60);
        } else {
          throw new Error("Provide either in_minutes (relative) or at_unix_seconds (absolute — use get_current_datetime first if computing a specific clock time).");
        }
        const schedule = normalizeSchedule(`once:${atSeconds}`);
        const task = `This is a one-time scheduled reminder. Do not call any tools — simply respond with exactly this reminder text so it can be shown to the user: "${message}"`;
        const spec = buildJobSpec(task, schedule);
        const id = crypto.randomUUID();
        await tauriInvoke("jobs_insert", { id, spec, nextRunAt: computeInitialNextRun(schedule), status: "active" });
        return {
          toolCallId: call.id,
          name: call.name,
          output: `Reminder set: "${message}" (${describeSchedule(schedule)}). Job id: ${id}. This task is now done — do not schedule it again.`,
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
          resource: { kind: "file", path: result.path, label: `screenshot at ${result.path}` },
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
