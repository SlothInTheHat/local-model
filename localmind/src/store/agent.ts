import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ToolCall, ToolName } from "../lib/tools";

/**
 * Register a workspace root with the Rust confinement layer so the native fs_*
 * commands and run_command are allowed to touch it. Fire-and-forget: failures
 * (browser mode, missing folder) just mean confinement stays as-is and the
 * fs_* commands will refuse access, which surfaces as a clear error to the user.
 */
function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as unknown as Record<string, unknown>).__TAURI__ as
    | { core?: { invoke?: (cmd: string, args?: unknown) => Promise<T> } }
    | undefined;
  const invoke = tauri?.core?.invoke;
  if (typeof invoke !== "function") return Promise.reject(new Error("Not in Tauri desktop mode"));
  return invoke(cmd, args);
}

function registerWorkspaceRoot(path: string): void {
  void invokeTauri("register_workspace_root", { path }).catch(() => {});
}

/** Well-known OS folder names offered in Settings > Privacy & Security. */
export const KNOWN_FOLDER_NAMES = ["Downloads", "Desktop", "Documents", "Pictures", "Home"] as const;
export type KnownFolderName = (typeof KNOWN_FOLDER_NAMES)[number];

interface AgentState {
  dirHandle: FileSystemDirectoryHandle | null;
  workspacePath: string | null;   // real OS path — only set in Tauri mode
  workspaceName: string | null;   // display name (folder name)
  toolsEnabled: Record<ToolName, boolean>;
  pendingToolCalls: ToolCall[];
  /** Well-known folders the user has opted into (name -> real OS path), letting
   *  file tools reach outside the single open workspace. Re-registered with the
   *  Rust confinement layer on every app start (see App.tsx) since REGISTERED_ROOTS
   *  is in-memory only and resets per-process. */
  extraRoots: Partial<Record<KnownFolderName, string>>;

  setWorkspace: (handle: FileSystemDirectoryHandle | null, path: string | null, name: string | null) => void;
  setToolEnabled: (name: ToolName, enabled: boolean) => void;
  setPendingToolCalls: (calls: ToolCall[]) => void;
  clearPendingToolCalls: () => void;
  enableKnownFolder: (name: KnownFolderName) => Promise<void>;
  disableKnownFolder: (name: KnownFolderName) => void;
}

const DEFAULT_TOOLS_ENABLED: Record<ToolName, boolean> = {
  read_file: true,
  write_file: true,
  patch_file: true,
  delete_file: true,
  move_file: true,
  copy_file: true,
  rename_file: true,
  list_directory: true,
  grep_files: true,
  find_files: true,
  get_known_folder: true,
  download_file: true,
  compress_files: true,
  extract_archive: true,
  convert_image: true,
  remove_background: true,
  pdf_merge: true,
  pdf_to_text: true,
  close_window: true,
  minimize_window: true,
  uia_list_elements: true,
  uia_click_element: true,
  uia_read_element_text: true,
  uia_set_element_text: true,
  list_processes: true,
  kill_process: true,
  get_disk_usage: true,
  empty_recycle_bin: true,
  adjust_volume: true,
  speak_text: true,
  print_file: true,
  remind_me: true,
  calculator: true,
  web_search: true,
  search_images: true,
  run_command: false,
  // Also gated separately by settings.codeModeEnabled + supportsCodeMode() —
  // see assembleSessionTools/agentRuntime.ts. Off here too so it never
  // appears in the plain tools-enabled list by default.
  run_tool_script: false,
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
  spawn_reviewer_subagent: true,
  propose_feature: true,
  search_past_sessions: true,
  find_recurring_issues: true,
  search_knowledge: true,
  list_collections: true,
  // Both default off and are never added to any essentialOnly allowlist
  // except the Resume tab's own — this keeps them structurally unreachable
  // from main chat / the generic tool-toggle settings UI.
  search_resume_knowledge: false,
  propose_resume_edit: false,
  read_clipboard: true,
  set_clipboard: true,
  open_application: true,
  list_windows: true,
  focus_window: true,
  take_screenshot: true,
  save_workflow: true,
  list_workflows: true,
  run_workflow: true,
  delete_workflow: true,
  notify_user: true,
  render_canvas: true,
  plot_graph: true,
  render_table: true,
  show_webpage: true,
};

export const useAgentStore = create<AgentState>()(
  persist(
    (set) => ({
      dirHandle: null,
      workspacePath: null,
      workspaceName: null,
      toolsEnabled: { ...DEFAULT_TOOLS_ENABLED },
      pendingToolCalls: [],
      extraRoots: {},

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

      enableKnownFolder: async (name) => {
        const path = await invokeTauri<string>("get_known_folder", { name });
        await invokeTauri("register_workspace_root", { path });
        set((s) => ({ extraRoots: { ...s.extraRoots, [name]: path } }));
      },

      disableKnownFolder: (name) => {
        const path = useAgentStore.getState().extraRoots[name];
        if (path) void invokeTauri("unregister_workspace_root", { path }).catch(() => {});
        set((s) => {
          const next = { ...s.extraRoots };
          delete next[name];
          return { extraRoots: next };
        });
      },
    }),
    {
      name: "localmind-agent-tools",
      // toolsEnabled and extraRoots survive a restart; dirHandle isn't
      // serializable (and wouldn't be valid after a relaunch anyway; the
      // workspace gets re-opened by App.tsx's own restore-by-path flow
      // instead — extraRoots gets the analogous re-registration, see
      // App.tsx), and pendingToolCalls is live in-flight approval state,
      // not a preference.
      partialize: (state) => ({ toolsEnabled: state.toolsEnabled, extraRoots: state.extraRoots }),
      // New tools added after a user's last save shouldn't vanish from the
      // record just because they're absent from what was persisted.
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<AgentState>),
        toolsEnabled: { ...current.toolsEnabled, ...(persisted as Partial<AgentState>)?.toolsEnabled },
        extraRoots: { ...current.extraRoots, ...(persisted as Partial<AgentState>)?.extraRoots },
      }),
    }
  )
);
