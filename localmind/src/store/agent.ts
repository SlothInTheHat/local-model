import { create } from "zustand";
import type { ToolCall, ToolName } from "../lib/tools";

/**
 * Register a workspace root with the Rust confinement layer so the native fs_*
 * commands and run_command are allowed to touch it. Fire-and-forget: failures
 * (browser mode, missing folder) just mean confinement stays as-is and the
 * fs_* commands will refuse access, which surfaces as a clear error to the user.
 */
function registerWorkspaceRoot(path: string): void {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__ as
    | { core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } }
    | undefined;
  const invoke = tauri?.core?.invoke;
  if (typeof invoke !== "function") return; // browser mode — no confinement layer
  void invoke("register_workspace_root", { path }).catch(() => {});
}

interface AgentState {
  dirHandle: FileSystemDirectoryHandle | null;
  workspacePath: string | null;   // real OS path — only set in Tauri mode
  workspaceName: string | null;   // display name (folder name)
  toolsEnabled: Record<ToolName, boolean>;
  pendingToolCalls: ToolCall[];

  setWorkspace: (handle: FileSystemDirectoryHandle | null, path: string | null, name: string | null) => void;
  setToolEnabled: (name: ToolName, enabled: boolean) => void;
  setPendingToolCalls: (calls: ToolCall[]) => void;
  clearPendingToolCalls: () => void;
}

const DEFAULT_TOOLS_ENABLED: Record<ToolName, boolean> = {
  read_file: true,
  write_file: true,
  patch_file: true,
  delete_file: true,
  list_directory: true,
  grep_files: true,
  find_files: true,
  calculator: true,
  web_search: true,
  run_command: false,
  get_system_info: true,
  get_current_datetime: true,
  git_status: false,
  git_diff: false,
  git_log: false,
  git_add: false,
  git_commit: false,
  install_deps: true,
  todo_write: true,
  apply_patch: true,
  web_fetch: true,
  create_folder: true,
  register_tool: true,
  switch_model: true,
  switch_view: true,
  send_task_to_tab: true,
  transcribe_video: true,
  schedule_task: true,
  list_scheduled: true,
  cancel_scheduled: true,
  spawn_subagent: true,
  propose_feature: true,
  search_past_sessions: true,
  search_knowledge: true,
  list_collections: true,
  read_clipboard: true,
  set_clipboard: true,
  open_application: true,
  list_windows: true,
  focus_window: true,
  take_screenshot: true,
};

export const useAgentStore = create<AgentState>()((set) => ({
  dirHandle: null,
  workspacePath: null,
  workspaceName: null,
  toolsEnabled: { ...DEFAULT_TOOLS_ENABLED },
  pendingToolCalls: [],

  setWorkspace: (handle, path, name) => {
    // Register the real OS path with the Rust confinement layer before the rest
    // of the app starts issuing fs_* / run_command calls against it.
    if (path) registerWorkspaceRoot(path);
    set({ dirHandle: handle, workspacePath: path, workspaceName: name });
  },

  setToolEnabled: (name, enabled) =>
    set((s) => ({ toolsEnabled: { ...s.toolsEnabled, [name]: enabled } })),

  setPendingToolCalls: (calls) => set({ pendingToolCalls: calls }),
  clearPendingToolCalls: () => set({ pendingToolCalls: [] }),
}));
