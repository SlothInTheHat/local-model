import type { ChatMessage } from "./ollama";
import type { ToolDef, ToolCall, ToolResult } from "./tools";
import { executeTool, normalizeSubPath, canonicalToolName, TOOL_DEFINITIONS, resolvePathParts } from "./tools";
import { runAgentTurnForModel, streamChatForModel } from "./chatProvider";
import { resolveNumCtx, compactHistoryIfOverBudget, compactHistoryAggressively, isContextOverflowError, capToolOutput } from "./contextSize";
import { fileExists, listDirectory, readFileFromHandle } from "./fileSystem";
import type { FileEntry } from "./fileSystem";
import type { HardwareInfo } from "./hardware";
import { formatMemoryForContext, readProjectMemory } from "./projectMemory";
import { searchMemory, formatMemoriesForContext, distillAndSaveMemories } from "./vectorMemory";
import { loadSkills, matchSkills, formatSkillsForContext } from "./skillEngine";
import type { Skill } from "./skillEngine";
import { formatToolLabel, summariseToolResult } from "./toolFormatting";
import { StuckDetector, errorRecoveryHint, toolResultFailed } from "./stuckDetector";
import { filterToolsByRelevance, retrieveToolsForStep } from "./toolFilter";
import { buildCapabilityBlock } from "./capabilityRegistry";
import type { AppView } from "../types/app";
import { useTaskQueueStore } from "../store/taskQueue";
import { usePendingSkillsStore } from "../store/pendingSkills";
import { commitAfterToolCall } from "./shadowGit";
import { resolveRole } from "./modelRoles";
import { supportsCodeMode } from "./modelCapabilities";
import { runToolScript } from "./toolScript";

// ─── Tauri invoke shim (mirrors the pattern used in src/lib/tools.ts / AppSettings.tsx) ──

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__;
  if (!tauri) throw new Error("Not in Tauri desktop mode");
  const core = (tauri as Record<string, unknown>).core as {
    invoke?: (cmd: string, args?: unknown) => Promise<T>;
  };
  if (typeof core?.invoke !== "function") throw new Error("Tauri core.invoke unavailable");
  return core.invoke(cmd, args);
}

export const DEFAULT_MAX_ROUNDS = 50;

/** How many times a no-tool-call round can trigger a completion review before the session ends regardless. */
const MAX_COMPLETION_CHECKS = 2;

/** How many times findMissingReferencedFiles can nudge before giving up and falling through to the normal completion check — a safety valve so a check bug can't hang a session forever. */
const MAX_MISSING_REF_NUDGES = 2;

/** How many times a real provider-reported context-overflow error can trigger an aggressive-compaction retry before giving up and surfacing a clear failure instead of looping forever against a window that's fundamentally too small. */
const MAX_CONTEXT_OVERFLOW_RETRIES = 2;

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

/**
 * Hallucinated MCP-shaped tool names — observed live, twice, from a weak
 * local model in quick-invoke's "circle a region, ask about it" flow: even
 * after being told the exact real tool name to call ("Call take_screenshot"),
 * the model instead invented "browser__browser_take_screenshot", a
 * plausible-sounding name for a tool that was never offered this session
 * (quick-invoke's headless run never includes MCP tools at all — see
 * handleQuickInvokeWidget in App.tsx). canonicalToolName() (tools.ts)
 * deliberately leaves any "__"-containing name untouched, on the assumption
 * it's a real MCP tool reference — so this can't live in that name-agnostic
 * lookup without risking hijacking a GENUINE same-named MCP tool in a
 * session where one really is connected. Instead this is consulted only as a
 * fallback in executeToolGuarded, after confirming the called name doesn't
 * match any tool actually in `config.tools` this session — so a real,
 * connected browser-automation server's own `browser__browser_take_screenshot`
 * (if a user's MCP setup ever genuinely has one) is found first and this
 * never overrides it.
 */
const HALLUCINATED_TOOL_FALLBACKS: Record<string, string> = {
  browser__browser_take_screenshot: "take_screenshot",
  browser__take_screenshot: "take_screenshot",
  browser_take_screenshot: "take_screenshot",
};

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
  /** Human-readable surface name for shadow-git commit messages (e.g. "chat", "code",
   *  or a headless origin like "scheduler"/"task-queue"/"subagent"/"workflow"). Falls
   *  back to currentView when omitted — set explicitly by headless callers, whose
   *  origin isn't an AppView. */
  surfaceLabel?: string;

  tools: ToolDef[];
  /**
   * Plan/Build mode and the Full-Auto toggle. Accept either a plain boolean
   * (headless/scheduler/task-queue/subagent callers, which have no live UI
   * toggle to track) or a getter — interactive callers (CodeEditor.tsx) pass
   * `() => ref.current` so a mid-session toggle takes effect on this
   * session's very NEXT tool call instead of only the next message. Read via
   * liveFlag() at every check site, never accessed directly, since a plain
   * boolean check against a function value is always true.
   *
   * Root cause this fixes: previously a plain boolean baked into this config
   * object at session start stayed frozen for the whole multi-round loop
   * (up to maxRounds), so toggling Full Auto mid-response had no effect
   * until the NEXT message — this is what a user flipping the toggle while
   * a response was already streaming would experience as "I turned Full
   * Auto on but it still asked me."
   */
  agentBuildMode: boolean | (() => boolean);
  autoApproveAll: boolean | (() => boolean);
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
   * Selects an alternate, additive system-prompt branch for a specific
   * feature surface instead of the generic coding-loop/conversational
   * prompts. Currently only "resume" (the Resume Tailoring tab) — its agent
   * has no write_file/patch_file and proposes edits via propose_resume_edit
   * for the user to accept/reject as a diff, so neither existing prompt fits:
   * the coding prompt talks about tools this surface doesn't have, and the
   * conversational prompt actively discourages tool use. Unset for every
   * other caller, so this is purely additive.
   */
  promptSurface?: "resume";

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
  /**
   * Reasoning/"thinking" output from a thinking-capable model. Never folded
   * into `roundText`/`history` — this is a UI/display-only side channel, kept
   * separate so a model's prior reasoning is never resent as part of `content`
   * on a later turn (see ChatMessage.thinking in ollama.ts).
   */
  onThinkingDelta?: (chunk: string) => void;
  onToolCallStart?: (call: ToolCall, label: string) => void;
  onApprovalNeeded: (call: ToolCall) => Promise<boolean>;
  /**
   * Fired when a mutating tool call is denied by Plan mode — this happens
   * BEFORE the approval gate, so onApprovalNeeded never runs for it. Without
   * this, a user with Full Auto on but Plan mode also on sees nothing:
   * the call is silently denied and reads as the agent simply not acting,
   * indistinguishable from Full Auto "still not working." Interactive
   * callers (CodeEditor.tsx) surface a one-line explanation the first time
   * this fires per session.
   */
  onPlanModeDenial?: (call: ToolCall) => void;
  onToolCallResolved?: (call: ToolCall, label: string, result: ToolResult, summary: string, toolContent: string) => void;
  onRoundStart?: (round: number, maxRounds: number) => void;
  onTodosChanged?: (todos: TodoItem[]) => void;
  onMemoryChanged?: (memory: string) => void;
  onActivity?: (label: string | null) => void;
  /**
   * Debug mode only — fired right after this round's system message is
   * assembled, before it's sent to the model. Carries the EXACT text sent
   * (the assembled system+state-block string is otherwise built fresh every
   * round and never stored anywhere — completely invisible today). Callers
   * must never fold this into the conversation's own message array: that
   * array is re-sent to the model every round, so leaking debug content into
   * it would corrupt the model's own context.
   */
  onDebugPrompt?: (info: { round: number; systemMessage: string }) => void;

  /** Fired when a tool the model called wasn't in that round's retrieved
   *  candidate set (see toolFilter.ts's retrieveToolsForStep) — the same
   *  event already logged via console.info, additionally surfaced here so
   *  it's visible in-app (debug mode's rail) without opening devtools. */
  onRetrievalMiss?: (info: { round: number; toolName: string; objective: string }) => void;

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

/** Resolves a config flag that may be a plain boolean or a live getter (see AgentRuntimeConfig.agentBuildMode/autoApproveAll's doc comment). */
function liveFlag(v: boolean | (() => boolean)): boolean {
  return typeof v === "function" ? v() : v;
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

/**
 * System prompt for the Resume Tailoring tab. Deliberately does not reuse
 * the coding-loop prompt below (todo_write cadence, patch_file/write_file/
 * run_command guidance) since RESUME_TOOLS contains none of those tools —
 * and does not reuse buildConversationalSystemPrompt either, since that
 * prompt actively discourages tool use while this agent's entire job is to
 * call tools (web_fetch, search_resume_knowledge, propose_resume_edit).
 */
function buildResumeTailoringSystemPrompt(config: AgentRuntimeConfig): string {
  const sessionTools = config.toolsSupported ? config.tools : [];
  const lines: string[] = [
    "You are a resume-tailoring assistant inside LocalMind's Resume tab.",
    "",
    buildRuntimeLine(config.modelRef, config.hardware, config.workspaceName, config.workspacePath),
    "",
    "## How this works",
    "- The user has a LaTeX resume open (shown below as 'Open:'). If the visible snippet looks truncated or doesn't show the section you need, call read_file on that same path for the full text.",
    "- You have NO file-write tool. To propose a change, call propose_resume_edit with the user's job in mind and the FULL new file content (not just the changed lines) plus a one-line summary. The user reviews it as a side-by-side diff and explicitly accepts or rejects it — nothing is saved until they do.",
    "- Never tell the user you 'updated', 'saved', or 'changed' the resume — say you've proposed an edit and it's waiting for their review.",
    "- If given a job listing URL, call web_fetch once to retrieve it before proposing edits. If given pasted job text directly, use it as-is — do not re-fetch or search for it.",
    "- Before inventing new bullet content, call search_resume_knowledge to check whether the user has relevant background material (a project, an internship, a skill) that isn't on the current resume but fits this job — prefer real background material over fabricating claims. This tool searches ONLY the user's dedicated 'Resume' background collection, never their class/study notes.",
    "- Never fabricate experience, skills, employers, or metrics that aren't present in the open resume or in search_resume_knowledge results.",
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
  if (config.promptSurface === "resume") return buildResumeTailoringSystemPrompt(config);
  if (config.conversational) return buildConversationalSystemPrompt(config);

  const modeTag = liveFlag(config.agentBuildMode) ? "BUILD" : "PLAN";
  const lines: string[] = [];

  const runtimeLine = buildRuntimeLine(config.modelRef, config.hardware, config.workspaceName, config.workspacePath);

  lines.push(
    `You are a coding agent operating in ${modeTag} MODE.`,
    liveFlag(config.agentBuildMode)
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
    "- A tool's own success result IS the verification — e.g. download_file reporting a byte count, write_file reporting the path, fs_move/fs_copy returning without an error. Do NOT follow up a successful tool call by writing a Python/Node/PowerShell script via run_command to independently re-check the file (magic bytes, CRCs, re-reading it back, etc.) 'just to be sure' — that is unnecessary work the user did not ask for. Only investigate further if the tool result ITSELF reported an error, a suspiciously small/zero size, or a truncation — and even then, re-run the original tool (e.g. download_file again), don't hand-roll a verification script.",
    "- web_search is capped at 4 calls this session — after 1-2 searches, commit to an approach.",
    "- If a task needs today's real current date/time (e.g. appending a timestamp to a file), call get_current_datetime — NEVER guess a date, use a date from training, or web_search/web_fetch an external \"current time\" API (no such reachable API exists here; it will fail with a DNS/CORS error and waste the whole task).",
    "- Never simulate actions in text (writing out 'Todos: ... (completed)', pasting code instead of writing it, describing a command instead of running it). Every action is a real tool call. A response with no tool call ends the task.",
    "- TAKE INITIATIVE. When the user asks you to do something actionable, DO IT immediately by emitting the real tool call — do NOT write the call as prose or pseudo-code (e.g. typing `schedule_task(\"...\", 120, ...)` as text is NOT calling it), and do NOT ask 'would you like me to…' or 'should I…'. The user's request is your go-ahead; any tool that needs confirmation already shows the user an approval card, so you never need to ask permission in text. Act first, then briefly say what you did. Only ask a question if you are genuinely blocked on information the tools can't give you.",
    "- If the user's message says you already have enough information, already found/identified something, or to just proceed/act/move on — do NOT perform another read_file/grep_files/list_directory/find_files/web_search call first. Act immediately with what you already have; re-investigating after being explicitly told to stop and act ignores the user's instruction.",
    "- If your change adds, removes, or materially changes a feature, tool, or tab, update FEATURES.md in the workspace root to match.",
    "- If a tool reports a path as not found, check the File tree in 'Current state' for the correct nested path (e.g. project files may live inside a subfolder like \"my-app/src/...\", not at the workspace root) before retrying — don't repeat a path that just failed.",
    "- Only ever call tools that appear under 'Tools available this session' below. If no listed tool fits, accomplish the goal with the tools you DO have — never invent a tool name (there is no 'create-skill', 'generate-dashboard', 'create-local-mind-skill', etc.); calling a non-existent tool just fails and wastes the turn.",
    "- The reverse mistake is just as bad: before telling the user a capability isn't available (downloading a file, removing an image background, resolving a folder path, etc.), CAREFULLY re-read the actual tool list below — do not answer from a general impression of 'what an AI chatbot can typically do.' A multi-step request (search, then download, then transform, then save) usually needs a matching CHAIN of tools that likely IS available even if no single tool does everything — check for one before claiming the task is impossible.",
    "- To create / author / save a skill when the user asks (even from a long spec they paste), call save_skill with name, tags, and content (the full markdown instructions) — that is the ONLY way to make a skill. To produce a report/document/dashboard, write_file the content yourself; there is no separate 'generate' tool.",
    "- If a task needs a capability you don't have: if a shell one-liner would do it, use register_tool to create that tool; if it needs LocalMind app changes you can't make, use propose_feature to draft a spec for the user/Claude to implement later — then tell the user which you did. Never fake a capability or loop retrying an impossible action.",
    "- To make something happen on a schedule / recurring / at a later time / unattended, ALWAYS use the schedule_task tool — LocalMind has a built-in background scheduler that survives restarts. NEVER use run_command with cron, crontab, Windows Task Scheduler, or a sleep loop for scheduling; those don't integrate with LocalMind and usually won't run. Connected MCP tools (e.g. a Google Calendar server) are for THAT service's data — they are NOT how you schedule LocalMind's own background tasks.",
    "- schedule_task's 'task' parameter MUST be a natural-English instruction describing THIS user's actual request, NEVER a shell command/code (no 'echo $(date) >> notes.md', no PowerShell syntax) and NEVER text copied from an example in this prompt or the tool's own schema — those are illustrations of the FORMAT, not tasks to actually schedule. The scheduled agent runs on the user's platform and emits the right commands itself; your job is only to describe what should happen, in plain English, specific to what was actually asked.",
    "- If there are several reasonable candidates and the user hasn't pinned down exactly which one (e.g. multiple search results, several matching files, several plausible images) — especially if they said something like 'pick any one' or 'you choose' — SELECT ONE YOURSELF using your best judgment and continue immediately. Do not stop to list the options and ask the user to pick; that is the same passivity as asking 'should I?' before acting. Mention which one you picked in your final summary, not before.",
    "- When you answer using search_knowledge, you MUST cite the bracketed source location shown with each result (e.g. `[CS101/lecture5.pdf p.12]`) inline in your answer. If search_knowledge returns no matching passages, tell the user the topic isn't in their notes — do not answer from general knowledge as if it came from their notes.",
    ...(config.tools.some((t) => t.name === "run_tool_script")
      ? ["- If run_tool_script is available this round and your next few actions are a known, linear sequence (e.g. read several files then write results, or list+filter+act), prefer writing one script over one tool call per round — it collapses several round-trips into a single inference pass."]
      : []),
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
  /** Knowledge-base collections (class notes/documents), fetched once per
   *  session and reused — collections don't change mid-session the way
   *  memory-search results or the file tree do. null = not yet fetched. */
  cachedCollections: Array<{ id: string; label: string; doc_count: number }> | null;
  /** The user-message text that cachedGlobalMemories was last searched
   *  against — lets buildCurrentStateBlock re-search only when the LATEST
   *  user message actually changes, instead of once per whole session. Kept
   *  separate from `taskQuery` below (which stays pinned to the ORIGINAL
   *  message for completion-review/skill-distillation framing). */
  lastGlobalMemoryQuery: string | null;
  taskQuery: string;
  changedFiles: Set<string>;
  /** Per-round tool-retrieval memoization (toolFilter.ts's retrieveToolsForStep):
   *  the objective string retrieval was last computed for, and its result.
   *  A task typically spends several consecutive rounds on the same
   *  in-progress todo before it changes, so this collapses "re-run every
   *  round" down to "re-run every todo change" in the common case — without
   *  it, BM25 is cheap enough to not matter, but the conditional embedding
   *  fallback would otherwise risk firing on every round of a multi-round
   *  todo instead of just its first. */
  lastRetrievalObjective: string | null;
  lastRetrievalResult: ToolDef[] | null;
  /** Structured facts about what tool calls have produced this session —
   *  mechanically populated from ToolResult.resource (tools.ts), never
   *  LLM-generated. FIFO-capped so a long session doesn't grow unbounded;
   *  the newest entry also feeds stateAwareObjectiveQuery's retrieval nudge. */
  resources: Array<{ kind: string; path?: string; url?: string; id?: string; label: string; toolName: string }>;
  /** Short ring buffer of recent tool-call errors, surfaced at high-recency
   *  in the prompt (same position as capabilityDenialGuard) so the model
   *  doesn't immediately retry an identical failing call — distinct from
   *  lastActionSummary, which gets overwritten every round and loses this. */
  recentErrors: string[];
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

/** Matches src="..."/href="..." attribute values in written HTML. */
const LOCAL_REF_RE = /(?:src|href)\s*=\s*["']([^"'#][^"']*)["']/gi;

function isLocalRef(ref: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) && !/^[a-z]:[\\/]/i.test(ref)) return false; // any URL scheme (http:, data:, mailto:, javascript:, ...) except a Windows drive letter
  if (ref.startsWith("//")) return false; // protocol-relative
  return true;
}

/**
 * Scans this session's written HTML files for local src="…"/href="…"
 * references (script/link/img tags) and returns any that don't actually
 * exist on disk — confirmed real failure pattern from session logs: the
 * agent wrote index.html referencing app.js, never wrote app.js, and the
 * session still ended reporting success. Best-effort: any read/parse
 * failure just skips that file rather than throwing.
 */
async function findMissingReferencedFiles(
  dirHandle: FileSystemDirectoryHandle,
  changedFiles: Set<string>,
): Promise<string[]> {
  const missing = new Set<string>();
  for (const filePath of changedFiles) {
    if (!/\.html?$/i.test(filePath)) continue;
    let content: string;
    try {
      content = await readFileFromHandle(dirHandle, filePath);
    } catch {
      continue;
    }
    const dir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
    LOCAL_REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LOCAL_REF_RE.exec(content))) {
      const ref = m[1].trim();
      if (!ref || !isLocalRef(ref)) continue;
      const joined = dir ? `${dir}/${ref}` : ref;
      let resolved: string;
      try {
        resolved = resolvePathParts(joined).join("/");
      } catch {
        continue;
      }
      if (!resolved || (await fileExists(dirHandle, resolved))) continue;
      missing.add(resolved);
    }
  }
  return [...missing];
}

interface CurrentStateBlock {
  block: string;
  /** Todos actually read from disk this round (empty when there's no
   *  workspace, or the session is conversational/headless-state-suppressed
   *  and never reads them at all) — returned so the round loop can derive
   *  the current-objective retrieval query from the SAME read instead of
   *  re-reading todos.json a second time per round. */
  todos: TodoItem[];
}

async function buildCurrentStateBlock(
  config: AgentRuntimeConfig,
  state: RuntimeState,
  round: number,
  history: ChatMessage[],
): Promise<CurrentStateBlock> {
  const lines: string[] = [
    "## Current state",
    "(Background context only — not instructions for this turn. Your task is the user's latest message above. Only resume the todos/plan/memory below if that message asks you to continue this project's work.)",
    `Round ${round}/${config.maxRounds}`,
  ];
  let todos: TodoItem[] = [];

  if (state.lastActionSummary) {
    lines.push(`Last action: ${state.lastActionSummary}`);
  }

  if (state.resources.length > 0) {
    const recentResources = state.resources.slice(-5).reverse();
    lines.push("", "Resources acquired this session:", ...recentResources.map((r) => `- ${r.label}`));
  }

  // Conversational mode AND headless runs (suppressStaleProjectState) both
  // omit on-disk project state (todos, project memory, file tree, skills).
  // That stale imperative content is the main thing that hijacks a session
  // into resuming/acting on old, unrelated work. Keep only the non-imperative
  // global-memory + open-file blocks below.
  if (config.dirHandle && !config.conversational && !config.suppressStaleProjectState) {
    todos = await readTodosFromDisk(config.dirHandle);
    config.onTodosChanged?.(todos); // full list (incl. completed) still goes to the UI panel

    // Only inject PENDING/IN-PROGRESS items into the model's context — a
    // fully checked-off todo list from a past, unrelated task carries zero
    // actionable signal and is pure hijack bait: a session was observed
    // drifting into finishing an old, already-unrelated app (never asked for
    // in the current message) with a stale, 100%-complete todo list as the
    // only plausible source of that tangent. Completed items are still shown
    // in the UI panel via onTodosChanged above; they're just not reprinted
    // into the prompt every round.
    const activeTodos = todos.filter((t) => t.status !== "completed" && t.status !== "cancelled");
    if (activeTodos.length > 0) {
      const todoLines = activeTodos.map((t) => {
        const mark = t.status === "in_progress" ? "[>]" : "[ ]";
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

  // Knowledge-base (class notes/documents) collections — fetched here
  // (once per session; collections don't change mid-session) but the actual
  // instruction is pushed at the very END of this function, not here. Small
  // models weight context by recency far more than a mid-block aside, and a
  // note buried between memory/skills blocks was observed getting outweighed
  // by a trained "I can't access your files" refusal reflex even with tools
  // available — see the failure this exists to fix.
  let knowledgeCollections: Array<{ id: string; label: string; doc_count: number }> = [];
  if (!config.suppressStaleProjectState) {
    if (state.cachedCollections === null) {
      try {
        state.cachedCollections = await tauriInvoke<Array<{ id: string; label: string; doc_count: number }>>("collections_all");
      } catch {
        state.cachedCollections = [];
      }
    }
    knowledgeCollections = state.cachedCollections;
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

  // Pushed LAST, deliberately: this is the single highest-recency line the
  // model sees before the actual conversation history, which matters more
  // than description quality for smaller models specifically — a version of
  // this note placed earlier in the block was observed being overridden by a
  // "I cannot access your personal files" refusal reflex even though
  // search_knowledge was available and offered. Named and forbade that exact
  // completion directly rather than only describing the right tool, since
  // the failure was the model not even attempting a tool call.
  if (knowledgeCollections.length > 0) {
    const names = knowledgeCollections.map((c) => `${c.label || c.id} (${c.doc_count} docs)`).join(", ");
    lines.push(
      "",
      `IMPORTANT — knowledge base available: ${knowledgeCollections.length} collection(s) — ${names}. If the user's message is about their notes, lectures, readings, or coursework, you MUST call search_knowledge (list_collections first if unsure which collection) BEFORE answering. Do NOT use grep_files/find_files for this — those only search this workspace's own project files, not the knowledge base. Do NOT respond that you cannot access the user's files/notes without first calling search_knowledge — that tool exists specifically to read them.`
    );
  }

  return { block: lines.join("\n"), todos };
}

/** The per-round objective query driving tool retrieval (toolFilter.ts) —
 *  the in-progress todo's text if there is one, else the first pending todo,
 *  else `state.taskQuery` (the original/latest user message) when there are
 *  no todos yet (session hasn't planned, or todos are unavailable in this
 *  context — conversational/headless-suppressed/no-workspace). Deliberately
 *  NOT `state.taskQuery` itself, which stays pinned to the original message
 *  for completion-review/skill-distillation framing (see its declaration) —
 *  same separation-of-concerns precedent as `lastGlobalMemoryQuery` above. */
function currentObjectiveQuery(todos: TodoItem[], state: RuntimeState): string {
  const active = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status === "pending");
  return active ? active.content : state.taskQuery;
}

/** currentObjectiveQuery's output enriched with the most recent resource
 *  fact, so retrieval itself shifts once state changes — e.g. once a file
 *  is downloaded, appending "(have: downloaded file at ...)" pulls
 *  remove_background/convert_image up in BM25 ranking via ordinary token
 *  overlap, without a new LLM call. Only the single most recent fact is
 *  folded in — rankBuiltinTools scores the whole string as one bag of
 *  tokens, and the todo-text signal is what's proven reliable; widen only
 *  if evidence shows a real multi-fact-needed case. */
function stateAwareObjectiveQuery(todos: TodoItem[], state: RuntimeState): string {
  const base = currentObjectiveQuery(todos, state);
  if (state.resources.length === 0) return base;
  const last = state.resources[state.resources.length - 1];
  return `${base} (have: ${last.label})`;
}

/**
 * Tools observed (live, twice, with the exact tools ranked well inside the
 * retrieved set both times) getting falsely denied by small models — the
 * model answers from a pretrained prior ("AI assistants can't edit images")
 * that overrides what's actually in its own context, the same failure shape
 * already fixed once for search_knowledge (see the knowledge-base note at
 * the end of buildCurrentStateBlock). That fix worked via two things a
 * mid-list rule doesn't get: it's the LAST thing in the prompt (highest
 * recency — small models weight that far more than description quality),
 * and it names and forbids the exact bad completion instead of only
 * describing the right tool. This generalizes that same pattern to a second
 * observed cluster (image download/editing) rather than duplicating the
 * knowledge-base-specific code.
 *
 * Evidence-driven, same spirit as ToolDef.aliases/useWhen's backfill: add a
 * capability to WATCHED_CAPABILITIES only once a real false-denial is
 * observed for it, not speculatively for every tool.
 */
const WATCHED_CAPABILITIES: Array<{ tools: string[]; label: string }> = [
  { tools: ["download_file", "remove_background", "search_images", "convert_image"], label: "downloading, editing, or converting images/files" },
];

/** Returns a late-recency reminder naming whichever watched tools survived
 *  THIS round's retrieval, or "" if none of them did (nothing to remind
 *  about, or retrieval genuinely excluded the whole cluster this round). */
function capabilityDenialGuard(toolsThisRound: ToolDef[]): string {
  const availableNames = new Set(toolsThisRound.map((t) => t.name));
  const lines: string[] = [];
  for (const { tools, label } of WATCHED_CAPABILITIES) {
    const present = tools.filter((t) => availableNames.has(t));
    if (present.length > 0) {
      lines.push(`For ${label}: you DO have ${present.join(", ")} — listed above under "Tools available this session". A multi-step request (find/download/edit/save) is a normal chain of several of these calls, not a missing capability. Do NOT tell the user you lack this ability.`);
    }
  }
  if (lines.length === 0) return "";
  return `\n\nIMPORTANT — capability reminder:\n${lines.join("\n")}`;
}

interface GuardedExecution {
  result: ToolResult;
  toolContent: string;
  blocked: boolean;
  sideEffect: boolean;
  /**
   * Only set when call.name === "run_tool_script": the union of mutating
   * paths and tool names from every NESTED call the script made. The round
   * loop's bookkeeping (state.changedFiles, calledThisRound/retrieval-miss
   * tracking) is keyed off the top-level call by default — pathsFromCall("run_tool_script")
   * would return [] since its args are just {code}, so this is how that
   * bookkeeping still sees what the script actually did internally.
   */
  scriptSideEffectPaths?: string[];
  scriptCalledTools?: string[];
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
  // Read-only alias keys (tools.ts TOOL_ALIASES) normalize to a built-in read
  // tool before metadata lookup would otherwise miss them under their alias name.
  if (READ_ONLY_ALIASES.includes(call.name)) {
    return { planModeAllowed: true, requiresApproval: false };
  }
  // MCP tools (serverId__toolName) get their policy from mcp.ts's
  // classifyMcpToolRisk, stamped onto `def` when the server's tool list was
  // fetched — a name-based read/write heuristic (list/get/search vs.
  // send/delete/create/etc.) instead of gating every MCP call identically at
  // max friction. Falls through to the safe default below if `def` is
  // missing (e.g. a stale tool name from a server that's since disconnected).
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
  toolsThisRound: ToolDef[],
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
  let def = config.tools.find((t) => t.name === call.name);

  // 0b. Hallucinated-MCP-name fallback — only when the called name isn't a
  // real tool actually offered this session (see HALLUCINATED_TOOL_FALLBACKS'
  // doc comment for why this can't be a blind rename in canonicalToolName).
  if (!def) {
    const fallbackName = HALLUCINATED_TOOL_FALLBACKS[call.name];
    if (fallbackName) {
      const fallbackDef = config.tools.find((t) => t.name === fallbackName);
      if (fallbackDef) {
        call = { ...call, name: fallbackName };
        def = fallbackDef;
      }
    }
  }

  const policy = resolveToolPolicy(call, def);

  if (!policy.planModeAllowed && !liveFlag(config.agentBuildMode)) {
    config.onPlanModeDenial?.(call);
    return {
      result: { toolCallId: call.id, name: call.name, output: "", error: "Denied (Plan mode)" },
      toolContent: "DENIED: You are in Plan mode (read-only). You may read files, search, and call todo_write. The user must switch to Build mode before write/patch/run/install/git-write tools (or other mutating/external/unrecognized tools) can run.",
      blocked: true,
      sideEffect: false,
    };
  }

  // 2. Approval gate
  if (policy.requiresApproval && !liveFlag(config.autoApproveAll)) {
    const approved = await config.onApprovalNeeded(call);
    if (!approved) {
      // suppressStaleProjectState is true for every headless run (scheduler,
      // task queue, subagent, workflow — see headlessRunner.ts) and only
      // those runs auto-deny via a fixed allowlist with no human involved.
      // A model that reads "Denied by user" here was observed narrating it
      // back as "the user denied this" and then thrashing/asking the user to
      // reconsider — there is no user to reconsider anything in this run.
      // Distinguishing the message stops that misattribution and points
      // straight at the actual recovery (inline the logic, don't retry).
      const isUnattended = !!config.suppressStaleProjectState;
      const errorMsg = isUnattended
        ? `Denied — '${call.name}' is not permitted in this unattended run (no human is present to approve it; this run's allowlist is fixed)`
        : "Denied by user";
      const toolContent = isUnattended
        ? `DENIED (unattended run): ${call.name} is not on this run's allowlist — this is a permanent constraint for the whole run, not a one-off refusal, so retrying it will never succeed. Do not ask the user to reconsider — there is no user watching this run. If the task needs what this call would have done (e.g. running a script), work out the underlying logic yourself in plain reasoning and apply it directly with read_file/write_file/patch_file instead.`
        : "Tool call denied by user.";
      return {
        result: { toolCallId: call.id, name: call.name, output: "", error: errorMsg },
        toolContent,
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

  // 4.5. Code Mode: run_tool_script executes a sandboxed script instead of
  // going through executeTool directly (see toolScript.ts for the sandbox
  // itself). Every nested call the script makes re-enters THIS function
  // recursively, so approval/StuckDetector/read-before-write/capToolOutput/
  // shadow-git all still apply per nested call, exactly as if each were its
  // own normal round — the script is purely a batching mechanism, not a
  // bypass of any gate above.
  if (call.name === "run_tool_script") {
    const code = typeof call.args["code"] === "string" ? (call.args["code"] as string) : "";
    if (!code.trim()) {
      return {
        result: { toolCallId: call.id, name: call.name, output: "", error: "Empty script" },
        toolContent: "run_tool_script was called with no code. Provide JavaScript that calls one or more of your available tools, e.g. read_file({ path: \"a.ts\" }).",
        blocked: true,
        sideEffect: false,
      };
    }

    const nestedCalledTools = new Set<string>();
    const dispatch = async (name: string, nestedArgs: Record<string, unknown>) => {
      if (name === "run_tool_script") {
        return { output: "", error: "run_tool_script cannot call itself from inside a script." };
      }
      const nestedCall: ToolCall = { id: crypto.randomUUID(), name, args: nestedArgs };
      const label = formatToolLabel(nestedCall.name, nestedCall.args);
      config.onToolCallStart?.(nestedCall, label);
      const nested = await executeToolGuarded(nestedCall, config, detector, sessionReadPaths, toolsThisRound);
      const nestedSummary = nested.blocked
        ? `${label} → ${nested.result.error}`
        : nested.result.error ? `${label} → error` : summariseToolResult(nestedCall.name, nestedCall.args, nested.result.output);
      config.onToolCallResolved?.(nestedCall, label, nested.result, nestedSummary, nested.toolContent);
      nestedCalledTools.add(name);
      if (nested.scriptCalledTools) for (const n of nested.scriptCalledTools) nestedCalledTools.add(n);
      return {
        output: nested.toolContent,
        error: nested.result.error,
        sideEffect: nested.sideEffect,
        paths: nested.sideEffect ? pathsFromCall(nestedCall) : (nested.scriptSideEffectPaths ?? []),
      };
    };

    const scriptResult = await runToolScript(code, toolsThisRound, dispatch);

    if (scriptResult.sandboxError) {
      const toolContent = capToolOutput(
        `Script failed: ${scriptResult.sandboxError}\nFall back to calling tools directly, one per round, if this keeps happening.`,
      );
      return {
        result: { toolCallId: call.id, name: call.name, output: "", error: scriptResult.sandboxError },
        toolContent,
        blocked: false,
        sideEffect: scriptResult.hadMutatingCall,
        scriptSideEffectPaths: [...scriptResult.sideEffectPaths],
        scriptCalledTools: [...nestedCalledTools],
      };
    }

    const callLines = scriptResult.calls.map((c, i) => {
      const label = formatToolLabel(c.name, c.args);
      const short = c.error ? `Error: ${c.error}` : summariseToolResult(c.name, c.args, c.output);
      return `${i + 1}. ${label} → ${short}`;
    });
    let toolContent = [
      `Ran run_tool_script (${scriptResult.calls.length} tool call${scriptResult.calls.length === 1 ? "" : "s"}):`,
      ...callLines,
      scriptResult.consoleOutput ? `\nconsole output:\n${scriptResult.consoleOutput}` : "",
      `\nreturn value: ${scriptResult.returnValue}`,
    ].filter(Boolean).join("\n");
    toolContent = capToolOutput(toolContent);

    return {
      result: { toolCallId: call.id, name: call.name, output: toolContent },
      toolContent,
      blocked: false,
      sideEffect: scriptResult.hadMutatingCall,
      scriptSideEffectPaths: [...scriptResult.sideEffectPaths],
      scriptCalledTools: [...nestedCalledTools],
    };
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

  // Shadow-git auto-commit (coding-agent overhaul, workstream 4): an
  // automatic, model-invisible safety net, not a tool the model calls or
  // that goes through approval — this is why it fires here unconditionally
  // for every successful mutating call, regardless of headless/scheduler
  // context, unlike git_add/git_commit (which stay excluded from unattended
  // runs by design, since THOSE touch the user's own real repo on request).
  // Fire-and-forget: never awaited, never allowed to affect the agent loop.
  if (sideEffect && config.workspacePath) {
    void commitAfterToolCall(config.workspacePath, call.name, pathsFromCall(call), config.surfaceLabel ?? config.currentView);
  }

  return { result, toolContent, blocked: false, sideEffect };
}

export async function runAgentSession(
  priorHistory: ChatMessage[],
  config: AgentRuntimeConfig,
): Promise<AgentRuntimeResult> {
  // "Code Mode" (run_tool_script) is opt-in via the normal per-tool toggle
  // (store/agent.ts's DEFAULT_TOOLS_ENABLED, off by default — same posture as
  // run_command), but even when a user has switched it on, only offer it to
  // models supportsCodeMode judges capable of writing a small reliable
  // script — see that function's doc comment for why. Filtered once here
  // rather than at every config.tools read site below.
  if (config.tools.some((t) => t.name === "run_tool_script") && !supportsCodeMode(config.modelRef)) {
    config = { ...config, tools: config.tools.filter((t) => t.name !== "run_tool_script") };
  }
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
    cachedCollections: null,
    taskQuery: deriveTaskQuery(priorHistory),
    changedFiles: new Set<string>(),
    lastRetrievalObjective: null,
    lastRetrievalResult: null,
    resources: [],
    recentErrors: [],
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
  let missingRefNudgeCount = 0;
  let contextOverflowRetries = 0;
  let hadDeniedToolCalls = false;
  // expectSideEffects sessions (scheduler/task-queue) get a 2nd inaction nudge —
  // observed live: a single distraction (e.g. a stray management-tool call) or
  // even a totally blank round can burn the only nudge, after which the run
  // silently ends with zero side effects and no further chance to recover.
  // Interactive/subagent sessions keep the original single-nudge budget: a
  // human is present to just ask again, so a 2nd automatic retry isn't worth
  // the extra round.
  const maxInactionNudges = config.expectSideEffects ? 2 : 1;

  // Session-level tool list — NOT what most rounds actually use anymore (see
  // retrieveToolsForStep below, called fresh per round in the main loop).
  // This one-time, original-message-scoped filter now only backs two things:
  // the toolless-model early-return path just below (no round loop to be
  // "per-round" in), and the router's own tool set/prompt (kept exactly as
  // before this change — see the router comment beneath this block).
  const toolsForModel = config.toolsSupported
    ? await filterToolsByRelevance(config.tools, state.taskQuery)
    : [];
  const systemPrompt = buildSystemPrompt(
    config.toolsSupported ? { ...config, tools: toolsForModel } : config,
  );

  // Tool-router delegation (opt-in, see modelRoles.ts's `router` role): a
  // pinned model — typically a fast/cheap cloud one — drives the FIRST few
  // rounds' tool selection instead of config.modelRef, restricted to
  // read-only lookup tools (risk:"read" — search_knowledge, grep_files,
  // web_search, etc., never write/run/delete). Once it stops calling tools
  // (or hits the round cap below), control hands off to the normal
  // config.modelRef for every remaining round — including writing the
  // actual final answer — with the full history of whatever the router
  // found already in context. Exists because local models were observed
  // struggling specifically at picking the right tool among several
  // similar-sounding ones, not at synthesizing an answer once handed good
  // results; unpinned (the default), this resolves to null and the whole
  // session behaves exactly as before this feature existed.
  const routerModel = config.toolsSupported ? resolveRole("router") : null;
  const routerTools = toolsForModel.filter((t) => t.risk === "read");
  const ROUTER_MAX_ROUNDS = 4;
  let routingPhaseActive = !!routerModel && routerTools.length > 0;
  let routerRoundsUsed = 0;
  // A SEPARATE system prompt for router rounds, built from routerTools —
  // reusing `systemPrompt` (built from the full toolsForModel) would have its
  // "Tools available this session" listing (buildCapabilityBlock) advertise
  // write/run/delete tools the router round doesn't actually have access to,
  // which invites exactly the confused "why didn't my tool call work" outcome
  // this feature exists to avoid.
  const routerSystemPrompt = routingPhaseActive
    ? buildSystemPrompt({ ...config, tools: routerTools, modelRef: routerModel! })
    : "";

  try {
    if (!config.toolsSupported) {
      round = 1;
      config.onRoundStart?.(round, config.maxRounds);
      config.onDebugPrompt?.({ round, systemMessage: systemPrompt });
      for await (const chunk of streamChatForModel(
        config.modelRef,
        [{ role: "system", content: systemPrompt }, ...history],
        config.signal,
      )) {
        config.onTextDelta?.(chunk);
      }
      return { hadSideEffects, hitRoundLimit, wasAborted, roundsUsed: round, finalHistory: history, hadDeniedToolCalls };
    }

    // Tool(s) called in the immediately preceding round — pinned into this
    // round's retrieval regardless of score (see toolFilter.ts's recency
    // pin), so a mid-chain sequence can't have its next expected tool
    // dropped just because the objective text didn't mention it. Updated at
    // the end of each non-router round below; router rounds don't touch it,
    // since it only feeds the non-router retrieval path.
    let recentToolNames = new Set<string>();

    while (round < config.maxRounds) {
      round++;
      const isRouterRound = routingPhaseActive;
      // Suppressed during router rounds: App.tsx's onRoundStart opens a fresh
      // message bubble per round, but a router round's text is never shown
      // (see the text_delta handling below) — opening bubbles nothing ever
      // writes into would leave empty gaps in the transcript.
      if (!isRouterRound) config.onRoundStart?.(round, config.maxRounds);

      const { block: stateBlock, todos } = await buildCurrentStateBlock(config, state, round, history);
      const routerRoundNote = isRouterRound
        ? "\n\nYou are in a TOOL-LOOKUP phase, not the main agent for this task: use ONLY the read-only tools available to you to gather what's needed to answer the user. You cannot write/modify/run anything right now (those tools aren't offered this round) — don't attempt to. Once you've found the relevant information, STOP calling tools; a different model takes over from there to write the actual answer."
        : "";

      // Per-round tool retrieval (non-router path only — the router keeps
      // its own fixed read-only tool set/prompt from before the loop,
      // untouched by this feature). Keyed on the CURRENT objective (the
      // in-progress todo, not the pinned original message — see
      // currentObjectiveQuery's doc comment), re-run only when that
      // objective actually changed since last round (memoized below), which
      // in practice collapses "every round" down to "every todo change."
      let toolsThisRoundNonRouter = toolsForModel;
      let nonRouterSystemPrompt = systemPrompt;
      if (!isRouterRound) {
        const objective = stateAwareObjectiveQuery(todos, state);
        if (objective === state.lastRetrievalObjective && state.lastRetrievalResult) {
          toolsThisRoundNonRouter = state.lastRetrievalResult;
        } else {
          toolsThisRoundNonRouter = await retrieveToolsForStep(config.tools, objective, recentToolNames);
          state.lastRetrievalObjective = objective;
          state.lastRetrievalResult = toolsThisRoundNonRouter;
        }
        nonRouterSystemPrompt = buildSystemPrompt({ ...config, tools: toolsThisRoundNonRouter });
      }

      const activeSystemPrompt = isRouterRound ? routerSystemPrompt : nonRouterSystemPrompt;

      // WP4.1: fold old history into a compact work-log stub before the
      // projected token load overflows numCtx (see compactHistoryIfOverBudget
      // for the cut-boundary rule). No LLM call here — mid-loop model calls
      // cause VRAM thrash on 16GB-class targets.
      const compaction = compactHistoryIfOverBudget(activeSystemPrompt, stateBlock, history, numCtx);
      if (compaction.compacted) {
        history = compaction.history;
        console.info(
          `[context] compacted ${compaction.foldedCount} msgs → ~${compaction.tokensAfter} tokens (was ~${compaction.tokensBefore}, budget ~${Math.round(numCtx * 0.7)})`,
        );
      }

      // Pushed after the state block (highest-recency position, same
      // reasoning as the knowledge-base note inside buildCurrentStateBlock)
      // — router rounds skip it, same reasoning as routerRoundNote: it's a
      // primary-model concern, not something the read-only lookup phase needs.
      const capabilityGuard = isRouterRound ? "" : capabilityDenialGuard(toolsThisRoundNonRouter);
      // Same high-recency position/reasoning as capabilityGuard above — a
      // small model needs a failure named at the very end of the prompt to
      // reliably avoid repeating it, not buried mid-prompt in the state block.
      const errorGuard = isRouterRound || state.recentErrors.length === 0
        ? ""
        : `\n\nRecent errors this session (do not repeat the same failing call — try a different approach):\n${state.recentErrors.slice(-3).map((e) => `- ${e}`).join("\n")}`;
      const roundSystemMessage = `${activeSystemPrompt}\n\n${stateBlock}${routerRoundNote}${capabilityGuard}${errorGuard}`;
      const messagesForRound: ChatMessage[] = [
        { role: "system", content: roundSystemMessage },
        ...history,
      ];
      config.onDebugPrompt?.({ round, systemMessage: roundSystemMessage });

      lastRoundHadToolCalls = false;
      let roundText = "";
      let overflowRetryHandled = false;
      const calledThisRound = new Set<string>();

      const modelForThisRound = isRouterRound ? routerModel! : config.modelRef;
      const toolsForThisRound = isRouterRound ? routerTools : toolsThisRoundNonRouter;

      for await (const event of runAgentTurnForModel(modelForThisRound, messagesForRound, toolsForThisRound, config.signal, { numCtx })) {
        if (config.signal.aborted) throw new DOMException("Aborted", "AbortError");

        if (event.type === "thinking_delta" && event.content) {
          if (!isRouterRound) config.onThinkingDelta?.(event.content);
        } else if (event.type === "text_delta" && event.content) {
          if (event.content.startsWith("\x00CLEAN:")) {
            const clean = event.content.slice("\x00CLEAN:".length);
            if (!isRouterRound) config.onTextReplace?.(clean);
            roundText = clean;
          } else {
            const cleaned = event.content.replace(/<\|im_start\|>|<\|im_end\|>|<\|endoftext\|>/g, "");
            if (cleaned) {
              if (!isRouterRound) config.onTextDelta?.(cleaned);
              roundText += cleaned;
            }
          }
        } else if (event.type === "tool_calls" && event.toolCalls) {
          lastRoundHadToolCalls = true;
          anyToolCallsThisSession = true;

          for (const call of event.toolCalls) {
            if (config.signal.aborted) throw new DOMException("Aborted", "AbortError");

            calledThisRound.add(call.name);
            const label = formatToolLabel(call.name, call.args);
            config.onToolCallStart?.(call, label);
            config.onActivity?.(label);

            const { result, toolContent, blocked, sideEffect, scriptSideEffectPaths, scriptCalledTools } =
              await executeToolGuarded(call, config, detector, sessionReadPaths, toolsForThisRound);

            config.onActivity?.(null);

            // A run_tool_script call's own tool-retrieval/recency bookkeeping
            // should reflect what it actually called internally, not just the
            // wrapper name — otherwise every nested tool looks like a
            // retrieval miss next round (it WAS in this round's retrieved
            // set; it just wasn't the top-level call).
            if (scriptCalledTools) for (const n of scriptCalledTools) calledThisRound.add(n);

            if (sideEffect) {
              hadSideEffects = true;
              state.treeDirty = true;
              if (call.name === "install_deps") state.memoryDirty = true;
              const paths = call.name === "run_tool_script" ? (scriptSideEffectPaths ?? []) : pathsFromCall(call);
              for (const p of paths) state.changedFiles.add(p);
            }
            if (blocked && (result.error === "Denied by user" || result.error?.startsWith("Denied — "))) {
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

            if (!blocked && result.resource) {
              state.resources.push({ ...result.resource, toolName: call.name });
              if (state.resources.length > 20) state.resources.shift();
            }
            if (!blocked && result.error) {
              state.recentErrors.push(`${call.name}: ${result.error}`);
              if (state.recentErrors.length > 5) state.recentErrors.shift();
            }

            config.onToolCallResolved?.(call, label, result, summary, toolContent);

            history = [
              ...history,
              { role: "assistant", content: "", tool_calls: [{ function: { name: call.name, arguments: call.args } }] },
              { role: "tool", content: toolContent },
            ];
          }
        } else if (event.type === "error") {
          // A router-round error (bad API key, rate limit, network blip on
          // the cloud provider) must not surface as a broken-looking chat
          // response — fall back to the local model for the rest of the
          // session instead of showing a confusing cloud-API error mid-answer.
          if (isRouterRound) {
            routingPhaseActive = false;
          } else if (isContextOverflowError(event.error) && contextOverflowRetries < MAX_CONTEXT_OVERFLOW_RETRIES) {
            // Reactive safety net alongside the proactive budget-ratio
            // compaction above: the provider itself just rejected this
            // request as too long, so the ~4-chars/token estimate that
            // compaction relies on was wrong this round. Fold much harder
            // and retry the SAME round rather than surfacing the raw
            // provider error or burning a round out of maxRounds on a
            // request that never actually ran.
            contextOverflowRetries++;
            const aggressive = compactHistoryAggressively(activeSystemPrompt, stateBlock, history);
            if (aggressive.compacted) {
              history = aggressive.history;
              console.info(
                `[context] overflow retry ${contextOverflowRetries}/${MAX_CONTEXT_OVERFLOW_RETRIES}: compacted ${aggressive.foldedCount} msgs → ~${aggressive.tokensAfter} tokens (was ~${aggressive.tokensBefore})`,
              );
              overflowRetryHandled = true;
              break;
            }
            // Nothing left to fold — compaction can't help further, fall
            // through to the same clear message as the retries-exhausted case.
            config.onTextDelta?.(
              `\n\n*[This model's context window (numCtx=${numCtx}) is too small for this conversation even after aggressive compaction — try a model with a larger context window, or start a new chat.]*`,
            );
          } else if (isContextOverflowError(event.error)) {
            config.onTextDelta?.(
              `\n\n*[This model's context window (numCtx=${numCtx}) is too small for this conversation even after aggressive compaction — try a model with a larger context window, or start a new chat.]*`,
            );
          } else {
            config.onTextDelta?.(`\n\n*[Agent error: ${event.error}]*`);
          }
        }
      }

      if (overflowRetryHandled) {
        round--; // this attempt never actually ran a model turn — don't count it against maxRounds
        continue;
      }

      if (isRouterRound) {
        routerRoundsUsed++;
        if (!lastRoundHadToolCalls || routerRoundsUsed >= ROUTER_MAX_ROUNDS) {
          // Routing phase over — either the router stopped calling tools (it
          // thinks it has what's needed) or it's used its round budget.
          // Discard whatever text it produced this round (it's the router's
          // own draft answer, not what should reach the user) and hand off:
          // the next iteration runs config.modelRef normally, with the full
          // tool-call history the router gathered already in `history`.
          routingPhaseActive = false;
        }
        continue; // never run the primary-model-only nudge/completion-review checks below on a router round
      }

      // Retrieval-miss instrumentation: a tool called this round that wasn't
      // in this round's retrieved candidate set means either a safety net
      // (core tier/recency pin/alias hard-include) rescued it, or — if it
      // reached the model's own tool schema at all, which it must have to be
      // callable — something let it through outside retrieveToolsForStep's
      // ranked slice. Logged so real misses can drive the evidence-based
      // useWhen/aliases backfill (see tools.ts's ToolDef doc comments)
      // instead of hand-authoring metadata for all ~86 tools upfront.
      if (calledThisRound.size > 0) {
        const retrievedNames = new Set(toolsForThisRound.map((t) => t.name));
        for (const name of calledThisRound) {
          if (!retrievedNames.has(name)) {
            const objective = state.lastRetrievalObjective ?? "";
            console.info(`[tool-retrieval] miss: "${name}" called but not in this round's retrieved set (objective: ${JSON.stringify(objective)})`);
            config.onRetrievalMiss?.({ round, toolName: name, objective });
          }
        }
      }
      // Pin this round's calls into the NEXT round's retrieval regardless of
      // that round's objective/score — see the recentToolNames declaration
      // above the loop.
      recentToolNames = calledThisRound;

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
        // Conversational (restricted-agent) turns are explicitly instructed to
        // answer in plain text with NO tool calls (see buildConversationalSystemPrompt/
        // the SCOPE CHECK step) — without this guard, a correct text-only answer
        // to something like "what can you do?" looks identical to a build task
        // that did nothing, so the nudge fired anyway and forced a pointless
        // second round (onRoundStart(2) opens a new message bubble, and the
        // model answers the same question again independently) — the double-response bug.
        const shouldNudgeInaction = liveFlag(config.agentBuildMode)
          && !config.conversational
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

        // 2i: before allowing a clean stop, check whether a written HTML file
        // references a local script/stylesheet that was never actually
        // created — a model can otherwise mark the task "done" while a
        // <script src="app.js"> points at nothing (confirmed real failure,
        // see findMissingReferencedFiles' doc comment).
        if (
          liveFlag(config.agentBuildMode) && config.dirHandle && hadSideEffects &&
          missingRefNudgeCount < MAX_MISSING_REF_NUDGES && round < config.maxRounds
        ) {
          const missing = await findMissingReferencedFiles(config.dirHandle, state.changedFiles).catch(() => [] as string[]);
          if (missing.length > 0) {
            missingRefNudgeCount++;
            const missingList = missing.map((p) => `"${p}"`).join(", ");
            history = [
              ...history,
              {
                role: "user",
                content: `A file you wrote references ${missingList}, but ${missing.length === 1 ? "that file doesn't" : "those files don't"} actually exist on disk. Create ${missing.length === 1 ? "it" : "them"} now with write_file before doing anything else — do not just describe it or mark the task done.`,
              },
            ];
            continue;
          }
        }

        const canRecheck = liveFlag(config.agentBuildMode) && hadSideEffects && completionCheckCount < MAX_COMPLETION_CHECKS
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
      liveFlag(config.agentBuildMode) &&
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
      liveFlag(config.agentBuildMode) &&
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

/** One-shot digest: summarize the just-finished session into a candidate skill.
 *
 *  Two failure modes this guards against (both observed in practice — see the
 *  skill registry after a few weeks of real use): (1) the model has no idea
 *  what skills already exist, so every session touching a similar task (e.g.
 *  "append a timestamp to a file") mints a brand-new near-duplicate instead of
 *  reusing/updating one; (2) with no explicit instruction to generalize, the
 *  model bakes in this session's literal specifics (an exact filename like
 *  `game.py`) instead of writing a procedure that actually transfers to a
 *  different file/project next time. Both are addressed by showing the model
 *  what's already saved and asking it to either name an EXISTING skill (which
 *  saveSkill's create-or-overwrite-by-slug behavior turns into an update) or
 *  explicitly skip. */
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

  const existingSkills = config.dirHandle ? await loadSkills(config.dirHandle).catch(() => []) : [];
  // Cap defensively (skill sets are small in practice, but this is a
  // best-effort background digest that must never blow up the prompt) — full
  // content, not just names, because approving a "merge" writes `content` as
  // a full file replacement (saveSkill overwrites by slug); the model needs
  // to see what's already there to fold it in rather than clobbering it.
  const existingSkillsList = existingSkills
    .slice(0, 25)
    .map((s) => `### "${s.name}" (tags: ${s.tags.join(", ") || "none"})\n${s.content.slice(0, 500)}`)
    .join("\n\n");

  const prompt = [
    "You just completed a multi-step coding task. Decide whether it's worth turning into a REUSABLE skill document for next time.",
    `Original task: ${state.taskQuery}`,
    changed.length ? `Files changed: ${changed.join(", ")}` : "",
    toolSummaries.length ? `Actions taken:\n- ${toolSummaries.join("\n- ")}` : "",
    "",
    existingSkillsList
      ? `Skills already saved in this workspace:\n\n${existingSkillsList}\n`
      : "No skills are saved in this workspace yet.\n",
    "GENERALIZE — this is the most important rule. Write the skill as a procedure that transfers to a DIFFERENT file/project next time, never a transcript of exactly what happened this session. Strip out this session's specific literal details: replace an exact filename like `game.py` with 'the target file' or 'your entry-point file', replace a hardcoded value with a description of how to derive it, etc. If you can't describe the task without naming this session's specific file/value, it's too narrow to be a skill — respond with {} instead.",
    "AVOID DUPLICATES — check the existing skills above first. If this task's underlying procedure is already covered by one of them (even if this session used different literal specifics), respond using that skill's EXACT existing name, and make `content` the FULL replacement text for it: keep everything from its existing content shown above that's still accurate, and fold in anything new this session revealed. Only propose a genuinely new name when no existing skill covers this procedure.",
    'Respond with ONLY a JSON object: {"name": "<short, generic skill name — reuse an existing name from the list above if this overlaps with it>", "tags": ["..."], "content": "<markdown: when to use, the procedure/steps, key commands, known gotchas, and how to verify>"}.',
    "If the task was trivial, a one-off that won't recur, or already fully covered by an existing skill with nothing new to add, respond with {}.",
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
