import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SessionResult } from "./sessionResults";

/**
 * A named, reusable automation the agent creates via the save_workflow tool
 * (see src/lib/tools.ts) after a chat conversation nails down the specifics —
 * there is deliberately no standalone "New Workflow" form (see the plan this
 * feature was built from). Execution is composed by src/lib/workflowRunner.ts,
 * which reuses the same headless/unattended runtime the scheduler and task
 * queue already use (src/lib/headlessRunner.ts).
 */
export interface Workflow {
  id: string;
  name: string;
  description: string;
  /** The natural-language goal, as given to the headless run each time. */
  instruction: string;
  /** Extra built-in tool names auto-approved beyond the scheduler's SAFE_SCHED_ALLOWLIST baseline. */
  toolAllowlist: string[];
  /** McpServer.id values (src/store/mcp.ts) this workflow may use unattended. Empty by default. */
  mcpServerIds: string[];
  /** Workspace-relative path this workflow reads/writes each run, e.g. ".localmind/workflows/<slug>/output.md". */
  outputFile: string;
  /** Canonical schedule string (scheduler.ts's normalizeSchedule format), or null = manual-only. */
  schedule: string | null;
  /** The corresponding Rust `jobs` table row id, when schedule is set. */
  jobId: string | null;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  lastRunOutcome: SessionResult["outcome"] | null;
  runCount: number;
}

interface WorkflowState {
  workflows: Workflow[];
  addWorkflow: (w: Workflow) => void;
  updateWorkflow: (id: string, patch: Partial<Workflow>) => void;
  removeWorkflow: (id: string) => void;
  recordRun: (id: string, outcome: SessionResult["outcome"], at: number) => void;
}

export const useWorkflowStore = create<WorkflowState>()(
  persist(
    (set) => ({
      workflows: [],
      addWorkflow: (w) => set((s) => ({ workflows: [...s.workflows, w] })),
      updateWorkflow: (id, patch) =>
        set((s) => ({
          workflows: s.workflows.map((w) => (w.id === id ? { ...w, ...patch, updatedAt: Date.now() } : w)),
        })),
      removeWorkflow: (id) => set((s) => ({ workflows: s.workflows.filter((w) => w.id !== id) })),
      recordRun: (id, outcome, at) =>
        set((s) => ({
          workflows: s.workflows.map((w) =>
            w.id === id
              ? { ...w, lastRunAt: at, lastRunOutcome: outcome, runCount: w.runCount + 1, updatedAt: Date.now() }
              : w,
          ),
        })),
    }),
    { name: "localmind-workflows" },
  ),
);
