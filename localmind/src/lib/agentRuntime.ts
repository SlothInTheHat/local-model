import type { ChatMessage } from "./ollama";
import type { ToolDef, ToolCall, ToolResult } from "./tools";
import { executeTool, normalizeSubPath, canonicalToolName, TOOL_DEFINITIONS } from "./tools";
import { runAgentTurnForModel, streamChatForModel } from "./chatProvider";
import { resolveNumCtx, compactHistoryIfOverBudget, capToolOutput } from "./contextSize";
import { fileExists, listDirectory } from "./fileSystem";
import type { FileEntry } from "./fileSystem";
import type { HardwareInfo } from "./hardware";
import { formatMemoryForContext, readProjectMemory } from "./projectMemory";
import { searchMemory, formatMemoriesForContext, distillAndSaveMemories } from "./vectorMemory";
import { loadSkills, matchSkills, formatSkillsForContext } from "./skillEngine";
import type { Skill } from "./skillEngine";
import { formatToolLabel, summariseToolResult } from "./toolFormatting";
import { StuckDetector, errorRecoveryHint, toolResultFailed } from "./stuckDetector";
import { filterToolsByRelevance } from "./toolFilter";
import { buildCapabilityBlock } from "./capabilityRegistry";
import type { AppView } from "../types/app";
import { useTaskQueueStore } from "../store/taskQueue";
import { usePendingSkillsStore } from "../store/pendingSkills";

export const DEFAULT_MAX_ROUNDS = 50;

/** How many times a no-tool-call round can trigger a completion review before the session ends regardless. */
const MAX_COMPLETION_CHECKS = 2;

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

/**
 * Read-only / harmless alias keys accepted by tools.ts `executeTool` (its local
 * TOOL_ALIASES map) that normalize to a built-in read tool. We whitelist ONLY
 * these so a model saying e.g. "grep" or "cat" isn't misclassified as an
 * external tool and needlessly prompted for approval. Mutating/dangerous alias
 * keys (write, run, exec, bash, mkdir, install_*, …) are DELIBERATELY omitted:
 * they fall through to the external-tool default-deny gate below, so an aliased
 * write/run gets denied in Plan mode and requires approval in Build mode.
 * Keep in sync with the read-only entries of TOOL_ALIASES in tools.ts.
 */
const READ_ONLY_ALIASES = [
  "search_web", "google", "search",       // → web_search
  "fetch_url", "fetch",                    // → web_fetch
  "search_files", "grep", "find_in_files", // → grep_files
  "find",                                  // → find_files
  "ls", "list",                            // → list_directory
  "read", "cat",                           // → read_file
  "transcribe", "transcribe_audio",        // → transcribe_video
];

export interface OpenFileInfo {
  path: string;
  content: string;
  language: string;
}

export interface AgentRuntimeConfig {
  modelRef: string;
  hardware: HardwareInfo | null;
  numCtxOverride: number | null;

  dirHandle: FileSystemDirectoryHandle | null;
  workspacePath: string | null;
  workspaceName: string | null;
  /** The tab this agent session is running in — used to surface tasks queued for this tab via send_task_to_tab. */
  currentView: AppView;

  tools: ToolDef[];
  agentBuildMode: boolean;
  autoApproveAll: boolean;
  toolsSupported: boolean;
  maxRounds: number;
  /**
   * Conversational ("restricted agent") mode: the message was classified as a
   * question/chat rather than a build task. Tools stay available but the
   * coding-loop framing and on-disk project state (todos/memory/tree/skills)
   * are suppressed so stale project context can't hijack the answer.
   */
  conversational?: boolean;

  /**
   * This session's whole point is to mutate the workspace (scheduler /
   * task-queue runs) — there's no chat UI for anyone to read a text-only
   * answer. When set, the inaction-nudge (below) also fires if the session
   * made tool calls but NONE of them were mutating — e.g. calling
   * get_current_datetime, seeing the answer, and just describing it in text
   * instead of continuing on to write_file. Left unset for interactive/
   * subagent sessions, where stopping after read-only tool calls can be the
   * correct, complete answer (e.g. "what's in package.json?").
   */
  expectSideEffects?: boolean;

  /**
   * Suppress on-disk project state (todos/memory/file-tree/skills) in the
   * "Current state" block — the same protection conversational mode already
   * has, for the same reason: stale leftover state from ordinary interactive
   * use of this workspace (e.g. a todo from an earlier unrelated coding
   * session) can "hijack" the model into acting on it instead of the actual
   * instruction. Observed live: a scheduled "append the time to notes.md" run
   * called save_skill("Create game.py") mid-task — a leftover todo/skill from
   * prior interactive work in the same workspace, surfaced in this block,
   * pulled the model off-task. Headless runs (scheduler/task-queue/subagent)
   * always set this — unlike conversational mode, they keep the full
   * coding-loop system prompt (they still need to act), just not this stale
   * background noise.
   */
  suppressStaleProjectState?: boolean;

  getCurrentOpenFile?: () => OpenFileInfo | null;

  onTextDelta?: (chunk: string) => void;
  onTextReplace?: (cleanText: string) => void;
  onToolCallStart?: (call: ToolCall, label: string) => void;
  onApprovalNeeded: (call: ToolCall) => Promise<boolean>;
  onToolCallResolved?: (call: ToolCall, label: string, result: ToolResult, summary: string, toolContent: string) => void;
  onRoundStart?: (round: number, maxRounds: number) => void;
  onTodosChanged?: (todos: TodoItem[]) => void;
  onMemoryChanged?: (memory: string) => void;
  onActivity?: (label: string | null) => void;

  signal: AbortSignal;
}

export interface AgentRuntimeResult {
  hadSideEffects: boolean;
  hitRoundLimit: boolean;
  wasAborted: boolean;
  roundsUsed: number;
  finalHistory: ChatMessage[];
  /**
   * True if any tool call was auto-denied this session (headless allowlist
   * miss, e.g. a scheduled/queued run reaching for run_command). The model
   * may have recovered via a different tool — callers combine this with
   * hadSideEffects to judge whether the task actually completed rather than
   * trusting the model's own "done" text after a silent denial.
   */
  hadDeniedToolCalls: boolean;
}

/** Shared "Runtime: model=..., OS=..., GPU=..., workspace=..." line used by both the agent system prompt and normal-chat identity prompt. */
export function buildRuntimeLine(
  modelRef: string,
  hardware: HardwareInfo | null,
  workspaceName: string | null,
  workspacePath: string | null,
): string {
  let runtimeLine = `Runtime: model=${modelRef}, OS=${navigator.platform}`;
  if (hardware) {
    runtimeLine += `, GPU=${hardware.gpuName} (${hardware.vramGb}GB VRAM), RAM=${hardware.ramGb}GB`;
  }
  runtimeLine += workspaceName
    ? `, workspace=${workspaceName}${workspacePath ? ` (${workspacePath})` : ""}`
    : ", workspace=none (no folder connected)";
  return runtimeLine;
}

/**
 * Baseline "what am I" context for normal (non-agent) chat — without this, the model
 * gets zero information about LocalMind, the connected workspace, or the host hardware
 * and behaves like a generic chatbot. Normal chat has no session-scoped tool list (it
 * doesn't call tools at all), so it advertises the full static built-in set.
 */
export function buildIdentitySystemPrompt(
  modelRef: string,
  hardware: HardwareInfo | null,
  workspaceName: string | null,
  workspacePath: string | null,
  memoryBlock?: string,
): string {
  const lines = [
    buildCapabilityBlock(TOOL_DEFINITIONS),
    "",
    buildRuntimeLine(modelRef, hardware, workspaceName, workspacePath),
  ];
  lines.push(
    workspaceName
      ? "A workspace folder is connected. You do not have live file access in this normal chat — if the user wants you to read/edit files or explore the project, tell them to enable Agent mode."
      : "No workspace folder is connected and you have no file access. If the user asks about their files/project, tell them to enable Agent mode and use 'Open Folder' to connect one.",
  );
  if (memoryBlock) {
    lines.push("", memoryBlock);
  }
  return lines.join("\n");
}

/**
 * Lightweight system prompt for conversational ("restricted agent") turns.
 * No coding-loop scaffolding, no todo/plan framing — just identity + the
 * available tools, with explicit instructions not to resume prior work.
 */
function buildConversationalSystemPrompt(config: AgentRuntimeConfig): string {
  const sessionTools = config.toolsSupported ? config.tools : [];
  const lines: string[] = [
    "You are LocalMind's assistant, answering the user conversationally.",
    "",
    buildRuntimeLine(config.modelRef, config.hardware, config.workspaceName, config.workspacePath),
    "",
    "## How to respond",
    "- Answer the user's latest message directly, in plain prose.",
    "- You are NOT resuming any prior project, plan, or todo list, and there is no task in progress. Ignore any leftover todos or project notes — they are not part of this request.",
    "- Use a tool ONLY if the user's message explicitly requires reading or searching a file right now (use only if truly needed). Most questions need no tool at all — just answer.",
    "- Do NOT create or update todos, do NOT call switch_view to navigate tabs, and do NOT web_search for information about LocalMind itself (use the 'About LocalMind' section below — web results for \"LocalMind\" are unrelated third-party apps).",
    "",
    buildCapabilityBlock(sessionTools),
  ];

  return lines.join("\n");
}

// NOTE — a dedicated short "unattended background agent" prompt for
// expectSideEffects sessions was tried here and REMOVED after a faithful
// harness A/B (scratchpad/faithful_sched_harness.js, 2026-07-06): under the
// short prompt qwen2.5:7b emitted EMPTY responses and stopped in 4/5 runs
// (and abandoned native tool calls in the 5th), while the full BUILD prompt
// below passed 3/3 once the accumulated guards existed (get_current_datetime,
// read-before-write recovery, info-only-calls nudge, stale-state suppression,
// knowledge-writer tools removed from the headless offering). Don't reintroduce
// a lean unattended prompt without re-running that harness.
function buildSystemPrompt(config: AgentRuntimeConfig): string {
  if (config.conversational) return buildConversationalSystemPrompt(config);

  const modeTag = config.agentBuildMode ? "BUILD" : "PLAN";
  const lines: string[] = [];

  const runtimeLine = buildRuntimeLine(config.modelRef, config.hardware, config.workspaceName, config.workspacePath);

  lines.push(
    `You are a coding agent operating in ${modeTag} MODE.`,
    config.agentBuildMode
      ? "BUILD MODE: full access — read, write, patch, run commands, manage todos."
      : "PLAN MODE (read-only): you may read files, search, and call todo_write. write_file/patch_file/apply_patch/delete_file/run_command/install_deps/git_add/git_commit are denied — explore and plan; the user will switch to Build mode to execute.",
    "",
    "You ACT by emitting real tool calls — you are NOT a help assistant describing an app. When the user asks you to do something, CALL THE TOOL that does it. NEVER instead tell the user to do it themselves ('switch to the Settings tab', 'use the scheduling feature', 'you can run…') — you have the tools, so you do it. NEVER write a tool call as text, code, or pseudo-code (typing `schedule_task(...)` or a JSON blob in your reply does NOT call it) — emit it as an actual tool call. The tabs/features described below are context about the app, NOT instructions to hand back to the user.",
    "",
    runtimeLine,
    "",
    "## Core loop — every round",
    "0. SCOPE CHECK: if this message is a question or conversation about LocalMind itself (its tabs, tools, features, or capabilities) rather than a request to build, modify, or debug something in the workspace, answer directly from the 'About LocalMind' section below in plain text — no tool calls, no todo list, no web_search, no switch_view. That section is authoritative; web search results for \"LocalMind\" describe unrelated third-party apps that happen to share the name and must never be used to answer this kind of question.",
    "1. ORIENT: read the 'Current state' block below (todos, file tree, last action, open file, relevant skills). Don't re-list a directory you've already seen — read the files inside it instead.",
    "2. SKILL CHECK (Round 1 of a real multi-step build/coding task only — skip for quick questions or small one-off edits): if 'Relevant skills' are listed below, those are skills you already have for this — use them and do NOT search for replacements. If none are listed, you may run ONE web_search for an existing published skill/guide for this kind of task (e.g. \"claude code skill <topic>\", \"agent skill <topic>\"). If a result looks clearly useful, web_fetch it and call save_skill to install it (the user will be asked to approve) before continuing. If nothing relevant turns up, just proceed — never search or install a skill 'just because it's a step'.",
    "3. PLAN: if you don't have a todo list yet, call todo_write ONCE with the full plan. Never call todo_write twice in a row.",
    "4. ACT: make exactly ONE tool call that advances the in_progress (or first pending) todo — a real action (read/write/patch/run/search), not another planning call.",
    "5. VERIFY: read the FULL result of that call before deciding what to do next. Exit code 0 and no errors means success.",
    "6. UPDATE: when a todo is finished, call todo_write to mark it complete, then immediately continue with the next todo — don't stop to announce it.",
    "7. ON ERROR: read the [RECOVERY HINT] attached to the failed result and follow it. Never repeat the exact same failing call — it will be blocked.",
    "",
    "## Core rules",
    "- Before touching a project, read its key files (package.json/README/entry point) to understand what already exists.",
    "- The system blocks write_file/patch_file/apply_patch on existing files you haven't read yet — call read_file first.",
    "- patch_file (or apply_patch) for edits to existing files. write_file is for brand-new files only.",
    "- run_command: pass cwd= for subdirectories, never 'cd dir && cmd'. Never start dev servers or other long-running/blocking processes (npm start, npm run dev, flask run, etc.) — they will be killed after 30s; use build/typecheck/test commands to verify instead.",
    "- run_command executes via PowerShell on Windows and sh on Mac/Linux (see OS= above) — use that shell's syntax. On Windows: 'Remove-Item -Recurse -Force' not 'rm -rf', 'New-Item -ItemType Directory' not 'mkdir -p', '$env:VAR' not '$VAR'.",
    "- 'up to date' / 'already satisfied' / 'already installed' in install output means the dependency is present — do not re-run the install, move on.",
    "- web_search is capped at 4 calls this session — after 1-2 searches, commit to an approach.",
    "- If a task needs today's real current date/time (e.g. appending a timestamp to a file), call get_current_datetime — NEVER guess a date, use a date from training, or web_search/web_fetch an external \"current time\" API (no such reachable API exists here; it will fail with a DNS/CORS error and waste the whole task).",
    "- Never simulate actions in text (writing out 'Todos: ... (completed)', pasting code instead of writing it, describing a command instead of running it). Every action is a real tool call. A response with no tool call ends the task.",
    "- TAKE INITIATIVE. When the user asks you to do something actionable, DO IT immediately by emitting the real tool call — do NOT write the call as prose or pseudo-code (e.g. typing `schedule_task(\"...\", 120, ...)` as text is NOT calling it), and do NOT ask 'would you like me to…' or 'should I…'. The user's request is your go-ahead; any tool that needs confirmation already shows the user an approval card, so you never need to ask permission in text. Act first, then briefly say what you did. Only ask a question if you are genuinely blocked on information the tools can't give you.",
    "- If your change adds, removes, or materially changes a feature, tool, or tab, update FEATURES.md in the workspace root to match.",
    "- If a tool reports a path as not found, check the File tree in 'Current state' for the correct nested path (e.g. project files may live inside a subfolder like \"my-app/src/...\", not at the workspace root) before retrying — don't repeat a path that just failed.",
    "- Only ever call tools that appear under 'Tools available this session' below. If no listed tool fits, accomplish the goal with the tools you DO have — never invent a tool name (there is no 'create-skill', 'generate-dashboard', 'create-local-mind-skill', etc.); calling a non-existent tool just fails and wastes the turn.",
    "- To create / author / save a skill when the user asks (even from a long spec they paste), call save_skill with name, tags, and content (the full markdown instructions) — that is the ONLY way to make a skill. To produce a report/document/dashboard, write_file the content yourself; there is no separate 'generate' tool.",
    "- If a task needs a capability you don't have: if a shell one-liner would do it, use register_tool to create that tool; if it needs LocalMind app changes you can't make, use propose_feature to draft a spec for the user/Claude to implement later — then tell the user which you did. Never fake a capability or loop retrying an impossible action.",
    "- To make something happen on a schedule / recurring / at a later time / unattended, ALWAYS use the schedule_task tool — LocalMind has a built-in background scheduler that survives restarts. NEVER use run_command with cron, crontab, Windows Task Scheduler, or a sleep loop for scheduling; those don't integrate with LocalMind and usually won't run. Connected MCP tools (e.g. a Google Calendar server) are for THAT service's data — they are NOT how you schedule LocalMind's own background tasks.",
    "- schedule_task's 'task' parameter MUST be a natural English INSTRUCTION (e.g. 'append the current date to notes.md' or 'summarize my todos and write to status.md'), NEVER a shell command or code (e.g. NO 'echo $(date) >> notes.md', NO 'date >> file', NO PowerShell syntax). The scheduled agent will run on the user's platform and emit the right commands — your job is to describe what should happen in plain English.",
    "- When you answer using search_knowledge, you MUST cite the bracketed source location shown with each result (e.g. `[CS101/lecture5.pdf p.12]`) inline in your answer. If search_knowledge returns no matching passages, tell the user the topic isn't in their notes — do not answer from general knowledge as if it came from their notes.",
    "",
    buildCapabilityBlock(config.toolsSupported ? config.tools : [], false),
  );

  if (!config.toolsSupported) {
    lines.push(
      "",
      "NOTE: this model does not support tool calls. Respond with the changed code only (kept short); the user applies it via the 'Apply to file' button."
    );
  }

  return lines.join("\n");
}

function formatTree(entries: FileEntry[], prefix: string): string {
  return entries
    .map((e) => {
      const line = prefix + (e.kind === "directory" ? "📁 " : "📄 ") + e.name;
      if (e.kind === "directory" && e.children && e.children.length > 0) {
        return line + "\n" + formatTree(e.children, prefix + "  ");
      }
      return line;
    })
    .join("\n");
}

async function readTodosFromDisk(dirHandle: FileSystemDirectoryHandle): Promise<TodoItem[]> {
  try {
    const lm = await dirHandle.getDirectoryHandle(".localmind", { create: false });
    const fh = await lm.getFileHandle("todos.json", { create: false });
    const file = await fh.getFile();
    const parsed = JSON.parse(await file.text());
    return Array.isArray(parsed) ? (parsed as TodoItem[]) : [];
  } catch {
    return [];
  }
}

interface RuntimeState {
  lastActionSummary: string | null;
  cachedTree: string | null;
  treeDirty: boolean;
  cachedMemory: string;
  memoryDirty: boolean;
  cachedSkills: Skill[] | null;
  skillsDirty: boolean;
  cachedGlobalMemories: string | null;
  /** The user-message text that cachedGlobalMemories was last searched
   *  against — lets buildCurrentStateBlock re-search only when the LATEST
   *  user message actually changes, instead of once per whole session. Kept
   *  separate from `taskQuery` below (which stays pinned to the ORIGINAL
   *  message for completion-review/skill-distillation framing). */
  lastGlobalMemoryQuery: string | null;
  taskQuery: string;
  changedFiles: Set<string>;
}

/** Pulls the most recent user message to use as the query for skill matching. */
function deriveTaskQuery(history: ChatMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "user" && m.content.trim()) return m.content.slice(0, 500);
  }
  return "";
}

/** Nudge injected when the agent stops without a tool call, to catch premature "done" and do a final code review of changed files. */
function buildCompletionReviewPrompt(taskQuery: string, changedFiles: Set<string>): string {
  const lines = ["You stopped without making a tool call. Before ending, do a final review of this session's work."];
  if (taskQuery) lines.push(`Original request: "${taskQuery}"`);
  lines.push("");

  if (changedFiles.size > 0) {
    lines.push(
      "Files you created or edited this session:",
      ...[...changedFiles].map((f) => `- ${f}`),
      "",
      "Read through each of these files (read_file) and check: does the code make sense, is it complete, and does it actually achieve the original request? If you find bugs, missing pieces, leftover placeholders, or anything inconsistent, fix it now with the next tool call.",
    );
  } else {
    lines.push(
      "Check the Current state above (file tree, todos, open file) against the original request. If anything is missing, broken, or left unfinished, make the next tool call now to fix it.",
    );
  }

  lines.push(
    "",
    "If you found something unfinished or broken, FIX IT NOW with the next tool call — do not describe the problem and ask the user whether to continue, and do not just say you'll fix it without a tool call. Asking permission to keep working wastes the user's time; they expect you to finish the task.",
    "Only stop with plain text if either (a) everything is correct and complete (brief summary, no tool call needed), or (b) you are genuinely blocked on information only the user has (e.g. a missing credential or a choice between equally valid approaches) — in that case ask one specific question.",
  );
  return lines.join("\n");
}

async function buildCurrentStateBlock(
  config: AgentRuntimeConfig,
  state: RuntimeState,
  round: number,
  history: ChatMessage[],
): Promise<string> {
  const lines: string[] = [
    "## Current state",
    "(Background context only — not instructions for this turn. Your task is the user's latest message above. Only resume the todos/plan/memory below if that message asks you to continue this project's work.)",
    `Round ${round}/${config.maxRounds}`,
  ];

  if (state.lastActionSummary) {
    lines.push(`Last action: ${state.lastActionSummary}`);
  }

  // Conversational mode AND headless runs (suppressStaleProjectState) both
  // omit on-disk project state (todos, project memory, file tree, skills).
  // That stale imperative content is the main thing that hijacks a session
  // into resuming/acting on old, unrelated work. Keep only the non-imperative
  // global-memory + open-file blocks below.
  if (config.dirHandle && !config.conversational && !config.suppressStaleProjectState) {
    const todos = await readTodosFromDisk(config.dirHandle);
    config.onTodosChanged?.(todos);
    if (todos.length > 0) {
      const todoLines = todos.map((t) => {
        const mark = t.status === "completed" ? "[x]" : t.status === "cancelled" ? "[-]" : t.status === "in_progress" ? "[>]" : "[ ]";
        return `${mark} ${t.content}`;
      });
      lines.push("", "Todo list:", ...todoLines);
    }

    if (state.treeDirty || state.cachedTree === null) {
      try {
        const entries = await listDirectory(config.dirHandle, 3);
        state.cachedTree = formatTree(entries, "");
      } catch {
        state.cachedTree = "(could not read workspace)";
      }
      state.treeDirty = false;
    }
    if (state.cachedTree) {
      const treeLines = state.cachedTree.split("\n");
      const capped = treeLines.slice(0, 60);
      lines.push("", "File tree:", capped.join("\n"));
      if (treeLines.length > 60) lines.push("…");
    }

    if (state.memoryDirty) {
      try {
        state.cachedMemory = await readProjectMemory(config.dirHandle);
      } catch {
        state.cachedMemory = "";
      }
      state.memoryDirty = false;
      config.onMemoryChanged?.(state.cachedMemory);
    }
    if (state.cachedMemory) {
      const truncated = state.cachedMemory.length > 400
        ? state.cachedMemory.slice(0, 400) + "\n…"
        : state.cachedMemory;
      lines.push("", formatMemoryForContext(truncated));
    }

    if (state.skillsDirty || state.cachedSkills === null) {
      try {
        state.cachedSkills = await loadSkills(config.dirHandle);
      } catch {
        state.cachedSkills = [];
      }
      state.skillsDirty = false;
    }
    if (state.cachedSkills.length > 0 && state.taskQuery) {
      const matched = matchSkills(state.cachedSkills, state.taskQuery, 3, 1);
      if (matched.length > 0) lines.push("", formatSkillsForContext(matched));
    }
  }

  // Global, cross-project memory — re-searched whenever the LATEST user
  // message changes (not just once at session start), so recall works across
  // a long interactive conversation, not only for the message that opened it.
  // Cached per exact message text so unchanged rounds don't re-embed. Suppressed
  // for headless runs along with the rest of the stale state: memories about
  // unrelated past work (e.g. "game.py") retrieved by loose similarity are the
  // same hijack vector as stale todos/skills — a scheduled run was observed
  // calling save_skill("Create game.py") mid-task.
  if (!config.suppressStaleProjectState) {
    const latestQuery = deriveTaskQuery(history) || state.taskQuery;
    if (state.cachedGlobalMemories === null || latestQuery !== state.lastGlobalMemoryQuery) {
      state.lastGlobalMemoryQuery = latestQuery;
      try {
        const results = await searchMemory(latestQuery, 3, 0.35);
        state.cachedGlobalMemories = formatMemoriesForContext(results);
      } catch {
        state.cachedGlobalMemories = "";
      }
    }
  }
  if (state.cachedGlobalMemories) {
    lines.push("", state.cachedGlobalMemories);
  }

  const openFile = config.getCurrentOpenFile?.();
  if (openFile && openFile.path && openFile.content) {
    const fileLines = openFile.content.split("\n");
    const snippet = fileLines.slice(0, 80).join("\n");
    lines.push(
      "",
      `Open: ${openFile.path}`,
      "```" + openFile.language,
      snippet + (fileLines.length > 80 ? "\n…(truncated)" : ""),
      "```",
    );
  }

  const pendingTasks = useTaskQueueStore.getState().tasks.filter(
    (t) => t.targetView === config.currentView && t.status === "pending"
  );
  if (pendingTasks.length > 0) {
    lines.push(
      "",
      "Pending tasks queued for this tab (from another tab's agent — the user can start these via the banner, or you may begin one now if it fits the current task):",
      ...pendingTasks.map((t) => `- (from ${t.sourceView}) ${t.task}`),
    );
  }

  return lines.join("\n");
}

interface GuardedExecution {
  result: ToolResult;
  toolContent: string;
  blocked: boolean;
  sideEffect: boolean;
}

function pathsFromCall(call: ToolCall): string[] {
  if (call.name === "apply_patch") {
    const patches = call.args["patches"];
    if (Array.isArray(patches)) {
      return patches
        .map((p) => (p as Record<string, unknown>)["path"])
        .filter((p): p is string => typeof p === "string" && p.length > 0);
    }
    return [];
  }
  const path = call.args["path"];
  return typeof path === "string" && path.length > 0 ? [path] : [];
}

const SIDE_EFFECT_TOOLS = new Set([
  "write_file", "patch_file", "apply_patch", "delete_file", "create_folder", "run_command", "install_deps",
]);

/**
 * Resolves plan-mode/approval gating for a tool call from its ToolDef
 * metadata. Static built-ins in TOOL_DEFINITIONS carry planModeAllowed /
 * requiresApproval directly (see tools.ts). MCP tools are named
 * "serverId__toolName" (contain "__") and dynamic tools loaded from
 * .localmind/tools/*.json have arbitrary names with no matching ToolDef (or a
 * ToolDef lacking metadata) — both fall through to the external default-deny
 * policy: denied entirely in Plan mode, requires approval in Build mode.
 */
function resolveToolPolicy(
  call: ToolCall,
  def: ToolDef | undefined,
): { planModeAllowed: boolean; requiresApproval: boolean } {
  if (call.name.includes("__")) {
    return { planModeAllowed: false, requiresApproval: true };
  }
  // Read-only alias keys (tools.ts TOOL_ALIASES) normalize to a built-in read
  // tool before metadata lookup would otherwise miss them under their alias name.
  if (READ_ONLY_ALIASES.includes(call.name)) {
    return { planModeAllowed: true, requiresApproval: false };
  }
  if (def && def.planModeAllowed !== undefined && def.requiresApproval !== undefined) {
    return { planModeAllowed: def.planModeAllowed, requiresApproval: def.requiresApproval };
  }
  return { planModeAllowed: false, requiresApproval: true };
}

async function executeToolGuarded(
  call: ToolCall,
  config: AgentRuntimeConfig,
  detector: StuckDetector,
  sessionReadPaths: Set<string>,
): Promise<GuardedExecution> {
  // 0a. Canonicalize the tool name up front (hyphen→underscore, aliases) so a
  // weak model's "schedule-task" resolves to schedule_task BEFORE policy/approval
  // — otherwise it's treated as an unknown external tool and over-gated. Empty
  // names (models emit {name:""}) are blocked with a helpful message.
  {
    const canonical = canonicalToolName(call.name);
    if (!canonical) {
      return {
        result: { toolCallId: call.id, name: call.name ?? "", output: "", error: "Empty tool call" },
        toolContent: "You emitted a tool call with no name. Either call a real tool from your system prompt (e.g. schedule_task, write_file) with valid arguments, or reply with plain text — do not emit empty or malformed tool calls.",
        blocked: true,
        sideEffect: false,
      };
    }
    if (canonical !== call.name) call = { ...call, name: canonical };
  }

  // 0. Self-search guard: web results for "LocalMind" describe unrelated third-party
  // apps that share the name — never let the model use them to answer questions
  // about this app (the "About LocalMind" block from buildCapabilityBlock in the system prompt is authoritative).
  if (call.name === "web_search" && /localmind/i.test(String(call.args["query"] ?? ""))) {
    return {
      result: { toolCallId: call.id, name: call.name, output: "", error: "Blocked (LocalMind self-search)" },
      toolContent: "BLOCKED: Do not web_search for \"LocalMind\" — results describe unrelated third-party apps that happen to share the name. Answer questions about LocalMind itself directly from the 'About LocalMind' section of your system prompt, in plain text, with no further tool calls.",
      blocked: true,
      sideEffect: false,
    };
  }

  // 1. Metadata-driven policy resolution + Plan-mode denial
  const def = config.tools.find((t) => t.name === call.name);
  const policy = resolveToolPolicy(call, def);

  if (!policy.planModeAllowed && !config.agentBuildMode) {
    return {
      result: { toolCallId: call.id, name: call.name, output: "", error: "Denied (Plan mode)" },
      toolContent: "DENIED: You are in Plan mode (read-only). You may read files, search, and call todo_write. The user must switch to Build mode before write/patch/run/install/git-write tools (or other mutating/external/unrecognized tools) can run.",
      blocked: true,
      sideEffect: false,
    };
  }

  // 2. Approval gate
  if (policy.requiresApproval && !config.autoApproveAll) {
    const approved = await config.onApprovalNeeded(call);
    if (!approved) {
      return {
        result: { toolCallId: call.id, name: call.name, output: "", error: "Denied by user" },
        toolContent: "Tool call denied by user.",
        blocked: true,
        sideEffect: false,
      };
    }
  }

  // 3. Stuck-detector pre-check
  const blockMsg = detector.checkBeforeExecute(call);
  if (blockMsg) {
    return {
      result: { toolCallId: call.id, name: call.name, output: "", error: "Blocked (loop guard)" },
      toolContent: blockMsg,
      blocked: true,
      sideEffect: false,
    };
  }

  // 4. Hard read-before-write gate
  if (config.dirHandle && (call.name === "write_file" || call.name === "patch_file" || call.name === "apply_patch")) {
    const unread: string[] = [];
    for (const p of pathsFromCall(call)) {
      const norm = normalizeSubPath(p);
      if (sessionReadPaths.has(norm)) continue;
      if (call.name === "write_file") {
        if (await fileExists(config.dirHandle, norm)) unread.push(p);
      } else {
        unread.push(p);
      }
    }
    if (unread.length > 0) {
      const list = unread.map((p) => `"${p}"`).join(", ");
      return {
        result: { toolCallId: call.id, name: call.name, output: "", error: "Blocked (read-before-write)" },
        toolContent: `BLOCKED: ${list} must be read with read_file before you can ${call.name === "write_file" ? "overwrite" : "patch"} ${unread.length > 1 ? "them" : "it"}. Call read_file now, then retry ${call.name}.`,
        blocked: true,
        sideEffect: false,
      };
    }
  }

  // 5. Execute
  const result = await executeTool(call, config.dirHandle, config.workspacePath ?? undefined);

  // 6. Update session read/write tracking
  if (!result.error) {
    if (call.name === "read_file") {
      const p = call.args["path"];
      if (typeof p === "string" && p) sessionReadPaths.add(normalizeSubPath(p));
    }
    if (call.name === "write_file" || call.name === "patch_file" || call.name === "apply_patch") {
      for (const p of pathsFromCall(call)) sessionReadPaths.add(normalizeSubPath(p));
    }
  }

  // 7. Record result + notes
  const notes = detector.recordResult(call, result);

  // 8. Error-recovery hint
  if (toolResultFailed(result)) {
    const hint = errorRecoveryHint(`${result.output}\n${result.error ?? ""}`);
    if (hint) notes.push(hint);
  }

  // 9. Build the content the model will see
  const isShellTool = call.name === "run_command" || call.name.startsWith("git_");
  let toolContent: string;
  if (isShellTool) {
    toolContent = result.output + (result.error ? `\n[${result.error}]` : "");
  } else {
    toolContent = result.error ? `Error: ${result.error}` : result.output;
  }
  if (notes.length > 0) toolContent += `\n\n${notes.join("\n\n")}`;

  // WP4.1: cap what re-enters the model's context — the untrimmed `result`
  // still goes to the UI via onToolCallResolved below, only this string does.
  toolContent = capToolOutput(toolContent);

  const sideEffect = !result.error && SIDE_EFFECT_TOOLS.has(call.name);

  return { result, toolContent, blocked: false, sideEffect };
}

export async function runAgentSession(
  priorHistory: ChatMessage[],
  config: AgentRuntimeConfig,
): Promise<AgentRuntimeResult> {
  const numCtx = resolveNumCtx(config.hardware, config.numCtxOverride, config.modelRef);
  const detector = new StuckDetector();
  const sessionReadPaths = new Set<string>();
  const state: RuntimeState = {
    lastActionSummary: null,
    cachedTree: null,
    treeDirty: true,
    cachedMemory: "",
    memoryDirty: true,
    cachedSkills: null,
    skillsDirty: true,
    cachedGlobalMemories: null,
    lastGlobalMemoryQuery: null,
    taskQuery: deriveTaskQuery(priorHistory),
    changedFiles: new Set<string>(),
  };

  let history: ChatMessage[] = [...priorHistory];
  let hadSideEffects = false;
  let hitRoundLimit = false;
  let wasAborted = false;
  let round = 0;
  let lastRoundHadToolCalls = false;
  let anyToolCallsThisSession = false;
  let completionCheckCount = 0;
  let inactionNudgeCount = 0;
  let hadDeniedToolCalls = false;
  // expectSideEffects sessions (scheduler/task-queue) get a 2nd inaction nudge —
  // observed live: a single distraction (e.g. a stray management-tool call) or
  // even a totally blank round can burn the only nudge, after which the run
  // silently ends with zero side effects and no further chance to recover.
  // Interactive/subagent sessions keep the original single-nudge budget: a
  // human is present to just ask again, so a 2nd automatic retry isn't worth
  // the extra round.
  const maxInactionNudges = config.expectSideEffects ? 2 : 1;

  // Relevance-filter the tool list so a large set (many connected MCP tools)
  // doesn't overwhelm weak local models — keeps essential file/shell/plan tools
  // plus the tools most relevant to this task. Fails open for small lists.
  const toolsForModel = config.toolsSupported
    ? await filterToolsByRelevance(config.tools, state.taskQuery)
    : [];
  // Build the system prompt from the SAME (filtered) tool list so its
  // "Available tools" self-description matches what the model can actually call.
  const systemPrompt = buildSystemPrompt(
    config.toolsSupported ? { ...config, tools: toolsForModel } : config,
  );

  try {
    if (!config.toolsSupported) {
      round = 1;
      config.onRoundStart?.(round, config.maxRounds);
      for await (const chunk of streamChatForModel(
        config.modelRef,
        [{ role: "system", content: systemPrompt }, ...history],
        config.signal,
      )) {
        config.onTextDelta?.(chunk);
      }
      return { hadSideEffects, hitRoundLimit, wasAborted, roundsUsed: round, finalHistory: history, hadDeniedToolCalls };
    }

    while (round < config.maxRounds) {
      round++;
      config.onRoundStart?.(round, config.maxRounds);

      const stateBlock = await buildCurrentStateBlock(config, state, round, history);

      // WP4.1: fold old history into a compact work-log stub before the
      // projected token load overflows numCtx (see compactHistoryIfOverBudget
      // for the cut-boundary rule). No LLM call here — mid-loop model calls
      // cause VRAM thrash on 16GB-class targets.
      const compaction = compactHistoryIfOverBudget(systemPrompt, stateBlock, history, numCtx);
      if (compaction.compacted) {
        history = compaction.history;
        console.info(
          `[context] compacted ${compaction.foldedCount} msgs → ~${compaction.tokensAfter} tokens (was ~${compaction.tokensBefore}, budget ~${Math.round(numCtx * 0.7)})`,
        );
      }

      const messagesForRound: ChatMessage[] = [
        { role: "system", content: `${systemPrompt}\n\n${stateBlock}` },
        ...history,
      ];

      lastRoundHadToolCalls = false;
      let roundText = "";

      for await (const event of runAgentTurnForModel(config.modelRef, messagesForRound, toolsForModel, config.signal, { numCtx })) {
        if (config.signal.aborted) throw new DOMException("Aborted", "AbortError");

        if (event.type === "text_delta" && event.content) {
          if (event.content.startsWith("\x00CLEAN:")) {
            const clean = event.content.slice("\x00CLEAN:".length);
            config.onTextReplace?.(clean);
            roundText = clean;
          } else {
            const cleaned = event.content.replace(/<\|im_start\|>|<\|im_end\|>|<\|endoftext\|>/g, "");
            if (cleaned) {
              config.onTextDelta?.(cleaned);
              roundText += cleaned;
            }
          }
        } else if (event.type === "tool_calls" && event.toolCalls) {
          lastRoundHadToolCalls = true;
          anyToolCallsThisSession = true;

          for (const call of event.toolCalls) {
            if (config.signal.aborted) throw new DOMException("Aborted", "AbortError");

            const label = formatToolLabel(call.name, call.args);
            config.onToolCallStart?.(call, label);
            config.onActivity?.(label);

            const { result, toolContent, blocked, sideEffect } = await executeToolGuarded(call, config, detector, sessionReadPaths);

            config.onActivity?.(null);

            if (sideEffect) {
              hadSideEffects = true;
              state.treeDirty = true;
              if (call.name === "install_deps") state.memoryDirty = true;
              for (const p of pathsFromCall(call)) state.changedFiles.add(p);
            }
            if (blocked && result.error === "Denied by user") {
              hadDeniedToolCalls = true;
            }
            if (!blocked && call.name === "update_project_memory" && !result.error) {
              state.memoryDirty = true;
            }
            if (!blocked && call.name === "save_skill" && !result.error) {
              state.skillsDirty = true;
            }

            const summary = blocked
              ? `${label} → ${result.error}`
              : result.error ? `${label} → error` : summariseToolResult(call.name, call.args, result.output);

            state.lastActionSummary = summary;

            config.onToolCallResolved?.(call, label, result, summary, toolContent);

            history = [
              ...history,
              { role: "assistant", content: "", tool_calls: [{ function: { name: call.name, arguments: call.args } }] },
              { role: "tool", content: toolContent },
            ];
          }
        } else if (event.type === "error") {
          config.onTextDelta?.(`\n\n*[Agent error: ${event.error}]*`);
        }
      }

      if (!lastRoundHadToolCalls) {
        const trimmed = roundText.trim();
        const looksLikeQuestion = /\?\s*$/.test(trimmed);

        // Inaction guard: a build task ended with ZERO tool calls all session —
        // the model described/pseudo-coded the action or asked permission instead
        // of doing it. Nudge it once to actually act (fires before completion
        // review, which only applies after side effects).
        // Note: unlike completion review, this fires even when the text ends in
        // "?" — asking "would you like me to…?" instead of acting is the exact
        // passivity we're correcting.
        //
        // Second trigger (expectSideEffects sessions only — scheduler/task-queue):
        // the session DID call tools (so the plain !anyToolCallsThisSession check
        // below never fires) but none of them mutated anything — e.g. it called
        // get_current_datetime, saw the answer, and just described it in text
        // instead of continuing on to write_file. There's no chat UI reading that
        // text for these runs, so this is just as much a no-op as zero tool calls.
        const madeInfoCallsButNoMutation = config.expectSideEffects && anyToolCallsThisSession && !hadSideEffects;
        // trimmed.length > 0 is required for interactive sessions (a totally
        // blank turn there is likely a transient glitch, not worth nudging).
        // expectSideEffects sessions drop that requirement: a completely
        // blank round (no text, no tool call) is just as much a silent no-op
        // as a text-only one, and there's no human here to notice either way
        // — observed live, this exact case (nudge already spent, next round
        // comes back empty) let a scheduled run end with zero side effects.
        const shouldNudgeInaction = config.agentBuildMode
          && (!anyToolCallsThisSession || madeInfoCallsButNoMutation)
          && inactionNudgeCount < maxInactionNudges
          && (trimmed.length > 0 || config.expectSideEffects) && round < config.maxRounds;
        if (shouldNudgeInaction) {
          inactionNudgeCount++;
          const nudgeText = madeInfoCallsButNoMutation
            ? "You looked something up but haven't actually made the required change yet — this is an unattended run, nobody reads this text reply, so the task is NOT done until you call a mutating tool (write_file/patch_file/etc). Continue now and make that call."
            : "You did not actually DO anything — you described the action (or wrote a tool call as text) instead of emitting a real tool call, and no tool ran. Do it NOW by emitting the actual tool call with proper arguments. Do not ask for permission (an approval card will appear if needed) and do not restate the plan — just make the call.";
          history = [...history, { role: "user", content: nudgeText }];
          continue;
        }

        const canRecheck = config.agentBuildMode && hadSideEffects && completionCheckCount < MAX_COMPLETION_CHECKS
          && trimmed.length > 0 && !looksLikeQuestion && round < config.maxRounds;
        if (canRecheck) {
          completionCheckCount++;
          history = [...history, { role: "user", content: buildCompletionReviewPrompt(state.taskQuery, state.changedFiles) }];
          continue;
        }
        break;
      }
    }

    if (round >= config.maxRounds && lastRoundHadToolCalls) {
      hitRoundLimit = true;
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      wasAborted = true;
    } else {
      throw err;
    }
  }

  // WP3.3 — Auto-skill creation: after a substantive build session, distill the
  // work into a reusable skill and QUEUE it for one-click approval (never saved
  // silently). Best-effort: a digest failure must never affect the result.
  try {
    const toolCallCount = history.filter((m) => m.role === "tool").length;
    if (
      config.toolsSupported &&
      !config.conversational &&
      config.agentBuildMode &&
      hadSideEffects &&
      !wasAborted &&
      toolCallCount >= 5
    ) {
      await distillSkillFromSession(config, state, history);
    }
  } catch {
    // ignore — auto-skill distillation is non-essential
  }

  // WP4.2 — Memory write-back: after an interactive BUILD session, distill any
  // durable facts (preferences/project facts/environment quirks) worth
  // remembering into future, unrelated sessions. Separate try/catch from the
  // skill-distillation hook above so a failure in either is fully isolated;
  // best-effort — must never affect the session result. Lower tool-call bar
  // than skill distillation (3 vs 5): a fact worth remembering doesn't require
  // as substantial a session as a reusable skill does. suppressStaleProjectState
  // doubles as the "interactive" check here, same as the memory-injection seam.
  try {
    const toolCallCount = history.filter((m) => m.role === "tool").length;
    if (
      config.toolsSupported &&
      !config.conversational &&
      config.agentBuildMode &&
      !config.suppressStaleProjectState &&
      !wasAborted &&
      toolCallCount >= 3
    ) {
      await distillAndSaveMemories(state.taskQuery, history, config.signal);
    }
  } catch {
    // ignore — memory write-back is non-essential
  }

  return { hadSideEffects, hitRoundLimit, wasAborted, roundsUsed: round, finalHistory: history, hadDeniedToolCalls };
}

/** Pull the largest {...} block out of possibly-fenced model output and parse it. */
function parseSkillJson(raw: string): { name?: string; tags?: unknown; content?: string } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as { name?: string; tags?: unknown; content?: string };
  } catch {
    return null;
  }
}

/** One-shot digest: summarize the just-finished session into a candidate skill. */
async function distillSkillFromSession(
  config: AgentRuntimeConfig,
  state: RuntimeState,
  history: ChatMessage[],
): Promise<void> {
  const changed = [...state.changedFiles];
  const toolSummaries = history
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content.slice(0, 160) : ""))
    .filter(Boolean)
    .slice(0, 20);

  const prompt = [
    "You just completed a multi-step coding task. Distill it into a REUSABLE skill document so it can be reused next time.",
    `Original task: ${state.taskQuery}`,
    changed.length ? `Files changed: ${changed.join(", ")}` : "",
    toolSummaries.length ? `Actions taken:\n- ${toolSummaries.join("\n- ")}` : "",
    "",
    'Respond with ONLY a JSON object: {"name": "<short skill name>", "tags": ["..."], "content": "<markdown: when to use, the procedure/steps, key commands, known gotchas, and how to verify>"}.',
    "If the task was trivial or not worth remembering, respond with {}.",
  ].filter(Boolean).join("\n");

  let out = "";
  for await (const chunk of streamChatForModel(
    config.modelRef,
    [
      { role: "system", content: "You write concise, reusable skill docs. Respond with only the JSON object, no prose or fences." },
      { role: "user", content: prompt },
    ],
    config.signal,
  )) {
    out += chunk;
    if (out.length > 4000) break;
  }

  const parsed = parseSkillJson(out);
  if (parsed && parsed.name && parsed.content) {
    usePendingSkillsStore.getState().add({
      name: String(parsed.name),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t)) : [],
      content: String(parsed.content),
      sourceTask: state.taskQuery.slice(0, 200),
    });
  }
}
