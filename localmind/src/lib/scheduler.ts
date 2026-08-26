import { toast } from "sonner";
import { listen } from "@tauri-apps/api/event";
import { useAgentStore } from "../store/agent";
import { useModelSelectionStore } from "../store/modelSelection";
import { useModelStore } from "../store/models";
import { useSettingsStore } from "../store/settings";
import { useSessionResultsStore } from "../store/sessionResults";
import type { SessionResult } from "../store/sessionResults";
import { runHeadlessTask } from "./headlessRunner";
import { runWorkflow } from "./workflowRunner";
import { useWorkflowStore } from "../store/workflows";
import { notifyOs } from "./osNotify";
import { isGenerationBusy } from "./generationGate";
import { isTauriEnv } from "./fileSystem";
import { getUnattendedBrowserTools } from "../store/mcp";

// ─── WP2.2: background cron scheduler (frontend half) ──────────────────────
//
// AD-6: the TICK lives in Rust (src-tauri/src/lib.rs: spawn_scheduler /
// run_scheduler_tick) — it just queries the SQLite `jobs` table every 30s and
// emits a `job-due` Tauri event per due job. Actual agent EXECUTION happens
// here, in TS, via the same headless runtime the task queue (WP2.1) uses —
// so scheduled jobs get the exact same tool/approval semantics as everything
// else, no separate "trusted" execution path to audit.
//
// `spec` (as produced by buildJobSpec / the schedule_task tool in tools.ts)
// is a JSON string: `{ "task": string, "schedule": string }` where schedule
// is one of:
//   - "interval:<seconds>"   e.g. "interval:120" — every 2 minutes
//   - "cron:<5-field-expr>"  e.g. "cron:0 8 * * *" — every day at 8am
//   - "once:<unix_seconds>"  e.g. "once:1751500000" — a single future run
//
// All `next_run_at` values stored in the jobs table are milliseconds since
// epoch (matching Rust's db::now_ms() and JS Date.now()) — see the doc
// comment above spawn_scheduler in lib.rs for the full contract.

export interface JobSpec {
  task: string;
  schedule: string;
  /** Workflow.id (src/store/workflows.ts), when this job was created by
   *  save_workflow rather than the raw schedule_task tool. When present,
   *  handleJobDue runs the live workflow (its own tool allowlist/MCP opt-ins/
   *  output file) instead of the raw task text below. */
  workflowId?: string;
}

/** Row shape emitted by the Rust `job-due` event (mirrors db::JobRow). */
export interface JobDuePayload {
  id: string;
  spec: string;
  next_run_at: number;
  status: string;
  created_at: number;
}

/**
 * Tools auto-approved for unattended scheduled runs — deliberately identical
 * in spirit to taskRunner.ts's SAFE_QUEUE_ALLOWLIST (WP2.1): reads + file
 * writes are fine unattended, but run_command / install_deps / delete_file /
 * git_add / git_commit (and all app/ui tools, already stripped from the
 * headless toolset — see headlessRunner.ts's HEADLESS_EXCLUDED_TOOLS) are
 * NOT auto-approved. A scheduled job fires with nobody watching by
 * definition, so destructive or shell-executing tools must never run without
 * a human present to approve that specific call — anything requiring
 * approval outside this list is auto-DENIED by runHeadlessTask, not skipped.
 */
export const SAFE_SCHED_ALLOWLIST: string[] = [
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
  "todo_write",
  // Read-only history scan (Phase 1 of the self-improvement roadmap) — safe
  // to run unattended since it only searches past session transcripts and
  // never mutates anything itself.
  "find_recurring_issues",
  // update_project_memory / save_global_memory / save_skill are deliberately
  // NOT allowlisted: unattended runs must not write to the assistant's
  // long-term knowledge. A scheduled run was observed hijacked into
  // save_skill("Create game.py") by stale context — and background jobs
  // polluting memory/skills is never what a scheduled instruction means.
  "write_file",
  "patch_file",
  "apply_patch",
  "create_folder",
];

/** Build the opaque `spec` JSON string stored in the jobs table. */
export function buildJobSpec(task: string, schedule: string, workflowId?: string): string {
  const spec: JobSpec = workflowId ? { task, schedule, workflowId } : { task, schedule };
  return JSON.stringify(spec);
}

/** Parse a job's `spec` JSON string back into { task, schedule, workflowId? }. Returns null on malformed JSON. */
export function parseJobSpec(spec: string): JobSpec | null {
  try {
    const parsed = JSON.parse(spec) as Partial<JobSpec>;
    if (typeof parsed.task !== "string" || typeof parsed.schedule !== "string") return null;
    return {
      task: parsed.task,
      schedule: parsed.schedule,
      ...(typeof parsed.workflowId === "string" ? { workflowId: parsed.workflowId } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Human-readable description of a schedule descriptor, for UI display
 * (AppSettings.tsx job list) and toasts.
 */
/**
 * Coerce the many ways a model expresses a schedule into the canonical
 * `interval:<secs>` / `cron:<expr>` / `once:<unix_secs>` format. Accepts bare
 * seconds ("120"), durations ("2m", "2 minutes", "1h", "30s"), "every 2
 * minutes", and 5–6 field cron expressions. Returns the input unchanged if it's
 * already canonical or unrecognized (the Rust tick treats unknowns as cron).
 */
export function normalizeSchedule(raw: string): string {
  const s = raw.trim();
  if (/^(interval|cron|once):/i.test(s)) {
    return /^cron:/i.test(s) ? `cron:${s.slice(5).trim()}` : s.toLowerCase();
  }
  if (/^\d+$/.test(s)) return `interval:${s}`;
  const unitSecs = (u: string): number => {
    const c = u[0].toLowerCase();
    return c === "s" ? 1 : c === "m" ? 60 : c === "h" ? 3600 : 86400;
  };
  const dur = /^(?:every\s+)?(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)$/i.exec(s);
  if (dur) return `interval:${parseInt(dur[1], 10) * unitSecs(dur[2])}`;
  // A bare cron-looking expression (5 or 6 space-separated cron fields).
  if (/^[\d*/,\-\s]+$/.test(s) && s.split(/\s+/).length >= 5) return `cron:${s}`;
  return s;
}

export function describeSchedule(schedule: string): string {
  const intervalMatch = /^interval:(\d+)$/.exec(schedule);
  if (intervalMatch) {
    const secs = parseInt(intervalMatch[1], 10);
    if (secs % 3600 === 0 && secs > 0) return `every ${secs / 3600}h`;
    if (secs % 60 === 0 && secs > 0) return `every ${secs / 60}m`;
    return `every ${secs}s`;
  }
  const cronMatch = /^cron:(.+)$/.exec(schedule);
  if (cronMatch) return `cron "${cronMatch[1].trim()}"`;
  const onceMatch = /^once:(\d+)$/.exec(schedule);
  if (onceMatch) {
    const ms = parseInt(onceMatch[1], 10) * 1000;
    return `once at ${new Date(ms).toLocaleString()}`;
  }
  return schedule;
}

/**
 * Compute the initial `next_run_at` (ms since epoch) for a freshly scheduled
 * job — used by tools.ts's schedule_task tool. The Rust tick recomputes
 * next_run_at itself after each fire, so this only matters for the very
 * first run.
 */
export function computeInitialNextRun(schedule: string, nowMs: number = Date.now()): number {
  const intervalMatch = /^interval:(\d+)$/.exec(schedule);
  if (intervalMatch) {
    const secs = parseInt(intervalMatch[1], 10);
    return nowMs + Math.max(1, secs) * 1000;
  }
  const onceMatch = /^once:(\d+)$/.exec(schedule);
  if (onceMatch) {
    return parseInt(onceMatch[1], 10) * 1000;
  }
  // cron (or anything unrecognized): just set it to "now" — the Rust tick
  // will see it as due on its very next 30s pass and compute the real next
  // occurrence via the `cron` crate at that point.
  return nowMs;
}

async function recordSkippedNoWorkspace(task: string): Promise<void> {
  const record: SessionResult = {
    id: crypto.randomUUID(),
    origin: "scheduler",
    task,
    startedAt: Date.now(),
    finishedAt: Date.now(),
    outcome: "error",
    summary: "Skipped — no workspace is open. Open a workspace folder so scheduled jobs have somewhere to run.",
    steps: [],
    roundsUsed: 0,
    hadSideEffects: false,
  };
  useSessionResultsStore.getState().addResult(record);
}

/** Mirrors recordSkippedNoWorkspace's pattern for the busy-gate deferral case. */
async function recordSkippedBusy(task: string): Promise<void> {
  const record: SessionResult = {
    id: crypto.randomUUID(),
    origin: "scheduler",
    task,
    startedAt: Date.now(),
    finishedAt: Date.now(),
    outcome: "error",
    summary: "Deferred — model busy with another generation; will run at the next scheduled fire.",
    steps: [],
    roundsUsed: 0,
    hadSideEffects: false,
  };
  useSessionResultsStore.getState().addResult(record);
}

function jobLabel(task: string): string {
  return task.slice(0, 40) + (task.length > 40 ? "…" : "");
}

/** Handles a single `job-due` event: parse spec, run headlessly, toast the outcome. */
async function handleJobDue(job: JobDuePayload): Promise<void> {
  const parsed = parseJobSpec(job.spec);
  if (!parsed) {
    console.error(`[scheduler] job ${job.id} has an unparseable spec:`, job.spec);
    return;
  }

  // Never compete with an in-flight generation (interactive chat, another
  // headless run, etc.) — a 16GB card thrashes VRAM under two concurrent
  // generations plus the embed model. The Rust tick already advanced
  // next_run_at, so simply not running here means this job just fires again
  // at its next scheduled interval — no rescheduling needed on our end.
  if (isGenerationBusy()) {
    await recordSkippedBusy(parsed.task);
    toast.info(`Scheduled task deferred: ${jobLabel(parsed.task)}`, {
      description: "Model busy with another generation; will run at the next scheduled fire.",
    });
    return;
  }

  const workspacePath = useAgentStore.getState().workspacePath;
  if (!workspacePath) {
    await recordSkippedNoWorkspace(parsed.task);
    toast.error(`Scheduled task skipped: ${jobLabel(parsed.task)}`, {
      description: "No workspace is open.",
    });
    return;
  }

  const label = jobLabel(parsed.task);
  try {
    // Jobs created by save_workflow (src/lib/tools.ts) carry a workflowId —
    // route those through runWorkflow so the run gets that workflow's own
    // tool allowlist, opted-in MCP servers, and output-file dedup
    // instructions, instead of the bare SAFE_SCHED_ALLOWLIST path below. A
    // workflowId present but no longer resolving to a workflow (deleted
    // without its job row being cleaned up) falls back to the raw path, with
    // the summary tagged so it reads as "orphaned job", not a normal-but-poor
    // run, in the Logs tab.
    const workflow = parsed.workflowId
      ? useWorkflowStore.getState().workflows.find((w) => w.id === parsed.workflowId)
      : undefined;
    if (parsed.workflowId && !workflow) {
      console.error(`[scheduler] job ${job.id} references missing workflow ${parsed.workflowId} — falling back to raw task text`);
    }

    const modelRef = useModelSelectionStore.getState().selectedModel;
    const hardware = useModelStore.getState().hardware;
    const numCtxOverride = useSettingsStore.getState().numCtxOverride;
    // Browser MCP tools are the one MCP server trusted for unattended runs —
    // see getUnattendedBrowserTools's doc comment. Only applies to the raw
    // (non-workflow) path below — a workflow already has its own opted-in
    // extraTools/toolAllowlist mechanism via runWorkflow.
    const browserTools = getUnattendedBrowserTools();

    const runOnce = () =>
      workflow
        ? runWorkflow(workflow, { origin: "scheduler" })
        : runHeadlessTask({
            workspacePath,
            modelRef,
            task: parsed.workflowId
              ? `[workflow record missing — ran raw task text] ${parsed.task}`
              : parsed.task,
            hardware,
            numCtxOverride,
            currentView: "chat",
            origin: "scheduler",
            agentBuildMode: true,
            toolAllowlist: [...SAFE_SCHED_ALLOWLIST, ...browserTools.map((t) => t.name)],
            extraTools: browserTools,
            expectSideEffects: true,
          });

    // Small local models are stochastic on these runs (harness-measured:
    // qwen2.5:7b occasionally returns an empty response and stops, ~60-100%
    // single-attempt success). A failed unattended attempt has no user-facing
    // cost, so retry once with a fresh session before reporting failure —
    // two independent attempts push per-fire success to ~90%+ while the
    // honest error toast still catches a double failure.
    //
    // Before retrying, wait ~4s (a wedged Ollama connection needs a moment to
    // either recover or get restarted by the watchdog) and re-check the busy
    // gate — retrying immediately into a still-busy/still-wedged server is
    // exactly the doubled load that causes instability in the first place.
    let { record } = await runOnce();
    if (record.outcome === "error") {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      if (!isGenerationBusy()) {
        ({ record } = await runOnce());
      }
    }

    // OS-level notification too: with close-to-tray the window (and its
    // sonner toasts) may be hidden — the desktop toast is the only signal.
    if (record.outcome === "error") {
      toast.error(`Scheduled task failed: ${label}`, { description: record.summary.slice(0, 150) });
      void notifyOs(`Scheduled task failed: ${label}`, record.summary.slice(0, 150));
    } else {
      // Surface what the run actually found/did, not just that it finished —
      // an unattended run's whole value is telling the user something they'd
      // otherwise have to go check for themselves.
      toast.success(`Scheduled task done: ${label}`, { description: record.summary.slice(0, 150) });
      void notifyOs(`Scheduled task done: ${label}`, record.summary.slice(0, 150));
    }
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    toast.error(`Scheduled task failed: ${label}`, { description: message });
    void notifyOs(`Scheduled task failed: ${label}`, message);
  }
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__;
  if (!tauri) throw new Error("Not in Tauri desktop mode — launch with npm run tauri dev");
  const core = (tauri as Record<string, unknown>).core as {
    invoke?: (cmd: string, args?: unknown) => Promise<T>;
  };
  if (typeof core?.invoke !== "function") throw new Error("Tauri core.invoke unavailable");
  return core.invoke(cmd, args);
}

/**
 * The daily self-improvement / proactive-notice job's instruction (Phase 1 +
 * Phase 8 of the self-improvement roadmap). Runs under SAFE_SCHED_ALLOWLIST
 * like any other scheduled job — read-only plus notify_user, nothing that
 * mutates the project without a human reviewing a propose_feature spec first.
 */
const SELF_IMPROVEMENT_TASK =
  "Run today's self-improvement and proactive-notice pass. Do BOTH of the following:\n" +
  "1. Call find_recurring_issues to check whether any failure pattern has recurred across recent sessions. If something concrete and fixable turns up, use propose_feature to draft a fix (fill in 'diff' with the exact before/after wording if it's a prompt/tool-description change) — otherwise say so and move on, that's a normal outcome.\n" +
  "2. Separately, look for anything worth telling the user about RIGHT NOW, unprompted — e.g. call list_workflows and read_file on any workflow output file that changed since you last looked, and notice things like a new noteworthy entry, a workflow that's failed several runs in a row, or an approaching deadline visible in the data. Only if you find something genuinely specific and worth interrupting the user for, call notify_user with a concise message. If nothing stands out, do NOT call notify_user — staying silent is the correct, expected result on most days. Never fabricate a finding just to have something to report.";

/**
 * Inserts the default daily self-improvement + proactive-notice job — once
 * per install. Callers (App.tsx) are responsible for only calling this when
 * `selfImprovementJobSeeded` is still false and marking it true right after,
 * since this function itself has no dedupe check and would otherwise insert
 * a duplicate job on every launch.
 */
export async function seedSelfImprovementJob(): Promise<void> {
  const schedule = "cron:0 9 * * *"; // once daily, 9am local time
  const id = crypto.randomUUID();
  const spec = buildJobSpec(SELF_IMPROVEMENT_TASK, schedule);
  const nextRunAt = computeInitialNextRun(schedule);
  await tauriInvoke("jobs_insert", { id, spec, nextRunAt, status: "active" });
}

/** Idempotence guard — initScheduler() may be called more than once safely. */
let started = false;

/**
 * Boots the scheduler event listener. Call once near app mount (see the
 * mount line documented in this work package's report — App.tsx is owned by
 * a parallel work package, so this file cannot self-mount into it).
 *
 * Listens for the Rust-emitted `job-due` event and, for each one, resolves
 * the job's spec and drives a full headless agent run via runHeadlessTask
 * (the same primitive the task queue and subagents use), gated by
 * SAFE_SCHED_ALLOWLIST so unattended firing never auto-approves destructive
 * or shell-executing tools.
 */
export function initScheduler(): void {
  // Browser dev mode (`npm run dev`, no Tauri bridge) has no window.__TAURI__/
  // __TAURI_INTERNALS__ — listen() would reject with "Cannot read properties
  // of undefined (reading 'transformCallback')". Left unguarded and
  // unhandled, that rejection reaches main.tsx's global unhandledrejection
  // handler, which wipes #root with a red error screen — the exact same
  // hazard the rest of this file's Tauri-boundary calls already guard
  // against (see startIpcResultReporter's doc comment in App.tsx), just
  // missed here since this call happens at mount rather than on demand.
  if (started || !isTauriEnv()) return;
  started = true;

  void listen<JobDuePayload>("job-due", (event) => {
    void handleJobDue(event.payload);
  }).catch((err) => {
    console.error("[scheduler] job-due listener failed:", err);
  });
}
