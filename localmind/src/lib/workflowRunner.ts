import type { ToolDef } from "./tools";
import type { Workflow } from "../store/workflows";
import { useWorkflowStore } from "../store/workflows";
import { useMcpStore } from "../store/mcp";
import { reconnectMcpServer } from "./mcpAutoConnect";
import { runHeadlessTask } from "./headlessRunner";
import type { HeadlessTaskRunResult } from "./headlessRunner";
import { SAFE_SCHED_ALLOWLIST } from "./scheduler";
import { useAgentStore } from "../store/agent";
import { useModelSelectionStore } from "../store/modelSelection";
import { useModelStore } from "../store/models";
import { useSettingsStore } from "../store/settings";

/**
 * Composes and runs a Workflow (src/store/workflows.ts) via the same headless
 * runtime the scheduler and task queue already use. This is the single place
 * that turns a saved Workflow into an actual agent run — the save_workflow /
 * run_workflow tools (src/lib/tools.ts), the scheduler's job-due handler, and
 * the Workflows dashboard's "Run now" button all call runWorkflow here rather
 * than duplicating this composition.
 */

/** How long to wait for an opted-in MCP server to (re)connect before giving up
 *  and running without it. Covers the race where a scheduled workflow fires
 *  within seconds of app launch, before mcpAutoConnect.initMcpAutoConnect()'s
 *  parallel reconnects have resolved — long enough for a typical stdio/SSE
 *  handshake, short enough not to meaningfully delay the run. */
const MCP_RECONNECT_WAIT_MS = 9000;

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
 * Resolves a workflow's opted-in MCP server ids into actual ToolDefs, waiting
 * briefly for any that aren't connected yet to reconnect. Never throws —
 * a server that stays unavailable is folded into `unavailableNote` instead,
 * so the run proceeds and the model is told explicitly not to fabricate
 * results using a tool it doesn't actually have this time.
 */
async function resolveMcpTools(workflow: Workflow): Promise<{ tools: ToolDef[]; unavailableNote: string }> {
  if (workflow.mcpServerIds.length === 0) return { tools: [], unavailableNote: "" };

  const tools: ToolDef[] = [];
  const unavailable: string[] = [];

  for (const serverId of workflow.mcpServerIds) {
    let server = useMcpStore.getState().servers.find((s) => s.id === serverId);
    if (!server) {
      unavailable.push(serverId);
      continue;
    }
    if (server.status !== "connected") {
      await Promise.race([
        reconnectMcpServer(serverId).catch(() => false),
        new Promise((resolve) => setTimeout(resolve, MCP_RECONNECT_WAIT_MS)),
      ]);
      server = useMcpStore.getState().servers.find((s) => s.id === serverId);
    }
    if (server && server.status === "connected") {
      tools.push(...server.tools);
    } else {
      unavailable.push(server?.label ?? serverId);
    }
  }

  const unavailableNote =
    unavailable.length > 0
      ? `\n\nNote: the following MCP server(s) this workflow depends on are not connected this run: ${unavailable.join(", ")}. Do not fabricate results using them — proceed with whatever other tools you have, and mention in your summary that they were unavailable.`
      : "";

  return { tools, unavailableNote };
}

export interface RunWorkflowOpts {
  origin: string;
}

export async function runWorkflow(workflow: Workflow, opts: RunWorkflowOpts): Promise<HeadlessTaskRunResult> {
  const workspacePath = useAgentStore.getState().workspacePath;
  if (!workspacePath) throw new Error("This workflow requires an open workspace — ask the user to open a folder first.");

  const { tools: extraTools, unavailableNote } = await resolveMcpTools(workflow);

  const task = `${workflow.instruction}\n\nBefore adding anything new, read ${workflow.outputFile} if it exists (use read_file) and skim its existing entries so you do not add a duplicate of something already recorded. Then use write_file or patch_file to save your findings back to exactly that path, in a consistent structured format (e.g. one Markdown list item or table row per entry), appending only genuinely new items to what's already there.${unavailableNote}`;

  const effectiveAllowlist = Array.from(
    new Set([...SAFE_SCHED_ALLOWLIST, ...workflow.toolAllowlist, ...extraTools.map((t) => t.name)]),
  );

  const modelRef = useModelSelectionStore.getState().selectedModel;
  const hardware = useModelStore.getState().hardware;
  const numCtxOverride = useSettingsStore.getState().numCtxOverride;

  const result = await runHeadlessTask({
    workspacePath,
    modelRef,
    task,
    hardware,
    numCtxOverride,
    currentView: "chat",
    origin: opts.origin,
    agentBuildMode: true,
    toolAllowlist: effectiveAllowlist,
    extraTools,
    expectSideEffects: true,
    workflowId: workflow.id,
  });

  useWorkflowStore.getState().recordRun(workflow.id, result.record.outcome, Date.now());

  return result;
}

/** Cancels the workflow's scheduled job (if any) and removes the workflow record.
 *  Deliberately never touches outputFile on disk — the user's accumulated data
 *  is theirs regardless of whether the workflow that produced it still exists. */
export async function deleteWorkflow(id: string): Promise<void> {
  const workflow = useWorkflowStore.getState().workflows.find((w) => w.id === id);
  if (workflow?.jobId) {
    try {
      await tauriInvoke("jobs_cancel", { id: workflow.jobId });
    } catch {
      // Job already gone, or not in Tauri desktop mode — proceed with removing
      // the workflow record regardless; there's nothing left to reconcile.
    }
  }
  useWorkflowStore.getState().removeWorkflow(id);
}
