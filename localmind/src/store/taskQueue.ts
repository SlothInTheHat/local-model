import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AppView } from "../types/app";

export interface QueuedTask {
  id: string;
  targetView: AppView;
  task: string;
  sourceView: AppView;
  createdAt: number;
  status: "pending" | "in_progress" | "done";
}

interface TaskQueueState {
  tasks: QueuedTask[];
  enqueue: (targetView: AppView, task: string, sourceView: AppView) => string;
  setStatus: (id: string, status: QueuedTask["status"]) => void;
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
        set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, status } : t)) })),
      remove: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
    }),
    { name: "localmind-task-queue" }
  )
);
