import { toast } from "sonner";
import { useTaskQueueStore } from "../store/taskQueue";
import type { QueuedTask } from "../store/taskQueue";
import { useAgentStore } from "../store/agent";
import { useModelSelectionStore } from "../store/modelSelection";
import { useModelStore } from "../store/models";
import { useSettingsStore } from "../store/settings";
import { runHeadlessTask } from "./headlessRunner";
import { notifyOs } from "./osNotify";
import { isGenerationBusy, generationGateState } from "./generationGate";

/**
 * Tools auto-approved for unattended task-queue runs.
 *
 * Deliberately EXCLUDES run_command, install_deps, delete_file, git_add,
 * git_commit — and all app/ui tools (switch_view, switch_model,
 * send_task_to_tab, register_tool are already stripped from the headless
 * toolset entirely, see headlessRunner.ts's HEADLESS_EXCLUDED_TOOLS).
 *
 * Rationale: a task sitting in the queue was queued by a human who is, by
 * definition, not watching it run. It can read the workspace and create/edit
 * files (write_file, patch_file, apply_patch, create_folder) unattended, but
 * it must never execute shell commands, install dependencies, delete files,
 * or commit to git without a human present to approve that specific call.
 * Anything requiring approval that isn't in this list is auto-DENIED by
 * runHeadlessTask, not skipped — the agent sees the denial and can route
 * around it (e.g. explain in its summary that it couldn't run tests).
 */
export const SAFE_QUEUE_ALLOWLIST: string[] = [
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
  // update_project_memory / save_global_memory / save_skill deliberately NOT
  // allowlisted — unattended runs must not write to the assistant's long-term
  // knowledge (see the matching note in scheduler.ts SAFE_SCHED_ALLOWLIST).
  "write_file",
  "patch_file",
  "apply_patch",
  "create_folder",
];

/** Module-level concurrency-1 guard — only one task runs at a time. */
let isRunning = false;
/** When the in-flight run started, so a leaked `isRunning` is reportable
 *  rather than an invisible permanent block. Null whenever idle. */
let runStartedAt: number | null = null;

/**
 * Publish why the runner declined to start a task — but ONLY when the message
 * actually changed.
 *
 * Belt-and-braces against the feedback loop described on the store
 * subscription in startTaskRunner: writing to the store from inside the code
 * path that the store's own subscription triggers is inherently circular, so
 * even with the subscription now filtering on `tasks`, this refuses to emit a
 * redundant update.
 */
function publishDeferReason(reason: string | null): void {
  const store = useTaskQueueStore.getState();
  if (store.deferReason === reason) return;
  store.setDeferReason(reason);
}
/** Idempotence guard so startTaskRunner() can be called more than once safely
 * (e.g. React effect re-invocation) without registering duplicate subscriptions. */
let started = false;
/** Guards against stacking up redundant re-poll timers while deferred on the
 * generation gate (see processNextPending's isGenerationBusy check below). */
let busyPollScheduled = false;

function oldestPending(): QueuedTask | undefined {
  return useTaskQueueStore
    .getState()
    .tasks.filter((t) => t.status === "pending")
    .sort((a, b) => a.createdAt - b.createdAt)[0];
}

/**
 * Drains the task queue one task at a time. Safe to call re-entrantly from
 * anywhere (store subscriptions, App mount, manual "Start" clicks) — the
 * isRunning flag makes overlapping calls a no-op, and every successful run
 * recurses at the end to pick up the next pending task, so the queue fully
 * drains from a single external trigger.
 */
export async function processNextPending(): Promise<void> {
  if (isRunning) {
    // THE bail-out that hid the "stuck queue" for hours. `isRunning` is
    // cleared in a `finally`, so it can only stay set if the in-flight run
    // never settles — which happens when a fetch hangs (a wedged Ollama that
    // accepts connections but never responds). Removing the task from the
    // queue via the banner's X does NOT abort the run, so the flag survives
    // that too, and every subsequent task is skipped in complete silence.
    //
    // Deliberately NOT auto-cleared here: force-resetting it while a run is
    // genuinely in flight would let two generations run at once, which is the
    // VRAM thrash the concurrency-1 guard exists to prevent. Instead, report
    // it with elapsed time so a leak is obvious, and rely on the stream stall
    // watchdog (see STREAM_STALL_TIMEOUT_MS in ollama.ts) to make a hung
    // request fail within ~3 minutes so the `finally` actually runs.
    const heldMs = runStartedAt === null ? null : Date.now() - runStartedAt;
    const heldMin = heldMs === null ? null : Math.round(heldMs / 60_000);
    console.info(
      `[taskRunner] deferring: a run is already in flight` +
        (heldMs !== null ? ` (started ${Math.round(heldMs / 1000)}s ago)` : ""),
    );
    publishDeferReason(
      heldMin !== null && heldMin >= 5
        ? `A previous task has been running for ${heldMin} minutes and may be wedged — restart the app if it never finishes.`
        : "Another task is running — this one starts when that finishes.",
    );
    return;
  }

  const task = oldestPending();
  if (!task) return; // nothing to do

  const workspacePath = useAgentStore.getState().workspacePath;
  if (!workspacePath) {
    // Both bail-outs in this function used to return in total silence, which
    // makes "my queued task never ran" unanswerable without a debugger — a
    // task POSTed over IPC sat at "queued" for 10+ minutes and neither the
    // user nor the orchestrator could tell which branch was responsible.
    // These logs cost nothing and turn that into a one-line answer.
    console.info("[taskRunner] deferring: no workspace open. Task:", task.id);
    publishDeferReason("No workspace folder is open — open one and this task will start automatically.");
    // Can't register a confinement root without a workspace. Leave the task
    // pending (no error, no spam) — startTaskRunner's workspacePath
    // subscription re-triggers this once a workspace opens.
    return;
  }

  // Never compete with an in-flight generation (interactive chat, a
  // scheduler-fired job, etc.) — leave the task pending (not "running") and
  // re-poll in 15s so the queue resumes once the model frees up, instead of
  // starting a second generation into an already-loaded 16GB card.
  if (isGenerationBusy()) {
    const gate = generationGateState();
    console.info(
      `[taskRunner] deferring: ${gate.active} generation(s) in flight` +
        (gate.oldestHeldMs !== null ? `, oldest held ${Math.round(gate.oldestHeldMs / 1000)}s` : "") +
        `. Re-polling in 15s. Task: ${task.id}`,
    );
    publishDeferReason(
      `Waiting for the model — ${gate.active} generation${gate.active === 1 ? "" : "s"} in flight` +
        (gate.oldestHeldMs !== null && gate.oldestHeldMs > 60_000
          ? ` (oldest running ${Math.round(gate.oldestHeldMs / 60_000)}m — if nothing is actually generating, this is a stuck gate; restart clears it)`
          : "") +
        ". Retrying every 15s.",
    );
    if (!busyPollScheduled) {
      busyPollScheduled = true;
      setTimeout(() => {
        busyPollScheduled = false;
        void processNextPending();
      }, 15000);
    }
    return;
  }

  isRunning = true;
  runStartedAt = Date.now();
  const { setStatus, setResult } = useTaskQueueStore.getState();
  publishDeferReason(null); // actually starting — clear any stale explanation
  setStatus(task.id, "running");

  try {
    const modelRef = useModelSelectionStore.getState().selectedModel;
    const hardware = useModelStore.getState().hardware;
    const numCtxOverride = useSettingsStore.getState().numCtxOverride;

    const runOnce = () =>
      runHeadlessTask({
        workspacePath,
        modelRef,
        task: task.task,
        hardware,
        numCtxOverride,
        currentView: task.targetView,
        origin: "task-queue",
        agentBuildMode: true,
        toolAllowlist: SAFE_QUEUE_ALLOWLIST,
        expectSideEffects: true,
      });

    // Retry a failed attempt once with a fresh session — small local models
    // are stochastic on unattended runs (see the matching note in
    // scheduler.ts handleJobDue), and a queued task fires with nobody
    // watching to manually re-trigger it.
    //
    // Wait ~4s before retrying (give a wedged Ollama connection a chance to
    // recover, or the watchdog a chance to restart it) and re-check the busy
    // gate — retrying immediately into a still-busy server just doubles the
    // load that likely caused the first failure.
    let { record } = await runOnce();
    if (record.outcome === "error") {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      if (!isGenerationBusy()) {
        ({ record } = await runOnce());
      }
    }

    setResult(task.id, record.id);
    setStatus(task.id, record.outcome === "error" ? "error" : "done");
    const label = task.task.slice(0, 40) + (task.task.length > 40 ? "…" : "");
    // OS-level notification too — the window may be hidden to tray.
    if (record.outcome === "error") {
      toast.error(`Task failed: ${label}`, { description: record.summary.slice(0, 150) });
      void notifyOs(`Task failed: ${label}`, record.summary.slice(0, 150));
    } else {
      toast.success(`Task done: ${label}`);
      void notifyOs(`Task done: ${label}`);
    }
  } catch (err) {
    setStatus(task.id, "error");
    const message = (err as Error)?.message ?? String(err);
    const label = task.task.slice(0, 40) + (task.task.length > 40 ? "…" : "");
    toast.error(`Task failed: ${label}`, { description: message });
  } finally {
    isRunning = false;
    runStartedAt = null;
  }

  // Keep draining — pick up whatever's next (or no-op if the queue is empty).
  void processNextPending();
}

/**
 * Boots the global singleton task-queue runner. Call once near app mount.
 * Idempotent: a second call is a no-op, so it's safe to put in a useEffect
 * with an empty dependency array even under double-invocation.
 *
 * Wires two triggers so queued tasks run unattended with no UI interaction:
 *  - useTaskQueueStore changes (a new task was enqueued, e.g. via
 *    send_task_to_tab) — attempt to drain.
 *  - useAgentStore workspacePath changes (a workspace was opened/switched)
 *    — tasks queued before any workspace was open get a chance to start.
 */
export function startTaskRunner(): void {
  if (started) return;
  started = true;

  // Handle whatever's already pending at boot (e.g. tasks persisted from a
  // previous session with a workspace already open).
  void processNextPending();

  useTaskQueueStore.subscribe((state, prev) => {
    // React to TASK changes only. This used to fire on any store update, which
    // became an infinite loop the moment processNextPending started writing
    // `deferReason` back into this same store: subscribe → processNextPending
    // → setDeferReason → subscribe → … → "Maximum call stack size exceeded"
    // at boot, with the app refusing to start. Anything the runner itself
    // writes here must never be able to re-trigger the runner.
    if (state.tasks === prev.tasks) return;
    void processNextPending();
  });

  let lastWorkspacePath = useAgentStore.getState().workspacePath;
  useAgentStore.subscribe((s) => {
    if (s.workspacePath && s.workspacePath !== lastWorkspacePath) {
      lastWorkspacePath = s.workspacePath;
      void processNextPending();
    }
  });
}
