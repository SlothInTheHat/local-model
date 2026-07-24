import { isTauriEnv } from "./fileSystem";

/**
 * Frontend wrapper around the Rust shadow-git commands (src-tauri/src/git_shadow.rs)
 * — the app's automatic, model-invisible safety net for agent-made file changes,
 * completely independent of the workspace's own .git if it has one. See
 * git_shadow.rs's module doc comment for the isolation design.
 */

export interface ShadowCommitInfo {
  oid: string;
  message: string;
  timestamp: number; // unix seconds
  files_changed: string[];
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
 * Commits the current state of `workspacePath` after a mutating tool call.
 * Fire-and-forget from the caller's perspective — never throws into the
 * agent loop; failures are logged and swallowed. A no-op call (nothing
 * actually changed) produces no commit, silently.
 */
export async function commitAfterToolCall(
  workspacePath: string,
  toolName: string,
  paths: string[],
  surface: string,
): Promise<void> {
  if (!isTauriEnv()) return; // browser dev mode has no Rust backend — no-op
  try {
    await tauriInvoke("shadow_git_ensure_init", { workspaceRoot: workspacePath });
    const pathLabel =
      paths.length === 0 ? "" : paths.length <= 3 ? paths.join(", ") : `${paths.slice(0, 3).join(", ")} +${paths.length - 3} more`;
    await tauriInvoke("shadow_git_commit", {
      workspaceRoot: workspacePath,
      message: `[localmind:${surface}] ${toolName}${pathLabel ? ": " + pathLabel : ""}`,
    });
  } catch (e) {
    console.warn("[shadow-git] commit failed (non-fatal):", e);
  }
}

export async function listShadowHistory(workspacePath: string, path?: string, limit = 50): Promise<ShadowCommitInfo[]> {
  return tauriInvoke<ShadowCommitInfo[]>("shadow_git_log", { workspaceRoot: workspacePath, path, limit });
}

export async function showShadowFileAt(workspacePath: string, oid: string, path: string): Promise<string> {
  return tauriInvoke<string>("shadow_git_show_file", { workspaceRoot: workspacePath, commitOid: oid, path });
}

export async function diffShadowCommit(workspacePath: string, oid: string, path?: string): Promise<string> {
  return tauriInvoke<string>("shadow_git_diff", { workspaceRoot: workspacePath, commitOid: oid, path });
}

/**
 * Unified diff spanning a range of shadow commits — baseOid's tree (or the
 * empty tree if omitted) to headOid's tree (or current HEAD if omitted).
 * Unlike diffShadowCommit (always one commit vs its immediate parent), this
 * gives the *net* change across a whole run of commits as one diff — used by
 * spawn_reviewer_subagent (tools.ts) to hand a fresh critic subagent
 * everything a build task changed, not N separate per-commit fragments.
 */
export async function diffShadowRange(
  workspacePath: string,
  baseOid: string | undefined,
  headOid: string | undefined,
  path?: string,
): Promise<string> {
  return tauriInvoke<string>("shadow_git_diff_range", { workspaceRoot: workspacePath, baseOid, headOid, path });
}

export async function restoreShadowFile(workspacePath: string, oid: string, path: string): Promise<void> {
  await tauriInvoke("shadow_git_restore_file", { workspaceRoot: workspacePath, commitOid: oid, path });
}

/** Writes every file tracked at `oid` back to disk — a git-reset-hard analog scoped to the shadow repo's tree. Returns the paths restored. */
export async function restoreShadowWorkspace(workspacePath: string, oid: string): Promise<string[]> {
  return tauriInvoke<string[]>("shadow_git_restore_all", { workspaceRoot: workspacePath, commitOid: oid });
}
