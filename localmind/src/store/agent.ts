import { create } from "zustand";
import type { ToolCall, ToolName } from "../lib/tools";

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
};

export const useAgentStore = create<AgentState>()((set) => ({
  dirHandle: null,
  workspacePath: null,
  workspaceName: null,
  toolsEnabled: { ...DEFAULT_TOOLS_ENABLED },
  pendingToolCalls: [],

  setWorkspace: (handle, path, name) =>
    set({ dirHandle: handle, workspacePath: path, workspaceName: name }),

  setToolEnabled: (name, enabled) =>
    set((s) => ({ toolsEnabled: { ...s.toolsEnabled, [name]: enabled } })),

  setPendingToolCalls: (calls) => set({ pendingToolCalls: calls }),
  clearPendingToolCalls: () => set({ pendingToolCalls: [] }),
}));
