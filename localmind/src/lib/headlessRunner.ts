import type { ChatMessage } from "./ollama";
import type { ToolDef, ToolCall } from "./tools";
import { TOOL_DEFINITIONS } from "./tools";
import { TauriDirectoryHandle } from "./tauriFs";
import { runAgentSession, DEFAULT_MAX_ROUNDS } from "./agentRuntime";
import type { AgentRuntimeConfig } from "./agentRuntime";
import type { HardwareInfo } from "./hardware";
import type { AppView } from "../types/app";
import { useSessionResultsStore } from "../store/sessionResults";
import type { SessionResult } from "../store/sessionResults";
import { indexSession } from "./sessionSearch";

/**
 * Built-in tools that only make sense from an interactive UI session — no
 * meaningful headless behavior (switch_view/switch_model navigate tabs the
 * headless run has none of; send_task_to_tab targets a tab). register_tool
 * is left out too: dynamic tool registration isn't wired up for headless
 * execution yet.
 *
 * NOTE: MCP / dynamic (.localmind/tools/*.json) tools are intentionally NOT
 * included in the headless toolset for now — only the static built-ins above.
 *
 * spawn_subagent is excluded too — this is the recursion guard for WP2.3: a
 * headless session (subagent, task-queue run, or scheduled run) must never be
 * able to spawn its own subagents. Belt-and-suspenders with the approval
 * allowlist: even if a headless session's tool list were ever widened to
 * include spawn_subagent again, HEADLESS_DEFAULT_ALLOWLIST below does not
 * contain it, so runHeadlessTask's onApprovalNeeded would auto-deny the call.
 *
 * save_global_memory / update_project_memory are excluded because unattended
 * runs must not write to the assistant's long-term knowledge (a scheduled run
 * was observed hijacked by stale context into unrelated knowledge writes) —
 * and being requiresApproval:false they'd otherwise be offered regardless of
 * the allowlist. save_skill needs no entry here: it requires approval and is
 * not allowlisted, so the requiresApproval-or-allowlisted filter drops it.
 */
const HEADLESS_EXCLUDED_TOOLS = new Set(["switch_view", "switch_model", "send_task_to_tab", "register_tool", "spawn_subagent", "save_global_memory", "update_project_memory"]);

// Computed lazily (NOT a module-top-level const): headlessRunner is imported at
// app startup by taskRunner/scheduler, and referencing TOOL_DEFINITIONS at load
// time hits a circular-import temporal-dead-zone ("Cannot access 'TOOL_DEFINITIONS'
// before initialization"). Deferring to call time runs after all modules init.
export function getHeadlessDefaultTools(): ToolDef[] {
  return TOOL_DEFINITIONS.filter((t) => !HEADLESS_EXCLUDED_TOOLS.has(t.name));
}

/**
 * Default auto-approve allowlist when the caller doesn't specify one: only
 * read-only tools. Anything else that requires approval (write_file,
 * patch_file, run_command, git_add, git_commit, install_deps, save_skill,
 * switch_model/switch_view/send_task_to_tab if ever included, etc.) is
 * auto-DENIED — an unparameterized headless run can inspect the workspace
 * but not mutate it.
 */
export const HEADLESS_DEFAULT_ALLOWLIST: string[] = [
  "read_file",
  "list_directory",
  "grep_files",
  "find_files",
  "web_search",
  "web_fetch",
  "get_system_info",
  "git_status",
  "git_diff",
  "git_log",
  "list_skills",
  "calculator",
];

export interface HeadlessTaskOpts {
  workspacePath: string;
  modelRef: string;
  /** The user instruction to run. */
  task: string;
  hardware?: HardwareInfo | null;
  numCtxOverride?: number | null;
  /** Default true — full read/write/run access (still gated by toolAllowlist for approval-requiring tools). */
  agentBuildMode?: boolean;
  /** Tool names auto-approved when they'd otherwise require approval. Anything requiring approval AND not listed is auto-DENIED. Defaults to HEADLESS_DEFAULT_ALLOWLIST (read-only tools). */
  toolAllowlist?: string[];
  maxRounds?: number;
  currentView?: AppView;
  /** Where this run was launched from, e.g. "task-queue" | "scheduler" | "subagent" | "manual" — recorded on the session record. */
  origin?: string;
  /**
   * This run's whole point is to mutate the workspace (write/patch a file,
   * etc.) — there's no chat UI for anyone to read a text-only answer, so
   * ending with zero side effects means the task didn't actually happen, even
   * if the model calmly reports "done" after just reading/calculating
   * something (e.g. calling get_current_datetime and then claiming in text
   * that it appended the result, without ever calling write_file). Scheduler
   * and task-queue runs set this; subagents leave it unset because a
   * legitimate subagent task can be read-only (e.g. "summarize these files"
   * — its answer is the transcript itself, returned to the parent).
   */
  expectSideEffects?: boolean;
  signal?: AbortSignal;
}

export interface HeadlessTaskRunResult {
  record: SessionResult;
  transcript: string;
  steps: string[];
}

/**
 * Registers the workspace root with the Rust confinement layer so fs_* /
 * run_command are allowed to touch it. Mirrors the inline pattern used by
 * src/store/agent.ts's registerWorkspaceRoot — deliberately not imported
 * from there to avoid coupling headlessRunner to the store module.
 * Fire-and-forget: failure just means confinement stays as-is (browser mode,
 * or the command isn't available) and fs_* calls will surface a clear error.
 */
async function registerWorkspaceRoot(path: string): Promise<void> {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__ as
    | { core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } }
    | undefined;
  const invoke = tauri?.core?.invoke;
  if (typeof invoke !== "function") return; // browser mode — no confinement layer
  try {
    await invoke("register_workspace_root", { path });
  } catch {
    // ignore — see doc comment above
  }
}

function deriveWorkspaceName(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "workspace";
}

/**
 * Runs a full agent session with no UI attached — used by the task queue
 * runner, scheduler, and subagent callers. Constructs a TauriDirectoryHandle
 * directly from workspacePath (no folder-picker / user-gesture needed),
 * registers the workspace root for the fs confinement layer, then drives
 * runAgentSession the same way the interactive UI does, just with all
 * callbacks replaced by in-memory accumulation instead of DOM updates.
 *
 * Approval policy: only tools in opts.toolAllowlist (default:
 * HEADLESS_DEFAULT_ALLOWLIST, the read-only tools) are auto-approved when
 * they'd otherwise prompt for approval; every other approval-requiring tool
 * call is auto-denied. Plan-mode denial and all other guards in
 * agentRuntime.ts (read-before-write, stuck detector, etc.) are unaffected.
 */
export async function runHeadlessTask(opts: HeadlessTaskOpts): Promise<HeadlessTaskRunResult> {
  const startedAt = Date.now();
  const id = crypto.randomUUID();
  const origin = opts.origin ?? "manual";
  const allowlist = opts.toolAllowlist ?? HEADLESS_DEFAULT_ALLOWLIST;

  await registerWorkspaceRoot(opts.workspacePath);

  const handle = new TauriDirectoryHandle(opts.workspacePath) as unknown as FileSystemDirectoryHandle;
  const workspaceName = deriveWorkspaceName(opts.workspacePath);

  const controller = opts.signal ? null : new AbortController();
  const signal = opts.signal ?? controller!.signal;

  let transcript = "";
  const steps: string[] = [];

  const config: AgentRuntimeConfig = {
    modelRef: opts.modelRef,
    hardware: opts.hardware ?? null,
    numCtxOverride: opts.numCtxOverride ?? null,

    dirHandle: handle,
    workspacePath: opts.workspacePath,
    workspaceName,
    currentView: opts.currentView ?? "chat",

    // Only offer tools the model can actually get approved: no-approval tools
    // (read_file, list_directory, …) plus whatever's on this run's allowlist.
    // Advertising e.g. run_command when it will always be auto-denied just
    // wastes a round on a dead-on-arrival call — and previously let a session
    // "complete" having accomplished nothing (see hadDeniedToolCalls below).
    tools: getHeadlessDefaultTools().filter((t) => !t.requiresApproval || allowlist.includes(t.name)),
    agentBuildMode: opts.agentBuildMode ?? true,
    autoApproveAll: false,
    toolsSupported: true,
    maxRounds: opts.maxRounds ?? DEFAULT_MAX_ROUNDS,
    expectSideEffects: opts.expectSideEffects ?? false,
    // Every headless run is a fresh, self-contained instruction, not a
    // continuation of interactive project work — never let stale on-disk
    // todos/memory/skills from ordinary use of this workspace hijack it.
    suppressStaleProjectState: true,

    onTextDelta: (chunk) => {
      transcript += chunk;
    },
    onTextReplace: (cleanText) => {
      transcript = cleanText;
    },
    onApprovalNeeded: (call: ToolCall) => Promise.resolve(allowlist.includes(call.name)),
    onToolCallResolved: (_call, label, _result, summary) => {
      steps.push(`${label} → ${summary}`);
    },

    signal,
  };

  const history: ChatMessage[] = [{ role: "user", content: opts.task }];

  let outcome: SessionResult["outcome"];
  let roundsUsed = 0;
  let hadSideEffects = false;

  try {
    const result = await runAgentSession(history, config);
    roundsUsed = result.roundsUsed;
    hadSideEffects = result.hadSideEffects;
    outcome = result.wasAborted ? "aborted" : result.hitRoundLimit ? "hit_round_limit" : "completed";

    // Zero side effects on a run whose whole point IS mutation (scheduler /
    // task-queue) means the task didn't actually happen, however calmly the
    // model reports "done" — e.g. it called get_current_datetime, saw the
    // answer, and just said "appended to notes.md" in text without ever
    // calling write_file. There's no chat UI here for anyone to read that
    // text, so a text-only "answer" IS a failure for this class of run. A
    // denied tool call (e.g. reaching for run_command, never auto-approved
    // unattended) is the same failure shape regardless of opts.expectSideEffects.
    // Subagents are NOT covered (expectSideEffects unset) — a subagent's job
    // can legitimately be read-only, with its transcript as the real answer.
    if (outcome === "completed" && !hadSideEffects && (result.hadDeniedToolCalls || opts.expectSideEffects)) {
      outcome = "error";
      const reason = result.hadDeniedToolCalls
        ? "A required tool call was denied (not on the unattended allowlist — e.g. run_command)"
        : "The model finished without making any file/workspace change";
      const modelSaid = transcript.trim() ? ` The model said: "${transcript.trim().slice(0, 300)}"` : "";
      const note = `${reason}, so this task did not actually complete.${modelSaid}`;
      steps.push(note);
      transcript = note;
    }
  } catch (err) {
    outcome = "error";
    const message = (err as Error).message ?? String(err);
    steps.push(`error → ${message}`);
    if (!transcript) transcript = `Error: ${message}`;
  }

  const finishedAt = Date.now();
  const summary = transcript.trim().length > 0
    ? transcript.trim().slice(0, 500)
    : steps.length > 0
      ? steps[steps.length - 1].slice(0, 500)
      : "(no output)";

  const record: SessionResult = {
    id,
    origin,
    task: opts.task,
    startedAt,
    finishedAt,
    outcome,
    summary,
    // Keep the real answer on the record, not just the 500-char label. Callers
    // that report a result to a human (the IPC/Telegram relay, the quick-invoke
    // widget) need this; without it the transcript died here and only survived
    // inside the FTS index, which is searchable but not addressable by id.
    fullText: transcript.trim().slice(0, 8000) || undefined,
    steps,
    roundsUsed,
    hadSideEffects,
  };

  useSessionResultsStore.getState().addResult(record);

  // Fire-and-forget: makes this run's full transcript (not just the 500-char
  // summary above) searchable via search_past_sessions / the search overlay.
  // Must never throw into the run — indexSession already swallows its own errors.
  void indexSession({ id, origin, task: opts.task, transcript, outcome, createdAt: finishedAt });

  return { record, transcript, steps };
}
