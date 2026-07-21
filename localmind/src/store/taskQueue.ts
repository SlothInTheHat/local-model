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
  startedAt?: number;
  finishedAt?: number;
}

interface TaskQueueState {
  tasks: QueuedTask[];
  enqueue: (targetView: AppView, task: string, sourceView: AppView) => string;
  setStatus: (id: string, status: QueuedTask["status"]) => void;
  setResult: (id: string, resultId: string) => void;
  remove: (id: string) => void;
}

export const useTaskQueueStore = create<TaskQueueState>()(
  persist(
    (set) => ({
      tasks: [],
      enqueue: (targetView, task, sourceView) => {
        const id = crypto.randomUUID();
        set((s) => ({
          tasks: [...s.tasks, { id, targetView, task, sourceView, createdAt: Date.now(), status: "pending" }],
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
    }),
    {
      name: "localmind-task-queue",
      // All new fields are optional and status is a superset of the old union, so
      // older persisted tasks are already compatible — this passthrough migrate
      // just accepts them (without it, Zustand discards v0 state on the v1 bump
      // and logs "couldn't be migrated since no migrate function was provided").
      version: 1,
      migrate: (persisted) => persisted as TaskQueueState,
    }
  )
);
