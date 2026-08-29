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
 * spawn_subagent / spawn_reviewer_subagent are excluded too — this is the
 * recursion guard for WP2.3: a headless session (subagent, task-queue run,
 * or scheduled run) must never be able to spawn its own subagents.
 * Belt-and-suspenders with the approval allowlist: even if a headless
 * session's tool list were ever widened to include them again,
 * HEADLESS_DEFAULT_ALLOWLIST below does not contain either name, so
 * runHeadlessTask's onApprovalNeeded would auto-deny the call.
 *
 * save_global_memory / update_project_memory are excluded because unattended
 * runs must not write to the assistant's long-term knowledge (a scheduled run
 * was observed hijacked by stale context into unrelated knowledge writes) —
 * and being requiresApproval:false they'd otherwise be offered regardless of
 * the allowlist. save_skill needs no entry here: it requires approval and is
 * not allowlisted, so the requiresApproval-or-allowlisted filter drops it.
 */
const HEADLESS_EXCLUDED_TOOLS = new Set(["switch_view", "switch_model", "send_task_to_tab", "register_tool", "spawn_subagent", "spawn_reviewer_subagent", "save_global_memory", "update_project_memory"]);

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
  /** Additional tools offered beyond getHeadlessDefaultTools() — e.g. a Workflow's
   *  opted-in MCP server tools (see workflowRunner.ts). Still subject to the same
   *  toolAllowlist approval gate as everything else. */
  extraTools?: ToolDef[];
  /** The Workflow.id (src/store/workflows.ts) this run belongs to, if any — stamped
   *  onto the resulting SessionResult so the Workflows dashboard can filter run
   *  history per workflow. */
  workflowId?: string;
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
  /**
   * When true, the model only ever sees the tools named in toolAllowlist —
   * not every read-only built-in tool plus the allowlist for
   * approval-requiring ones (today's default; see the `tools:` filter
   * below). Default false preserves that broader default for scheduler/
   * task-queue/subagent callers, which rely on the full read-only surface
   * being available without having to enumerate it. quick-invoke sets this
   * true: QUICK_INVOKE_ALLOWLIST in App.tsx is meant to be the COMPLETE tool
   * surface for that mode (a deliberately small, curated set), not just the
   * approval-requiring subset of a much larger implicit one — without this,
   * quick-invoke was being offered every read-only tool in the app (~50+)
   * as a round candidate, most of them irrelevant to what it's for.
   */
  restrictToolsToAllowlist?: boolean;
  signal?: AbortSignal;
}

/** One step of a model-proposed guided walkthrough — see the
 *  `propose_walkthrough_steps` tool (src/lib/tools.ts) this is captured from. */
export interface WalkthroughStepPlan {
  target: string;
  controlType?: string;
  instruction: string;
}

export interface HeadlessTaskRunResult {
  record: SessionResult;
  transcript: string;
  steps: string[];
  /** Populated only when the model called `propose_walkthrough_steps` this
   *  run (quick-invoke's walkthrough feature) — optional and unused by every
   *  other caller (scheduler/task-queue/subagent/workflow runs). */
  walkthroughSteps?: { windowId: string; steps: WalkthroughStepPlan[] };
  /** Total wall-clock time for this run in ms (finishedAt - startedAt) —
   *  WP7.6 debug timing, so a caller (quick-invoke) can show "how long did
   *  that take" without recomputing it from the SessionResult's own
   *  timestamps itself. */
  durationMs: number;
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
  let walkthroughSteps: HeadlessTaskRunResult["walkthroughSteps"];

  const config: AgentRuntimeConfig = {
    modelRef: opts.modelRef,
    hardware: opts.hardware ?? null,
    numCtxOverride: opts.numCtxOverride ?? null,

    dirHandle: handle,
    workspacePath: opts.workspacePath,
    workspaceName,
    currentView: opts.currentView ?? "chat",
    // Headless origins (scheduler/task-queue/subagent/workflow/manual) aren't
    // real AppViews, so shadow-git commit messages need the actual origin
    // label rather than the "chat" placeholder currentView falls back to.
    surfaceLabel: origin,

    // Only offer tools the model can actually get approved: no-approval tools
    // (read_file, list_directory, …) plus whatever's on this run's allowlist.
    // Advertising e.g. run_command when it will always be auto-denied just
    // wastes a round on a dead-on-arrival call — and previously let a session
    // "complete" having accomplished nothing (see hadDeniedToolCalls below).
    tools: [...getHeadlessDefaultTools(), ...(opts.extraTools ?? [])].filter((t) =>
      opts.restrictToolsToAllowlist ? allowlist.includes(t.name) : !t.requiresApproval || allowlist.includes(t.name),
    ),
    agentBuildMode: opts.agentBuildMode ?? true,
    autoApproveAll: false,
    toolsSupported: true,
    maxRounds: opts.maxRounds ?? DEFAULT_MAX_ROUNDS,
    expectSideEffects: opts.expectSideEffects ?? false,
    // conversational was defined in AgentRuntimeConfig (lightweight system
    // prompt, no todo/plan framing, and — critically — skips the inaction
    // nudge below) but no caller ever set it, so every headless run got
    // nudged toward calling a tool even when the message was a plain
    // question with a correct zero-tool-call answer. Confirmed live: a
    // phone-relayed question got nudged 2x into "you didn't call a tool, do
    // it now," which degenerated the model into a generic canned greeting
    // by the final round — exactly the failure buildConversationalSystemPrompt/
    // shouldNudgeInaction's own doc comments describe this flag as existing
    // to prevent. Only fires for explicit `expectSideEffects: false` (the
    // IPC/Telegram relay's own signal for "this is a question, not a build
    // task") — subagents/manual callers that leave expectSideEffects unset
    // are unaffected, since `undefined === false` is false.
    conversational: opts.expectSideEffects === false,
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
    onToolCallResolved: (call, label, _result, summary) => {
      // [+X.Xs] prefix — WP7.6 debug timing. Each tool-call resolution is a
      // full model round completing (decide-to-call-this-tool included), so
      // the deltas between consecutive steps below approximate per-round
      // latency without needing any deeper hook into agentRuntime.ts's round
      // loop. Elapsed since `startedAt` (Date.now(), already captured above)
      // rather than a running total in the closure — simpler, no separate
      // "last mark" variable to keep in sync.
      const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
      steps.push(`[+${elapsedS}s] ${label} → ${summary}`);
      // Capture the model's already-validated step plan directly off the
      // call args (Ollama's own tool-call JSON-schema validation already
      // shaped this) rather than re-parsing anything out of prose — see
      // propose_walkthrough_steps' doc comment in tools.ts for why this tool
      // exists at all.
      if (call.name === "propose_walkthrough_steps") {
        const windowId = typeof call.args["window_id"] === "string" ? (call.args["window_id"] as string) : "";
        const rawSteps = Array.isArray(call.args["steps"]) ? (call.args["steps"] as unknown[]) : [];
        const parsed: WalkthroughStepPlan[] = rawSteps
          .map((s): WalkthroughStepPlan | null => {
            if (typeof s !== "object" || s === null) return null;
            const rec = s as Record<string, unknown>;
            const target = typeof rec["target"] === "string" ? rec["target"] : "";
            const instruction = typeof rec["instruction"] === "string" ? rec["instruction"] : "";
            if (!target || !instruction) return null;
            const controlType = typeof rec["control_type"] === "string" ? rec["control_type"] : undefined;
            return { target, instruction, controlType };
          })
          .filter((s): s is WalkthroughStepPlan => s !== null);
        if (windowId && parsed.length > 0) {
          walkthroughSteps = { windowId, steps: parsed.slice(0, 15) };
        }
      }
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
    // Marks the end of generation even when zero tool calls happened at all
    // (a plain text-only answer never fires onToolCallResolved) — without
    // this, a run with no tool calls would show an empty [+Xs] trail despite
    // still taking real time to generate.
    steps.push(`[+${((Date.now() - startedAt) / 1000).toFixed(1)}s] done — ${roundsUsed} round${roundsUsed === 1 ? "" : "s"}`);

    // Zero side effects on a run whose whole point IS mutation (scheduler /
    // task-queue) means the task didn't actually happen, however calmly the
    // model reports "done" — e.g. it called get_current_datetime, saw the
    // answer, and just said "appended to notes.md" in text without ever
    // calling write_file. There's no chat UI here for anyone to read that
    // text, so a text-only "answer" IS a failure for this class of run. A
    // denied tool call (e.g. reaching for run_command, never auto-approved
    // unattended) is the same failure shape for that class of run.
    // Subagents are NOT covered (expectSideEffects unset) — a subagent's job
    // can legitimately be read-only, with its transcript as the real answer.
    //
    // opts.expectSideEffects === false (quick-invoke's explicit "this is a
    // question, not a build task" signal — see App.tsx's own comment on it)
    // is EXCLUDED from the hadDeniedToolCalls check too, not just the
    // zero-side-effects one: a plain question answered without touching a
    // file is already a correct outcome for this class of run, and a denied
    // call earlier in the transcript doesn't retroactively invalidate a real
    // answer the model went on to give afterward. Observed live: a weak local
    // model hallucinated a nonexistent `browser__browser_tabs` tool (denied,
    // correctly — see HALLUCINATED_TOOL_FALLBACKS in agentRuntime.ts for the
    // sibling hallucination this file already recovers from silently), then
    // immediately self-corrected and solved the actual on-screen problem —
    // but this branch discarded that whole working answer and reported the
    // task as failed over a wasted call the model had already moved past.
    const deniedCallIsFatal = result.hadDeniedToolCalls && opts.expectSideEffects !== false;
    if (outcome === "completed" && !hadSideEffects && (deniedCallIsFatal || opts.expectSideEffects)) {
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
    workflowId: opts.workflowId,
  };

  useSessionResultsStore.getState().addResult(record);

  // Fire-and-forget: makes this run's full transcript (not just the 500-char
  // summary above) searchable via search_past_sessions / the search overlay.
  // Must never throw into the run — indexSession already swallows its own errors.
  void indexSession({ id, origin, task: opts.task, transcript, outcome, createdAt: finishedAt });

  return { record, transcript, steps, walkthroughSteps, durationMs: finishedAt - startedAt };
}
