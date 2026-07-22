import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AppView } from "../types/app";

export interface QueuedTask {
  id: string;
  targetView: AppView;
  task: string;
  sourceView: AppView;
  createdAt: number;
  status: "pending" | "in_progress" | "running" | "done" | "error";
  /** SessionResult.id in useSessionResultsStore once the task has been run headlessly. */
  resultId?: string;
  /**
   * Opaque id from whoever submitted this task from outside the app — today
   * the local IPC listener's `GET /task/{id}` handle (src-tauri/src/ipc.rs).
   *
   * It lives ON the persisted task rather than in a module-level Map because
   * the queue survives a webview reload and module state does not: a reload
   * (Vite re-optimizing deps, a crash, the user hitting refresh) would orphan
   * every in-flight external task, leaving its submitter polling "queued"
   * forever while the task actually ran to completion.
   */
  externalId?: string;
  /**
   * Whether this task is expected to CHANGE something (write a file, run a
   * command) versus just answer a question.
   *
   * The runner passes this to the headless runtime, which forces
   * `outcome: "error"` when a run that expected side effects produced none —
   * a guard against the model narrating "I've updated the file" without ever
   * calling write_file. That's right for `send_task_to_tab`, where a human
   * queued work to be done.
   *
   * It is wrong for conversational senders. A task arriving over IPC from the
   * Telegram relay is usually a QUESTION ("what's in my README?"), and
   * answering it correctly touches nothing — which the guard would report as a
   * failure. Undefined keeps the historical `true`, so existing callers are
   * unchanged; the IPC path sets it explicitly.
   */
  expectSideEffects?: boolean;
  startedAt?: number;
  finishedAt?: number;
}

interface TaskQueueState {
  tasks: QueuedTask[];
  /**
   * Why the runner last declined to start a pending task, or null when it's
   * free to run. Surfaced in QueuedTaskBanner so a task that sits "waiting to
   * run" explains itself instead of spinning forever with no reason — the
   * runner's two bail-out paths (no workspace, generation in flight) used to
   * be completely silent, which made a stalled queue undiagnosable without a
   * debugger. Deliberately NOT persisted (see partialize): a reason restored
   * from a previous session would describe a state that no longer exists.
   */
  deferReason: string | null;
  setDeferReason: (reason: string | null) => void;
  enqueue: (
    targetView: AppView,
    task: string,
    sourceView: AppView,
    externalId?: string,
    expectSideEffects?: boolean,
  ) => string;
  setStatus: (id: string, status: QueuedTask["status"]) => void;
  setResult: (id: string, resultId: string) => void;
  remove: (id: string) => void;
}

export const useTaskQueueStore = create<TaskQueueState>()(
  persist(
    (set) => ({
      tasks: [],
      enqueue: (targetView, task, sourceView, externalId, expectSideEffects) => {
        const id = crypto.randomUUID();
        set((s) => ({
          tasks: [
            ...s.tasks,
            {
              id,
              targetView,
              task,
              sourceView,
              createdAt: Date.now(),
              status: "pending",
              externalId,
              expectSideEffects,
            },
          ],
        }));
        return id;
      },
      setStatus: (id, status) =>
        set((s) => ({
          tasks: s.tasks.map((t) =>
            t.id === id
              ? {
                  ...t,
                  status,
                  ...(status === "running" ? { startedAt: Date.now() } : {}),
                  ...(status === "done" || status === "error" ? { finishedAt: Date.now() } : {}),
                }
              : t
          ),
        })),
      setResult: (id, resultId) =>
        set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, resultId } : t)) })),
      remove: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
      deferReason: null,
      setDeferReason: (reason) => set({ deferReason: reason }),
    }),
    {
      name: "localmind-task-queue",
      // Only `tasks` is durable. deferReason describes a live runtime
      // condition; restoring last session's copy would show a stale
      // explanation for a queue that may now be perfectly healthy.
      partialize: (s) => ({ tasks: s.tasks }) as TaskQueueState,
      // All new fields are optional and status is a superset of the old union, so
      // older persisted tasks are already compatible — this passthrough migrate
      // just accepts them (without it, Zustand discards v0 state on the v1 bump
      // and logs "couldn't be migrated since no migrate function was provided").
      version: 1,
      migrate: (persisted) => persisted as TaskQueueState,
    }
  )
);
